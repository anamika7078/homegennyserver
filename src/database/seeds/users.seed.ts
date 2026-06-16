/**
 * Seeds all portal login users (phone + bcrypt password).
 * Run: npm run seed:run
 */
import * as bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { loadSeedEnv } from './load-env';

const BRANCH_ID = '00000000-0000-0000-0000-000000000001';
const PASSWORD = process.env.SEED_PASSWORD ?? 'HomeGenny@2024';

const USERS = [
  { phone: '9800000001', role: 'BM', fullName: 'Amit Gupta', email: 'bm@homegenny.com' },
  { phone: '9800000002', role: 'RM', fullName: 'Pooja Mishra', email: 'rm@homegenny.com' },
  { phone: '9800000003', role: 'ADMIN', fullName: 'Super Admin', email: 'admin@homegenny.com' },
  { phone: '9800000004', role: 'FINANCE', fullName: 'Rajesh Finance', email: 'finance@homegenny.com' },
  { phone: '9800000005', role: 'TRAINER', fullName: 'Sunita Trainer', email: 'trainer@homegenny.com' },
  { phone: '9800000006', role: 'ASSESSOR', fullName: 'Dr. Kavita Assessor', email: 'assessor@homegenny.com' },
  { phone: '9800000007', role: 'SUPPORT', fullName: 'Ops Support', email: 'support@homegenny.com' },
] as const;

const EXTRA_ROLES = ['TRAINER', 'ASSESSOR', 'SUPPORT'] as const;

function superuserUrls(appUrl: string): string[] {
  const fromEnv = process.env.DATABASE_SUPERUSER_URL;
  if (fromEnv) return [fromEnv];
  try {
    const u = new URL(appUrl);
    const host = `${u.hostname}:${u.port || '5432'}`;
    const db = u.pathname.replace(/^\//, '') || 'homegenny';
    return [
      `postgresql://postgres:${process.env.POSTGRES_PASSWORD ?? 'root'}@${host}/${db}`,
      `postgresql://postgres:postgres@${host}/${db}`,
    ];
  } catch {
    return [];
  }
}

async function ensureRoles(appDbUrl: string): Promise<void> {
  const existing = await queryEnumValues(appDbUrl);
  const missing = EXTRA_ROLES.filter((r) => !existing.includes(r));
  if (!missing.length) return;

  let extended = false;
  for (const suUrl of superuserUrls(appDbUrl)) {
    const su = new Client({ connectionString: suUrl });
    try {
      await su.connect();
      for (const role of missing) {
        await su.query(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS '${role}'`);
      }
      extended = true;
      console.log('[SEED] Extended user_role enum:', missing.join(', '));
      break;
    } catch {
      // try next superuser URL
    } finally {
      await su.end().catch(() => undefined);
    }
  }

  if (!extended) {
    throw new Error(
      '[SEED] Cannot add TRAINER/ASSESSOR/SUPPORT to user_role. ' +
        'Set DATABASE_SUPERUSER_URL (postgres owner) and re-run npm run seed:run, e.g.\n' +
        '  DATABASE_SUPERUSER_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/homegenny',
    );
  }
}

async function queryEnumValues(dbUrl: string): Promise<string[]> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    const { rows } = await c.query<{ enumlabel: string }>(
      `SELECT e.enumlabel FROM pg_type t
       JOIN pg_enum e ON t.oid = e.enumtypid
       WHERE t.typname = 'user_role' ORDER BY e.enumsortorder`,
    );
    return rows.map((r) => r.enumlabel);
  } finally {
    await c.end();
  }
}

async function ensureBranch(client: Client): Promise<string | null> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'branches'
     ) AS exists`,
  );
  if (!rows[0]?.exists) return null;

  await client.query(
    `INSERT INTO branches (id, name, city, state, email, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [BRANCH_ID, 'HomeGenny Delhi NCR HQ', 'New Delhi', 'Delhi', 'delhi@homegenny.com'],
  );
  return BRANCH_ID;
}

async function seedUsers(): Promise<void> {
  const dbUrl = loadSeedEnv().replace(/\?schema=public/, '');
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    await ensureRoles(dbUrl);
    const branchId = await ensureBranch(client);
    const hash = await bcrypt.hash(PASSWORD, 12);

    console.log(`[SEED] Password for all users: ${PASSWORD}\n`);

    for (const u of USERS) {
      await client.query(
        `INSERT INTO users (id, branch_id, role, full_name, phone, email, password_hash, is_active, created_at, updated_at)
         VALUES ($1, $2, $3::user_role, $4, $5, $6, $7, true, NOW(), NOW())
         ON CONFLICT (phone) DO UPDATE SET
           branch_id     = COALESCE(EXCLUDED.branch_id, users.branch_id),
           role          = EXCLUDED.role,
           full_name     = EXCLUDED.full_name,
           email         = EXCLUDED.email,
           password_hash = EXCLUDED.password_hash,
           is_active     = true,
           updated_at    = NOW()`,
        [randomUUID(), branchId, u.role, u.fullName, u.phone, u.email, hash],
      );
      console.log(`  ✓ ${u.role.padEnd(8)} ${u.phone}  ${u.fullName}`);
    }

    const { rows } = await client.query(
      `SELECT phone, role::text AS role, full_name, is_active
       FROM users WHERE phone = ANY($1::text[])
       ORDER BY phone`,
      [USERS.map((u) => u.phone)],
    );
    console.log(`\n[SEED] ${rows.length} login users ready.`);
  } finally {
    await client.end();
  }
}

seedUsers().catch((e) => {
  console.error('[SEED] Failed:', e);
  process.exit(1);
});
