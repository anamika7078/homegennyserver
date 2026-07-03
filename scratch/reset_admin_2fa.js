/**
 * Reset portal Admin TOTP — generates a fresh secret and disables 2FA until re-confirmed.
 * Usage: node scratch/reset_admin_2fa.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { randomBytes } = require('crypto');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function generateTotpSecret() {
  const buf = randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += '=';
  return out;
}

const PORTAL_ADMIN_PHONE = '9800000003';

(async () => {
  const prisma = new PrismaClient();
  const admin = await prisma.user.findUnique({
    where: { phone: PORTAL_ADMIN_PHONE },
    select: { id: true, metadata: true },
  });
  if (!admin) {
    console.error('Admin user not found');
    process.exit(1);
  }

  const secret = generateTotpSecret();
  const metadata = { ...(admin.metadata ?? {}), totp_secret: secret, totp_enabled: false };
  await prisma.user.update({
    where: { id: admin.id },
    data: { metadata },
  });

  const label = encodeURIComponent(`HomeGenny Admin:${PORTAL_ADMIN_PHONE}`);
  const issuer = encodeURIComponent('HomeGenny');
  const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

  console.log('Admin 2FA reset.');
  console.log('Phone:', PORTAL_ADMIN_PHONE);
  console.log('New secret:', secret);
  console.log('OTPAuth URL:', otpauth);
  console.log('\nNext steps:');
  console.log('1. Delete the old "HomeGenny" entry in your authenticator app');
  console.log('2. Log in as admin — scan the new QR (labeled "HomeGenny Admin")');
  console.log('3. Enter the 6-digit code to finish setup');

  await prisma.$disconnect();
})();
