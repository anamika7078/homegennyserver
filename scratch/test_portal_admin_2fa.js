require('dotenv').config();
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const { totpCode } = require('../dist/modules/auth/auth-otp.util');

const PORTAL_ADMIN_PHONE = '9800000003';
const PORTAL_ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const BASE = process.argv[2] || 'http://localhost:3001/api/v1';

async function ensurePortalAdmin2fa(prisma) {
  const admin = await prisma.user.findUnique({
    where: { phone: PORTAL_ADMIN_PHONE },
    select: { id: true, metadata: true },
  });
  if (!admin) return false;
  const current = admin.metadata ?? {};
  if (current.totp_secret === PORTAL_ADMIN_TOTP_SECRET) return false;
  await prisma.user.update({
    where: { id: admin.id },
    data: {
      metadata: {
        ...current,
        totp_secret: PORTAL_ADMIN_TOTP_SECRET,
        totp_enabled: false,
      },
    },
  });
  return true;
}

(async () => {
  const prisma = new PrismaClient();
  console.log('reset:', await ensurePortalAdmin2fa(prisma));

  const step1 = await axios.post(`${BASE}/auth/login`, {
    phone: PORTAL_ADMIN_PHONE,
    password: 'HomeGenny@2024',
  });
  console.log('step1:', JSON.stringify(step1.data.data));

  const code = totpCode(PORTAL_ADMIN_TOTP_SECRET);
  console.log('totp:', code);

  const step2 = await axios.post(`${BASE}/auth/login`, {
    phone: PORTAL_ADMIN_PHONE,
    password: 'HomeGenny@2024',
    totp: code,
  });
  console.log('step2 token:', Boolean(step2.data.data?.access_token));

  await prisma.$disconnect();
})().catch((e) => {
  console.error('FAIL:', e.response?.status, JSON.stringify(e.response?.data));
  process.exit(1);
});
