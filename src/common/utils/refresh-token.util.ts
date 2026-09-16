import { createHash, timingSafeEqual } from 'crypto';

/**
 * Refresh tokens are stored as a SHA-256 digest, not a bcrypt hash.
 *
 * bcrypt was the wrong tool here twice over:
 *
 *  1. Correctness. bcrypt silently truncates its input at 72 bytes. The first
 *     72 bytes of a refresh token we issue are the JWT header plus the start of
 *     `{"sub":"<user id>"...` — all of it derivable from the user id alone,
 *     which is not a secret (it comes back in login responses and in plenty of
 *     API payloads). So ANY string that started with those 72 bytes compared
 *     equal to the stored hash, and `/auth/refresh` handed out a working access
 *     token for that account. Verified against the real token format before
 *     this change.
 *  2. Cost. A refresh token is already 200+ bits of unguessable, signed,
 *     server-generated material — it needs no key stretching. Paying a cost-10
 *     bcrypt on every login and every refresh was seconds of CPU on the dev VPS
 *     for no security gain.
 *
 * SHA-256 over the whole token fixes both: the full token is covered, and the
 * digest is compared in constant time.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented token against a stored digest. */
export function refreshTokenMatches(token: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) return false;
  const presented = Buffer.from(hashRefreshToken(token), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  // Lengths differ when the row still holds a pre-migration bcrypt hash; those
  // sessions simply have to log in again.
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}
