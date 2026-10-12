import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FileStorageService } from '../../common/storage/file-storage.service';
import { AuthUser } from '../../common/guards/branch-scope.util';
import { CareAccessService } from './care-access.service';

const KINDS: Record<string, { mimes: Record<string, string>; maxBytes: number; roles: string[] }> = {
  PHOTO: {
    mimes: { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' },
    maxBytes: 5 * 1024 * 1024,
    roles: ['CLIENT', 'STAFF'],
  },
  PRESCRIPTION: {
    mimes: { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' },
    maxBytes: 10 * 1024 * 1024,
    roles: ['CLIENT'],
  },
  VOICE: {
    mimes: {
      'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac',
      'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
    },
    maxBytes: 5 * 1024 * 1024,
    roles: ['CLIENT', 'STAFF'],
  },
};

/**
 * Photos (meals, tasks, daily report), prescriptions and voice notes. Uploaded
 * first, then referenced by id from whatever they belong to; every reference is
 * checked to be a file of the same placement. Served only through
 * GET /care-files/:id, after the same access check as the placement itself.
 */
@Injectable()
export class CareFilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorageService,
    private readonly access: CareAccessService,
  ) {}

  async upload(user: AuthUser, placementId: string, kind: string, file: Express.Multer.File | undefined) {
    const k = String(kind ?? '').toUpperCase();
    const rule = KINDS[k];
    if (!rule) throw new BadRequestException(`kind must be one of ${Object.keys(KINDS).join(', ')}.`);
    if (!file) throw new BadRequestException('Attach the file as "file".');
    const ctx = await this.access.resolve(user, placementId, { write: true });
    if (!rule.roles.includes(ctx.role)) throw new BadRequestException(`A ${ctx.role.toLowerCase()} cannot upload a ${k.toLowerCase()}.`);
    const ext = rule.mimes[file.mimetype];
    if (!ext) throw new BadRequestException(`"${file.originalname}" is not an allowed ${k.toLowerCase()} type (${Object.keys(rule.mimes).join(', ')}).`);
    if (file.size > rule.maxBytes) throw new BadRequestException(`"${file.originalname}" is over ${rule.maxBytes / 1024 / 1024} MB.`);

    const key = `care/${placementId}/${k.toLowerCase()}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    await this.storage.save(key, file.buffer, file.mimetype);
    const row = await this.prisma.careFile.create({
      data: {
        placementId,
        kind: k,
        storageKey: key,
        mimeType: file.mimetype,
        size: file.size,
        originalName: file.originalname?.slice(0, 255),
        uploadedBy: user.id,
        uploadedRole: ctx.role,
      },
    });
    return this.toDto(row);
  }

  async read(user: AuthUser, id: string) {
    const row = await this.prisma.careFile.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('File not found.');
    await this.access.resolve(user, row.placementId);
    return { row, stream: await this.storage.read(row.storageKey) };
  }

  /** Every id must be an uploaded file of this placement (of the right kind, when given). */
  async assertOwned(placementId: string, ids: unknown, kind?: string): Promise<string[]> {
    const list = (Array.isArray(ids) ? ids : ids ? [ids] : []).map(String).filter(Boolean);
    if (!list.length) return [];
    const rows = await this.prisma.careFile.findMany({ where: { id: { in: list }, placementId }, select: { id: true, kind: true } });
    const ok = new Set(rows.filter((r) => !kind || r.kind === kind).map((r) => r.id));
    const bad = list.filter((x) => !ok.has(x));
    if (bad.length) throw new BadRequestException(`Unknown file id(s) for this placement${kind ? ` (${kind})` : ''}: ${bad.join(', ')}`);
    return [...new Set(list)];
  }

  toDto(row: { id: string; kind: string; mimeType: string; size: number; originalName: string | null; createdAt: Date }) {
    return {
      id: row.id,
      kind: row.kind,
      mime_type: row.mimeType,
      size: row.size,
      name: row.originalName,
      url: `/api/v1/care-files/${row.id}`,
      created_at: row.createdAt,
    };
  }
}
