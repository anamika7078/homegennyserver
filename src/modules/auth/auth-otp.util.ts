import { createHmac, randomBytes, randomInt } from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const OTP_TTL_MS = 10 * 60 * 1000;

// ── Base32 helpers (RFC 4648) ────────────────────────────────────────────────
// Authenticator apps (Google Authenticator, Authy, etc.) require base32-encoded
// secrets in the otpauth:// URI. RFC 6238 TOTP internally uses raw bytes derived
// from the base32 secret.

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  while (output.length % 8 !== 0) output += '=';
  return output;
}

function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue; // skip invalid chars gracefully
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

// ── TOTP (RFC 6238 / HOTP RFC 4226) ─────────────────────────────────────────

function totpCodeAtWindow(secret: string, windowOffset = 0): string {
  const epoch = Math.floor(Date.now() / 1000 / 30) + windowOffset;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(epoch));
  const key = base32Decode(secret);
  const hmac = createHmac('sha1', key);
  hmac.update(buf);
  const digest = hmac.digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    ((digest[offset]!     & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8)  |
     (digest[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * Generate a new base32-encoded TOTP secret (20 random bytes → base32).
 * Compatible with Google Authenticator, Authy, and any RFC 4648 app.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * Build the otpauth:// URI for QR code display.
 * The secret in the URI must be base32-encoded — this function ensures that.
 */
export function buildOtpauthUrl(secret: string, phone: string): string {
  const label   = encodeURIComponent(`HomeGenny:${phone}`);
  const issuer  = encodeURIComponent('HomeGenny');
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Get the current TOTP code for a secret (useful for dev/testing only).
 */
export function totpCode(secret: string): string {
  return totpCodeAtWindow(secret, 0);
}

/**
 * Verify a 6-digit TOTP code. Allows ±1 time window (30-second drift tolerance).
 */
export function verifyTotp(secret: string, token: string): boolean {
  try {
    for (let w = -1; w <= 1; w++) {
      if (totpCodeAtWindow(secret, w) === token) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── OTP for password reset ───────────────────────────────────────────────────

export function generateOtp(): string {
  return randomInt(100000, 999999).toString();
}

export function otpExpiresAt(): Date {
  return new Date(Date.now() + OTP_TTL_MS);
}

export function isOtpExpired(expiresAt?: string | null): boolean {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() < Date.now();
}
