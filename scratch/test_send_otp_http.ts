import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const BASE = 'http://localhost:3001/api/v1';
const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRaw`
    UPDATE users SET refresh_token_hash = NULL, active_session_id = NULL
    WHERE phone = '9800000003'
  `;

  const login = await axios.post(`${BASE}/auth/login`, {
    phone: '9800000003',
    password: 'HomeGenny@2024',
  });
  const token = login.data?.data?.access_token ?? login.data?.access_token;
  if (!token) throw new Error('No token');

  const res = await axios.post(
    `${BASE}/agreements/esign/send-otp`,
    {
      staff_id: 'a050834b-b25f-4f02-9844-26a3bdb7081a',
      agreement_type: 'A1',
      staff_name: 'anamika',
    },
    { headers: { Authorization: `Bearer ${token}` } },
  );
  console.log('OK', JSON.stringify(res.data, null, 2));
}

main()
  .catch((e) => {
    console.error('FAIL', e.response?.status, e.response?.data ?? e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
