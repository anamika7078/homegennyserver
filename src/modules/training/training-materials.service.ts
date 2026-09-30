import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage, Bucket } from '@google-cloud/storage';
import * as fs from 'fs';
import { PrismaService } from '../../prisma/prisma.service';
import { FileStorageService } from '../../common/storage/file-storage.service';
import { LocalMaterialStorage } from './local-material-storage.util';

const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10 MB

export type MaterialType = 'VIDEO' | 'PDF' | 'NOTE';

/**
 * Study material a trainer attaches to a batch — video (uploaded, not just
 * linked, per the business call on this), PDF, or a plain-text note. Video
 * reuses the exact storage pattern video-cert already has working (GCS
 * signed-POST, or local disk while VIDEO_STORAGE_MODE=local) rather than
 * building a second video pipeline; PDFs are small enough to just take
 * directly, the same way documents.service.ts handles KYC document uploads.
 */
@Injectable()
export class TrainingMaterialsService {
  private readonly logger = new Logger(TrainingMaterialsService.name);
  private readonly storage: Storage | null = null;
  private readonly bucket: Bucket | null = null;
  private readonly localMode: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly files: FileStorageService,
  ) {
    this.localMode = config.get<string>('app.gcs.videoStorageMode') === 'local';
    if (this.localMode) return;
    const projectId = config.get<string>('app.gcp.projectId');
    const keyFile = config.get<string>('app.gcp.keyFile');
    this.storage = new Storage({
      ...(projectId ? { projectId } : {}),
      ...(keyFile ? { keyFilename: keyFile } : {}),
    });
    // Same bucket video-cert uses — a different key prefix
    // (training-materials/ vs video-certs/) keeps the two apart inside it,
    // rather than provisioning a second bucket for this.
    const bucketName = config.getOrThrow<string>('app.gcs.bucketVideoCerts');
    this.bucket = this.storage.bucket(bucketName);
  }

  private async assertBatchExists(batchId: string): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM training_batches WHERE id = $1::uuid`, batchId,
    ).catch(() => []);
    if (!rows.length) throw new NotFoundException(`Batch ${batchId} not found`);
  }

  // ── Video: same two-step flow as video-cert (upload-url, then either a
  // direct GCS POST or, in local mode, local-upload) ─────────────────────────

  async generateVideoUploadUrl(
    batchId: string,
    filename: string,
  ): Promise<{ uploadUrl: string; key: string; fields: Record<string, string> }> {
    await this.assertBatchExists(batchId);
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `training-materials/${batchId}/${Date.now()}_${safeFilename}`;

    if (this.localMode) {
      return { uploadUrl: '/api/v1/training/materials/local-upload', key, fields: { key } };
    }

    const file = this.bucket!.file(key);
    const fields: Record<string, string> = {
      'Content-Type': 'video/mp4',
      'x-goog-meta-batchid': batchId,
      'x-goog-meta-uploadedat': new Date().toISOString(),
    };
    const [policy] = await file.generateSignedPostPolicyV4({
      expires: Date.now() + 60 * 60 * 1000,
      conditions: [
        ['content-length-range', 0, 500 * 1024 * 1024],
        ['eq', '$Content-Type', 'video/mp4'],
      ],
      fields,
    });
    return { uploadUrl: policy.url, key, fields: policy.fields as Record<string, string> };
  }

  saveLocalVideoUpload(key: string, buffer: Buffer, batchId?: string) {
    if (!this.localMode) {
      throw new BadRequestException('Local upload is disabled — VIDEO_STORAGE_MODE is not "local"');
    }
    const meta = LocalMaterialStorage.save(key, buffer, { batchId });
    return { key, sha256Hash: meta.sha256Hash, sizeBytes: meta.sizeBytes };
  }

  async generateVideoViewUrl(key: string): Promise<string> {
    if (this.localMode) {
      return `/api/v1/training/materials/local-file?key=${encodeURIComponent(key)}`;
    }
    const [url] = await this.bucket!.file(key).getSignedUrl({
      version: 'v4', action: 'read', expires: Date.now() + 60 * 60 * 1000,
    });
    return url;
  }

  readLocalVideoFile(key: string): fs.ReadStream {
    if (!LocalMaterialStorage.exists(key)) throw new NotFoundException('File not found');
    return LocalMaterialStorage.readStream(key);
  }

  // ── PDF: direct multipart upload, same idea as documents.service.ts ────────

  async savePdf(batchId: string, file: { buffer: Buffer; originalname: string; size: number }): Promise<{ key: string }> {
    if (file.size > MAX_PDF_SIZE) {
      throw new BadRequestException(`PDF exceeds the ${MAX_PDF_SIZE / 1024 / 1024} MB limit`);
    }
    const filename = `${batchId}_${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const key = `training-materials-pdf/${batchId}/${filename}`;
    await this.files.save(key, file.buffer, 'application/pdf');
    return { key };
  }

  readPdf(key: string) {
    if (!key.startsWith('training-materials-pdf/')) throw new NotFoundException('File not found');
    return this.files.read(key);
  }

  // ── The training_materials row itself ───────────────────────────────────

  async create(params: {
    batchId: string;
    type: MaterialType;
    title: string;
    storageKey?: string;
    body?: string;
    sizeBytes?: number;
    uploadedBy?: string;
  }) {
    await this.assertBatchExists(params.batchId);
    if (params.type === 'NOTE' && !params.body?.trim()) {
      throw new BadRequestException('body is required for a NOTE');
    }
    if ((params.type === 'VIDEO' || params.type === 'PDF') && !params.storageKey) {
      throw new BadRequestException(`storage_key is required for a ${params.type}`);
    }
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `INSERT INTO training_materials (batch_id, type, title, storage_key, body, size_bytes, uploaded_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid)
       RETURNING id, batch_id, type, title, storage_key, body, size_bytes, uploaded_by, created_at`,
      params.batchId, params.type, params.title,
      params.storageKey ?? null, params.body ?? null, params.sizeBytes ?? null, params.uploadedBy ?? null,
    );
    return this.mapRow(rows[0]);
  }

  async list(batchId: string) {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, batch_id, type, title, storage_key, body, size_bytes, uploaded_by, created_at
       FROM training_materials WHERE batch_id = $1::uuid ORDER BY created_at ASC`,
      batchId,
    );
    return Promise.all(rows.map(async (r) => ({ ...this.mapRow(r), viewUrl: await this.viewUrlFor(r) })));
  }

  /** Relative /api/v1/... URLs need the caller's Bearer token; a GCS signed URL doesn't. */
  private async viewUrlFor(r: { type: string; storage_key: string | null }): Promise<string | null> {
    if (!r.storage_key) return null;
    if (r.type === 'VIDEO') return this.generateVideoViewUrl(r.storage_key);
    if (r.type === 'PDF') return `/api/v1/training/materials/pdf-file?key=${encodeURIComponent(r.storage_key)}`;
    return null;
  }

  async isStaffEnrolled(staffId: string, batchId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT 1 FROM batch_enrollments WHERE staff_id = $1::uuid AND batch_id = $2::uuid LIMIT 1`,
      staffId, batchId,
    );
    return rows.length > 0;
  }

  /** Throws unless this staff member is enrolled in the batch the stored file belongs to. */
  async assertStaffCanReadFile(staffId: string, storageKey: string): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT batch_id FROM training_materials WHERE storage_key = $1 LIMIT 1`, storageKey,
    );
    if (!rows.length || !(await this.isStaffEnrolled(staffId, rows[0].batch_id))) {
      throw new ForbiddenException('Not enrolled in the batch this material belongs to');
    }
  }

  async delete(id: string): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT type, storage_key FROM training_materials WHERE id = $1::uuid`, id,
    );
    if (!rows.length) throw new NotFoundException('Material not found');
    const { type, storage_key } = rows[0];
    await this.prisma.$executeRawUnsafe(`DELETE FROM training_materials WHERE id = $1::uuid`, id);
    if (storage_key) {
      if (type === 'VIDEO' && this.localMode) LocalMaterialStorage.delete(storage_key);
      if (type === 'VIDEO' && !this.localMode) {
        await this.bucket!.file(storage_key).delete({ ignoreNotFound: true }).catch((e) =>
          this.logger.warn(`Could not delete ${storage_key} from the bucket: ${e?.message}`),
        );
      }
      if (type === 'PDF') {
        await this.files.delete(storage_key);
      }
    }
  }

  private mapRow(r: any) {
    return {
      id: r.id,
      batchId: r.batch_id,
      type: r.type as MaterialType,
      title: r.title,
      storageKey: r.storage_key,
      body: r.body,
      sizeBytes: r.size_bytes != null ? Number(r.size_bytes) : null,
      uploadedBy: r.uploaded_by,
      createdAt: r.created_at,
    };
  }
}
