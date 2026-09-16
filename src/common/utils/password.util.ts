import { BadRequestException } from '@nestjs/common';

export const STRONG_PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#\-_])[A-Za-z\d@$!%*?&#\-_]{8,72}$/;

export function assertStrongPassword(password: string): void {
  if (!STRONG_PASSWORD_REGEX.test(password)) {
    throw new BadRequestException(
      'Password must be 8-72 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special symbol (@, $, !, %, *, ?, &, #, -, _)',
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Password hashing
//
// `@node-rs/bcrypt` (Rust) rather than `bcryptjs` (pure JS). Same bcrypt, same
// `$2a`/`$2b` hashes — every password already in the database keeps working,
// and a hash written here still verifies under bcryptjs if this ever has to be
// rolled back.
//
// The reason for the swap is where the work happens. bcryptjs runs its async
// mode on the main thread, yielding between rounds, so it competes with every
// other request; on the dev VPS one cost-12 compare was taking ~6 SECONDS of
// the login request. The Rust binding hands the work to libuv's threadpool
// instead: measured locally, 5 concurrent compares went 1854ms → 513ms, and
// the event loop stays free the whole time.
//
// Prebuilt binaries cover linux-x64-musl (the Alpine image), so this needs no
// node-gyp/build toolchain in Docker.
// ────────────────────────────────────────────────────────────────────────────

import { hash as bcryptHash, verify as bcryptVerify } from '@node-rs/bcrypt';

/** Cost factor for every password hash we write. */
export const PASSWORD_BCRYPT_COST = 12;

export function hashPassword(plain: string, cost = PASSWORD_BCRYPT_COST): Promise<string> {
  return bcryptHash(plain, cost);
}

/**
 * Never throws: a malformed or empty stored hash is a failed login, not a 500.
 * (bcryptjs threw on a non-bcrypt string, which callers had to wrap in
 * try/catch to avoid turning a bad row into a server error.)
 */
export async function verifyPassword(plain: string, storedHash: string | null | undefined): Promise<boolean> {
  if (!storedHash || !storedHash.startsWith('$2')) return false;
  try {
    return await bcryptVerify(plain, storedHash);
  } catch {
    return false;
  }
}
