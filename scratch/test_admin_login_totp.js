const axios = require('axios');
const { totpCode, verifyTotp } = require('../dist/modules/auth/auth-otp.util');

const BASE = process.argv[2] || 'https://homegennyserver-po5u.onrender.com/api/v1';
const SECRET = process.argv[3] || 'NWHPF4QHDOOAYTAIU562EDNS3O4HLG6C';

(async () => {
  const code = totpCode(SECRET);
  console.log('secret:', SECRET);
  console.log('local verify:', verifyTotp(SECRET, code));
  console.log('code:', code);
  console.log('target:', BASE);

  const login = await axios.post(`${BASE}/auth/login`, {
    phone: '9800000003',
    password: 'HomeGenny@2024',
    totp: code,
  });
  console.log('login OK:', JSON.stringify(login.data).slice(0, 300));
})().catch((e) => {
  console.error('FAIL:', e.response?.status, JSON.stringify(e.response?.data));
  process.exit(1);
});
