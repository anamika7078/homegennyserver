import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage, Bucket } from '@google-cloud/storage';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';

const LOCAL_ROOT = path.join(process.cwd(), 'local-uploads');

/**
 * Private file storage for uploads the backend itself receives (HR ID
 * documents, training PDFs). The bucket on the server, the local disk when
 * VIDEO_STORAGE_MODE=local (laptops). Files are only ever handed out by
 * streaming them through an authorised endpoint — no public or signed links.
 */
@Injectable()
export class FileStorageService {
  private readonly logger = new Logger(FileStorageService.name);
  private readonly bucket: Bucket | null = null;

  constructor(config: ConfigService) {
    if (config.get<string>('app.gcs.videoStorageMode') === 'local') return;
    const projectId = config.get<string>('app.gcp.projectId');
    const keyFile = config.get<string>('app.gcp.keyFile');
    const storage = new Storage({
      ...(projectId ? { projectId } : {}),
      ...(keyFile ? { keyFilename: keyFile } : {}),
    });
    this.bucket = storage.bucket(config.getOrThrow<string>('app.gcs.bucketVideoCerts'));
  }

  async save(key: string, data: Buffer, contentType: string): Promise<void> {
    this.assertKey(key);
    if (this.bucket) {
      await this.bucket.file(key).save(data, { contentType, resumable: false });
      return;
    }
    const full = path.join(LOCAL_ROOT, key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }

  async read(key: string): Promise<Readable> {
    this.assertKey(key);
    if (this.bucket) {
      const file = this.bucket.file(key);
      const [exists] = await file.exists();
      if (!exists) throw new NotFoundException('File not found');
      return file.createReadStream();
    }
    const full = path.join(LOCAL_ROOT, key);
    if (!fs.existsSync(full)) throw new NotFoundException('File not found');
    return fs.createReadStream(full);
  }

  /** Never throws — a missing file is already the desired end state. */
  async delete(key: string): Promise<void> {
    try {
      this.assertKey(key);
      if (this.bucket) await this.bucket.file(key).delete({ ignoreNotFound: true });
      else fs.rmSync(path.join(LOCAL_ROOT, key), { force: true });
    } catch (e: any) {
      this.logger.warn(`Could not delete ${key}: ${e?.message}`);
    }
  }

  private assertKey(key: string) {
    if (!key || key.startsWith('/') || key.split('/').includes('..')) {
      throw new BadRequestException('Invalid storage key');
    }
  }
}
