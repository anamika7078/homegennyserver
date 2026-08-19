import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * TEMPORARY jugaad: stand-in for GCS while no real bucket/service-account is
 * provisioned. Stores video-cert uploads on this server's own disk under
 * <repo>/local-uploads/video-certs/ instead. Same key format as the real GCS
 * path (`video-certs/<series>/<staffId>/<timestamp>_<filename>`), so nothing
 * downstream (VideoCertification.videoUrl, review, etc.) needs to know which
 * backend actually stored the bytes.
 *
 * ⚠️ Render's filesystem is ephemeral — anything written here is LOST on
 * every deploy/restart. Fine for demoing the flow now; once a real GCS
 * bucket exists, flip VIDEO_STORAGE_MODE back to 'gcs' (or unset it) and
 * this whole file stops being used.
 */

const STORAGE_ROOT = path.join(process.cwd(), 'local-uploads', 'video-certs');

export interface LocalVideoMeta {
  sha256Hash: string;
  sizeBytes: number;
  staffId?: string;
  series?: string;
  uploadedAt: string;
}

/** Keys are server-generated (see generateUploadUrl) but echoed back by the
 * client on actual upload — never trust it blindly as a filesystem path. */
function assertSafeKey(key: string): void {
  if (!key.startsWith('video-certs/') || key.includes('..') || path.isAbsolute(key)) {
    throw new Error(`Invalid storage key: ${key}`);
  }
}

function filePath(key: string): string {
  assertSafeKey(key);
  return path.join(STORAGE_ROOT, key.slice('video-certs/'.length));
}

function metaPath(key: string): string {
  return filePath(key) + '.meta.json';
}

export const LocalVideoStorage = {
  save(key: string, buffer: Buffer, extra?: { staffId?: string; series?: string }): LocalVideoMeta {
    const full = filePath(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buffer);
    const meta: LocalVideoMeta = {
      sha256Hash: crypto.createHash('sha256').update(buffer).digest('hex'),
      sizeBytes: buffer.length,
      staffId: extra?.staffId,
      series: extra?.series,
      uploadedAt: new Date().toISOString(),
    };
    fs.writeFileSync(metaPath(key), JSON.stringify(meta, null, 2));
    return meta;
  },

  getMeta(key: string): LocalVideoMeta | null {
    try {
      return JSON.parse(fs.readFileSync(metaPath(key), 'utf8')) as LocalVideoMeta;
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
};
