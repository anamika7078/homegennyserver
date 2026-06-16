import axios from 'axios';

const BASE = 'http://localhost:3001/api/v1';

async function main() {
  await axios.post(`${BASE}/auth/logout`, {}, {
    headers: { Authorization: 'Bearer dummy' },
  }).catch(() => {});

  const login = await axios.post(`${BASE}/auth/login`, {
    phone: '9800000003',
    password: 'HomeGenny@2024',
  });
  const token =
    login.data?.data?.access_token ?? login.data?.access_token;
  if (!token) throw new Error('No token');

  const staffId = 'ed2fb645-906c-45b7-8bee-0f15dbf2dfe4';

  const res = await axios.post(
    `${BASE}/agreements/esign/send-otp`,
    {
      staff_id: staffId,
      agreement_type: 'A1',
      staff_name: 'Test Staff',
    },
    { headers: { Authorization: `Bearer ${token}` } },
  );
  console.log('OK', JSON.stringify(res.data, null, 2));
}

main().catch((e) => {
  console.error('FAIL', e.response?.status, e.response?.data ?? e.message);
  process.exit(1);
});
