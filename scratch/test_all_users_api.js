/**
 * Verify all portal users can log in and reach their role module APIs.
 * Usage: node scratch/test_all_users_api.js [baseUrl]
 */
const axios = require('axios');

const BASE = (process.argv[2] || 'https://homegennyserver-po5u.onrender.com').replace(/\/$/, '');
const API = `${BASE}/api/v1`;
const PASSWORD = 'HomeGenny@2024';

const USERS = [
  {
    phone: '9800000001',
    role: 'BM',
    name: 'Amit Gupta',
    apis: [
      { method: 'GET', path: '/dashboard/bm', label: 'BM dashboard' },
      { method: 'GET', path: '/alarms', label: 'Alarms list' },
      { method: 'GET', path: '/auth/me', label: 'Profile' },
    ],
  },
  {
    phone: '9800000002',
    role: 'RM',
    name: 'Pooja Mishra',
    apis: [
      { method: 'GET', path: '/dashboard/rm', label: 'RM dashboard' },
      { method: 'GET', path: '/rm/kanban', label: 'RM kanban pipeline' },
      { method: 'GET', path: '/auth/me', label: 'Profile' },
    ],
  },
  {
    phone: '9800000003',
    role: 'ADMIN',
    name: 'Super Admin',
    apis: [
      { method: 'GET', path: '/dashboard/admin', label: 'Admin dashboard' },
      { method: 'GET', path: '/admin/users', label: 'User management' },
      { method: 'GET', path: '/auth/me', label: 'Profile' },
    ],
    needs2fa: true,
  },
  {
    phone: '9800000004',
    role: 'FINANCE',
    name: 'Rajesh Finance',
    apis: [
      { method: 'GET', path: '/finance/payroll', label: 'Finance payroll' },
      { method: 'GET', path: '/finance/invoices', label: 'Finance invoices' },
      { method: 'GET', path: '/auth/me', label: 'Profile' },
    ],
  },
  {
    phone: '9800000005',
    role: 'TRAINER',
    name: 'Sunita Trainer',
    apis: [
      { method: 'GET', path: '/trainer/dashboard', label: 'Trainer dashboard' },
      { method: 'GET', path: '/trainer/batches', label: 'Trainer batches' },
      { method: 'GET', path: '/auth/me', label: 'Profile' },
    ],
  },
  {
    phone: '9800000006',
    role: 'ASSESSOR',
    name: 'Dr. Kavita Assessor',
    apis: [
      { method: 'GET', path: '/assessors/dashboard', label: 'Assessor dashboard' },
      { method: 'GET', path: '/assessors/assessments', label: 'Assessments queue' },
      { method: 'GET', path: '/auth/me', label: 'Profile' },
    ],
  },
  {
    phone: '9800000007',
    role: 'SUPPORT',
    name: 'Ops Support',
    apis: [
      { method: 'GET', path: '/alarms', label: 'Alarms list' },
      { method: 'GET', path: '/auth/me', label: 'Profile' },
    ],
  },
];

async function login(phone) {
  const res = await axios.post(`${API}/auth/login`, { phone, password: PASSWORD });
  const body = res.data?.data ?? res.data;
  return body;
}

async function callApi(token, { method, path }) {
  const res = await axios({
    method,
    url: `${API}${path}`,
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });
  return { status: res.status, ok: res.status >= 200 && res.status < 300 };
}

async function main() {
  console.log(`Testing portal users against ${API}\n`);

  const health = await axios.get(`${API}/health`).catch((e) => e.response);
  if (health?.data) {
    const h = health.data?.data ?? health.data;
    console.log(
      `Health: db=${h.database}, portal_users=${h.portal_users ?? '?'}/${h.portal_users_expected ?? 7}\n`,
    );
  }

  let passed = 0;
  let failed = 0;

  for (const user of USERS) {
    console.log(`── ${user.role} ${user.phone} (${user.name}) ──`);
    try {
      const loginRes = await login(user.phone);
      if (loginRes.requires_2fa || loginRes.requires_totp_setup) {
        console.log(`  LOGIN: needs 2FA setup (expected for ADMIN on first login)`);
        console.log(`  SKIP module APIs until TOTP is configured\n`);
        continue;
      }
      if (!loginRes.access_token) {
        console.log(`  LOGIN FAIL: no access_token`, loginRes);
        failed++;
        continue;
      }
      console.log(`  LOGIN: OK (${loginRes.user?.role})`);

      for (const api of user.apis) {
        const result = await callApi(loginRes.access_token, api);
        const mark = result.ok ? 'OK' : 'FAIL';
        console.log(`  ${mark} ${api.method} ${api.path} → ${result.status} (${api.label})`);
        if (result.ok) passed++;
        else failed++;
      }
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.message ?? err.message;
      console.log(`  LOGIN FAIL: ${status ?? ''} ${JSON.stringify(msg)}`);
      failed++;
    }
    console.log('');
  }

  console.log(`Done: ${passed} API checks passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
