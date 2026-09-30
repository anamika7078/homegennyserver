import type { Response } from 'express';
import type { Readable } from 'stream';

/** Streams a stored private file (ID documents etc.) — never cached by the browser or a proxy. */
export function sendStoredFile(
  res: Response,
  stream: Readable,
  mimeType: string,
  disposition: 'inline' | 'attachment',
  name?: string,
): void {
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', name ? `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}` : disposition);
  stream.on('error', () => {
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  });
  stream.pipe(res);
}
