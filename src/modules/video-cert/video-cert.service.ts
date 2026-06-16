import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage, Bucket, FileMetadata } from '@google-cloud/storage';
import { PrismaService } from '../../prisma/prisma.service';

export const VIDEO_PROMPTS: Record<string, { count: number; minDuration: number; prompts: string[] }> = {
  MAID: {
    count: 9, minDuration: 270, prompts: [
      'State your full name, age, and hometown',
      'Describe your cleaning and housekeeping experience',
      'How do you handle fragile or expensive items in a home?',
      'What is your approach to childcare if required?',
      'How do you manage your time when multiple tasks are assigned?',
      'Describe a difficult situation with a previous employer and how you resolved it',
      'What are your cooking skills and dietary restrictions you can accommodate?',
      'How would you handle a medical emergency while on duty?',
      'Confirm you understand HomeGenny terms — this video is permanent certification evidence',
    ]
  },
  SC: {
    count: 10, minDuration: 300, prompts: [
      'State your full name, age, hometown, and certifications',
      'Describe your experience caring for elderly or sick individuals',
      'What medications have you administered and under what protocols?',
      'How do you handle a patient who becomes aggressive or non-compliant?',
      'Describe your knowledge of fall prevention and mobility assistance',
      'What are the signs of a stroke or cardiac event you would watch for?',
      'How do you maintain patient dignity and privacy?',
      'Describe your shift handover procedure',
      'How do you document care activities and report to family members?',
      'Confirm you understand HomeGenny terms — this certification video is permanent legal evidence',
    ]
  },
  UC: {
    count: 10, minDuration: 300, prompts: [
      'State your full name, age, and hometown',
      'Describe your previous caregiving or domestic work experience',
      'How do you assist with bathing and personal hygiene for elderly clients?',
      'What do you do if a client falls while under your supervision?',
      'Describe your approach to meal preparation for elderly individuals',
      'How do you handle emotional situations — a client who is grieving or confused?',
      'Describe your knowledge of dementia or memory care basics',
      'What would you do if a client asks you to keep a secret from their family?',
      'How do you escalate issues to your reporting manager?',
      'Confirm you understand HomeGenny terms — this certification video is permanent legal evidence',
    ]
  },
  DR: {
    count: 12, minDuration: 360, prompts: [
      'State your full name, age, hometown, and driving licence number',
      'Describe your driving experience — vehicle types and years',
      'What is your approach to safe driving in heavy traffic or adverse conditions?',
      'How do you handle a medical emergency while driving a client?',
      'What is your protocol if the vehicle breaks down mid-journey?',
      'Describe your knowledge of route planning and GPS navigation',
      'How do you maintain the vehicle — daily checks you perform?',
      'What is your conduct protocol when transporting female clients or children?',
      'How do you handle a client who insists on an unsafe driving practice?',
      'Describe a difficult traffic situation you have faced and how you resolved it',
      'What is your protocol for accident or collision — immediate steps?',
      'Confirm you understand HomeGenny terms — this certification video is permanent legal evidence',
    ]
  },
};

@Injectable()
export class VideoCertService {
  private readonly logger = new Logger(VideoCertService.name);
  private readonly storage: Storage;
  private readonly bucket: Bucket;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    // On GCE: Application Default Credentials (ADC) — no key file needed
    // Local dev: set GOOGLE_APPLICATION_CREDENTIALS env var
    const projectId = config.get<string>('app.gcp.projectId');
    const keyFile = config.get<string>('app.gcp.keyFile');   // undefined in prod — ADC used

    this.storage = new Storage({
      ...(projectId ? { projectId } : {}),
      ...(keyFile ? { keyFilename: keyFile } : {}),
    });

    const bucketName = config.getOrThrow<string>('app.gcs.bucketVideoCerts');
    this.bucket = this.storage.bucket(bucketName);
  }

  getPrompts(series: string): (typeof VIDEO_PROMPTS)[string] {
    const key = series.toUpperCase();
    const prompts = VIDEO_PROMPTS[key];
    if (!prompts) throw new BadRequestException(`Unknown series: ${series}. Valid: MAID, SC, UC, DR`);
    return prompts;
  }

  /**
   * Generates a signed GCS upload URL (1 hour).
   * sha256Hash is optional at URL generation — the Flutter app sends it in metadata.
   * It is required at review time (verifyVideoHash).
   */
  async generateUploadUrl(
    staffId: string,
    series: string,
    filename: string,
    sha256Hash?: string,
  ): Promise<{ uploadUrl: string; gcsKey: string; fields: Record<string, string> }> {
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const gcsKey = `video-certs/${series.toLowerCase()}/${staffId}/${Date.now()}_${safeFilename}`;
    const file = this.bucket.file(gcsKey);

    const fields: Record<string, string> = {
      'Content-Type': 'video/mp4',
      'x-goog-meta-staffid': staffId,
      'x-goog-meta-series': series,
      'x-goog-meta-uploadedat': new Date().toISOString(),
    };
    if (sha256Hash) {
      fields['x-goog-meta-sha256hash'] = sha256Hash;
    }

    const [policy] = await file.generateSignedPostPolicyV4({
      expires: Date.now() + 60 * 60 * 1000,   // 1 hour
      conditions: [
        ['content-length-range', 0, 500 * 1024 * 1024],   // max 500 MB
        ['eq', '$Content-Type', 'video/mp4'],
      ],
      fields,
    });

    this.logger.log(`[VIDEO-CERT] Upload URL generated — staff ${staffId}, key ${gcsKey}`);
    return { uploadUrl: policy.url, gcsKey, fields: policy.fields as Record<string, string> };
  }

  /**
   * Verifies the SHA-256 hash stored in GCS object metadata.
   * Call after the Flutter app confirms the upload is complete.
   */
  async verifyVideoHash(gcsKey: string, expectedHash: string): Promise<boolean> {
    try {
      const [meta] = await this.bucket.file(gcsKey).getMetadata();
      const storedHash = (meta as FileMetadata & { metadata?: Record<string, string> })
        .metadata?.['sha256hash'];
      const match = storedHash === expectedHash;
      this.logger.log(`[VIDEO-CERT] Hash check ${gcsKey}: ${match ? 'PASS' : 'FAIL'}`);
      return match;
    } catch (err: unknown) {
      this.logger.error(`[VIDEO-CERT] Hash verify error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Generates a 15-minute signed playback URL */
  async generateViewUrl(gcsKey: string): Promise<string> {
    const [url] = await this.bucket.file(gcsKey).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000,
    });
    return url;
  }

  async objectExists(gcsKey: string): Promise<boolean> {
    const [exists] = await this.bucket.file(gcsKey).exists();
    return exists;
  }

  async getObjectMetadata(gcsKey: string): Promise<Record<string, unknown>> {
    const [meta] = await this.bucket.file(gcsKey).getMetadata();
    const m = meta as FileMetadata & {
      metadata?: Record<string, string>;
      retentionExpirationTime?: string;
    };
    return {
      size: m.size,
      contentType: m.contentType,
      created: m.timeCreated,
      sha256Hash: m.metadata?.['sha256hash'],
      staffId: m.metadata?.['staffid'],
      series: m.metadata?.['series'],
      retentionExpiryTime: m.retentionExpirationTime,
    };
  }

  computeRetentionDate(exitDate: Date, neverDelete: boolean): Date | null {
    if (neverDelete) return null;
    const d = new Date(exitDate);
    d.setFullYear(d.getFullYear() + 7);
    return d;
  }

  /**
   * Pillar 5: Finalizes a video upload – verifies the SHA-256 hash stored in GCS metadata
   * and persists the certification record. Returns the DB entity.
   */
  async finalizeUpload(params: {
    staffId: string;
    promptKey: string;
    gcsKey: string;
    expectedHash: string;
    attemptNumber?: number;
  }) {
    const { staffId, promptKey, gcsKey, expectedHash, attemptNumber = 1 } = params;
    const valid = await this.verifyVideoHash(gcsKey, expectedHash);
    if (!valid) {
      throw new BadRequestException('SHA-256 hash verification failed');
    }
    // Persist record using the same schema as registerUpload
    return this.prisma.videoCertification.create({
      data: {
        staffId,
        promptKey,
        videoUrl: gcsKey,
        sha256Hash: expectedHash,
        attemptNumber,
        reviewStatus: 'PENDING',
        neverDelete: true,
      },
    });
  }

  /**
   * Pillar 5: Registers a VideoCertification DB record after the Flutter app
   * confirms upload completion. Stores the SHA-256 hash and prompt metadata.
   */
  async registerUpload(params: {
    staffId: string;
    promptKey: string;
    gcsKey: string;
    sha256Hash: string;
    attemptNumber?: number;
  }) {
    const { staffId, promptKey, gcsKey, sha256Hash, attemptNumber = 1 } = params;
    const cert = await this.prisma.videoCertification.create({
      data: {
        staffId,
        promptKey,
        videoUrl: gcsKey,
        sha256Hash,
        attemptNumber,
        reviewStatus: 'PENDING',
        neverDelete: true,   // default: every cert is permanent evidence per Pillar 5
      },
    });
    this.logger.log(`[VIDEO-CERT] Registered DB record ${cert.id} — staff ${staffId}, prompt ${promptKey}`);
    return cert;
  }

  /**
   * Pillar 5: Admin-only override to enforce or release the never_delete flag.
   * Used in fraud investigation scenarios where evidence must never be purged.
   */
  async setNeverDeleteFlag(certId: string, neverDelete: boolean) {
    const cert = await this.prisma.videoCertification.findUnique({ where: { id: certId } });
    if (!cert) throw new NotFoundException(`Video certification ${certId} not found`);
    const updated = await this.prisma.videoCertification.update({
      where: { id: certId },
      data: { neverDelete },
    });
    this.logger.log(`[VIDEO-CERT] neverDelete set to ${neverDelete} on cert ${certId}`);
    return updated;
  }

  /**
   * Pillar 5: List all video cert records for a staff member, ordered by creation.
   */
  async listForStaff(staffId: string) {
    return this.prisma.videoCertification.findMany({
      where: { staffId },
      orderBy: { createdAt: 'desc' },
    });
  }
}

