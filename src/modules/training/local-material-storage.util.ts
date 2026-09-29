import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Same jugaad as video-cert's local-video-storage.util.ts, for study material
 * video uploads instead of certification videos — separate directory
 * (`local-uploads/training-materials/`) and key prefix so the two never
 * collide, but otherwise an identical pattern: local disk stands in for GCS
 * until VIDEO_STORAGE_MODE is unset (or set to 'gcs').
 *
 * ⚠️ Same warning applies: on a host with an ephemeral filesystem, anything
 * written here is lost on redeploy/restart.
 */

const STORAGE_ROOT = path.join(process.cwd(), 'local-uploads', 'training-materials');

export interface LocalMaterialMeta {
  sha256Hash: string;
  sizeBytes: number;
  batchId?: string;
  uploadedAt: string;
}

function assertSafeKey(key: string): void {
  if (!key.startsWith('training-materials/') || key.includes('..') || path.isAbsolute(key)) {
    throw new Error(`Invalid storage key: ${key}`);
  }
}

function filePath(key: string): string {
  assertSafeKey(key);
  return path.join(STORAGE_ROOT, key.slice('training-materials/'.length));
}

function metaPath(key: string): string {
  return filePath(key) + '.meta.json';
}

export const LocalMaterialStorage = {
  save(key: string, buffer: Buffer, extra?: { batchId?: string }): LocalMaterialMeta {
    const full = filePath(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buffer);
    const meta: LocalMaterialMeta = {
      sha256Hash: crypto.createHash('sha256').update(buffer).digest('hex'),
      sizeBytes: buffer.length,
      batchId: extra?.batchId,
      uploadedAt: new Date().toISOString(),
    };
    fs.writeFileSync(metaPath(key), JSON.stringify(meta, null, 2));
    return meta;
  },

  getMeta(key: string): LocalMaterialMeta | null {
    try {
      return JSON.parse(fs.readFileSync(metaPath(key), 'utf8')) as LocalMaterialMeta;
    } catch {
      return null;
    }
  },

  exists(key: string): boolean {
    try {
      return fs.existsSync(filePath(key));
    } catch {
      return false;
    }
  },

  readStream(key: string): fs.ReadStream {
    return fs.createReadStream(filePath(key));
  },

  delete(key: string): void {
    try {
      fs.unlinkSync(filePath(key));
      fs.unlinkSync(metaPath(key));
    } catch {
      // already gone — deleting a material row whose file was never
      // finalized (upload URL issued but never used) shouldn't 500.
    }
  },
};
