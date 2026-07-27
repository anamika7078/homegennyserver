const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const BRANCH_ID = '00000000-0000-0000-0000-000000000001';
const PASSWORD = 'HomeGenny@2024';
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:root@localhost:5432/homegenny';

const USERS = [
  { phone: '9800000001', role: 'BM', fullName: 'Amit Gupta', email: 'bm@homegenny.com' },
  { phone: '9800000002', role: 'RM', fullName: 'Pooja Mishra', email: 'rm@homegenny.com' },
  { phone: '9800000003', role: 'ADMIN', fullName: 'Super Admin', email: 'admin@homegenny.com' },
  { phone: '9800000004', role: 'FINANCE', fullName: 'Rajesh Finance', email: 'finance@homegenny.com' },
  { phone: '9800000005', role: 'TRAINER', fullName: 'Sunita Trainer', email: 'trainer@homegenny.com' },
  { phone: '9800000006', role: 'ASSESSOR', fullName: 'Dr. Kavita Assessor', email: 'assessor@homegenny.com' },
  { phone: '9800000007', role: 'SUPPORT', fullName: 'Ops Support', email: 'support@homegenny.com' },
  { phone: '9800000008', role: 'HR', fullName: 'HR Admin', email: 'hr@homegenny.com' },
];

async function main() {
  const client = new Client({
    connectionString: DB_URL,
    ssl: DB_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('[OK] Connected to database');

  await client.query(`
    DO $$ BEGIN
      ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'TRAINER';
      ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'ASSESSOR';
      ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'SUPPORT';
      ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'HR';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await client.query(
    `INSERT INTO branches (id, name, city, state, email, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [BRANCH_ID, 'HomeGenny Delhi NCR HQ', 'New Delhi', 'Delhi', 'delhi@homegenny.com'],
  );

  const hash = await bcrypt.hash(PASSWORD, 12);
  for (const u of USERS) {
    await client.query(
      `INSERT INTO users (id, branch_id, role, full_name, phone, email, password_hash, is_active, updated_at)
       VALUES (gen_random_uuid(), $1, $2::user_role, $3, $4, $5, $6, true, NOW())
       ON CONFLICT (phone) DO UPDATE SET
         branch_id = EXCLUDED.branch_id,
         role = EXCLUDED.role,
         full_name = EXCLUDED.full_name,
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         is_active = true,
         refresh_token_hash = NULL,
         active_session_id = NULL,
         updated_at = NOW()`,
      [BRANCH_ID, u.role, u.fullName, u.phone, u.email, hash],
    );
    console.log('✓', u.role.padEnd(8), u.phone, u.fullName);
  }

  const { rows } = await client.query(
    `SELECT phone, role::text AS role, full_name FROM users WHERE phone = ANY($1) ORDER BY phone`,
    [USERS.map((u) => u.phone)],
  );
  console.log('\n' + rows.length + ' users in database. Password for all: ' + PASSWORD);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
