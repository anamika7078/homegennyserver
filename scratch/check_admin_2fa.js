require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { totpCode } = require('../dist/modules/auth/auth-otp.util');

(async () => {
  const prisma = new PrismaClient();
  const rows = await prisma.$queryRawUnsafe(`
    SELECT phone, role, metadata FROM users WHERE phone = '9800000003'
  `);
  const user = rows[0];
  console.log('Admin metadata:', JSON.stringify(user?.metadata, null, 2));
  const secret = user?.metadata?.totp_secret;
  if (secret) {
    console.log('Current TOTP code for secret:', totpCode(String(secret)));
  }
  await prisma.$disconnect();
})();
