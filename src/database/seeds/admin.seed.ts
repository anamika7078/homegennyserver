/**
 * HomeGenny — Admin Seed Script
 *
 * Creates the default Branch Manager login.
 * Run once after DB migrations:
 *   docker compose exec backend npm run seed:run
 *
 * Default credentials:
 *   Phone:    9800000001
 *   Password: HomeGenny@2024
 */

import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';

// ── parse CLI args  --phone=X  --name=X  --password=X  --role=X ──
function arg(name: string, fallback: string): string {
  const flag = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(flag));
  return found ? found.slice(flag.length) : fallback;
}

const PHONE    = arg('phone',    '9800000001');
const NAME     = arg('name',     'Amit Gupta');
const PASSWORD = arg('password', 'HomeGenny@2024');
const ROLE     = arg('role',     'BM');

// ── Load .env.production or .env ─────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dotenv = require('dotenv');
dotenv.config({ path: '.env.production' });
dotenv.config({ path: '.env' });            // fallback for local dev

async function seed() {
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) {
    console.error('[SEED] ERROR: DATABASE_URL is not set.');
    console.error('[SEED] Make sure .env.production (or .env) is present and has DATABASE_URL.');
    process.exit(1);
  }

  console.log(`[SEED] Connecting to database…`);

  const ds = new DataSource({
    type:        'postgres',
    url:         dbUrl,
    ssl:         process.env['NODE_ENV'] === 'production'
                   ? { rejectUnauthorized: false }
                   : false,
    synchronize: false,
    logging:     false,
  });

  await ds.initialize();
  console.log('[SEED] Connected.');

  // ── Ensure default branch exists ─────────────────────────────
  const BRANCH_ID = '00000000-0000-0000-0000-000000000001';

  await ds.query(`
    INSERT INTO branches (id, name, city, state, email, gstin)
    VALUES ($1, 'HomeGenny Delhi NCR HQ', 'New Delhi', 'Delhi',
            'delhi@homegenny.com', '07AABCH1234A1Z8')
    ON CONFLICT (id) DO NOTHING
  `, [BRANCH_ID]);
  console.log('[SEED] Branch ensured.');

  // ── Check if phone already exists ────────────────────────────
  const existing = await ds.query(
    `SELECT id, phone, role FROM users WHERE phone = $1 LIMIT 1`,
    [PHONE],
  );

  if (existing.length > 0) {
    console.log(`[SEED] User ${PHONE} already exists (id: ${existing[0].id}, role: ${existing[0].role}).`);
    console.log('[SEED] Updating password…');

    const newHash = await bcrypt.hash(PASSWORD, 12);
    await ds.query(
      `UPDATE users SET password_hash = $1, is_active = true, updated_at = NOW() WHERE phone = $2`,
      [newHash, PHONE],
    );

    console.log(`[SEED] Password updated for ${PHONE}.`);
  } else {
    // ── Create new user ─────────────────────────────────────────
    const hash = await bcrypt.hash(PASSWORD, 12);

    const [user] = await ds.query(`
      INSERT INTO users
        (branch_id, role, full_name, phone, email, password_hash, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, true)
      RETURNING id, phone, role, full_name
    `, [
      BRANCH_ID,
      ROLE.toUpperCase(),
      NAME,
      PHONE,
      `${PHONE}@homegenny.com`,
      hash,
    ]);

    console.log(`[SEED] Created user:`);
    console.log(`       ID:    ${user.id}`);
    console.log(`       Name:  ${user.full_name}`);
    console.log(`       Phone: ${user.phone}`);
    console.log(`       Role:  ${user.role}`);
  }

  // ── Create additional RM user for testing ────────────────────
  const RM_PHONE = '9800000002';
  const existingRM = await ds.query(
    `SELECT id FROM users WHERE phone = $1 LIMIT 1`, [RM_PHONE],
  );

  if (!existingRM.length) {
    const rmHash = await bcrypt.hash(PASSWORD, 12);
    await ds.query(`
      INSERT INTO users
        (branch_id, role, full_name, phone, email, password_hash, is_active)
      VALUES ($1, 'RM', 'Pooja Mishra', $2, $3, $4, true)
    `, [BRANCH_ID, RM_PHONE, `${RM_PHONE}@homegenny.com`, rmHash]);

    console.log(`[SEED] Created RM user: 9800000002 / ${PASSWORD}`);
  } else {
    console.log(`[SEED] RM user 9800000002 already exists.`);
  }

  await ds.destroy();

  console.log('');
  console.log('[SEED] ════════════════════════════════════════════');
  console.log('[SEED]  Login credentials:');
  console.log(`[SEED]  BM  Phone: ${PHONE}  Password: ${PASSWORD}`);
  console.log(`[SEED]  RM  Phone: 9800000002  Password: ${PASSWORD}`);
  console.log('[SEED]  URL: https://admin.homegenny.com');
  console.log('[SEED] ════════════════════════════════════════════');
}

seed().catch((err: unknown) => {
  console.error('[SEED] FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
