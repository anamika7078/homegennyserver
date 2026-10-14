/**
 * Client menu, check-in map and staff-request changes —
 * docs/MENU_TRACKING_REQUEST_CHANGES_PLAN.md (2026-10-14).
 *
 *   dishes            searchable dish list (seeded) + each client's own dishes
 *   menu_templates    one weekly pattern per client
 *   menu_plans        + meal_time, photo_file_ids, dish_ids, source (CLIENT | TEMPLATE)
 *   food_profiles     + meal_times (default time per meal)
 *   staff_requests    + start_time, lat, lng
 *   finance_customers + lat, lng (the client's home, for the check-in distance)
 *
 * Additive and re-runnable: new tables, new nullable/defaulted columns,
 * nothing dropped or rewritten. No foreign keys to tables outside this set,
 * so a `db push` has nothing to drop (all of it is declared in schema.prisma).
 * The dish seed lives in scratch/_dishes_seed.js and runs after this.
 *
 *   node scratch/_menu_request_changes_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'dishes',
    sql: `CREATE TABLE IF NOT EXISTS dishes (
            id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            -- NULL = the common list; set = this client's own dish, visible only to them.
            client_id  UUID,
            name       VARCHAR(120) NOT NULL,
            -- lower-case, single-spaced name: what "same dish" is checked on
            name_key   VARCHAR(120) NOT NULL,
            category   VARCHAR(20) NOT NULL CHECK (category IN ('BREAKFAST','DAL','SABZI','ROTI_PARATHA','RICE','SNACK','SALAD','SWEET','DRINK','OTHER')),
            diet       VARCHAR(10) NOT NULL CHECK (diet IN ('VEG','EGG','NON_VEG')),
            jain_ok    BOOLEAN NOT NULL DEFAULT false,
            region     VARCHAR(20) NOT NULL DEFAULT 'OTHER',
            meals      TEXT[] NOT NULL DEFAULT '{}',
            active     BOOLEAN NOT NULL DEFAULT true,
            created_by UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  { label: 'dishes indexes', sql: `CREATE INDEX IF NOT EXISTS idx_dishes_name_key ON dishes (name_key);
                                   CREATE INDEX IF NOT EXISTS idx_dishes_client ON dishes (client_id)` },
  {
    label: 'menu_templates',
    sql: `CREATE TABLE IF NOT EXISTS menu_templates (
            id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            client_id  UUID NOT NULL UNIQUE,
            -- [{ dow: MON..SUN, meal, dish_ids[], dishes[{name}], meal_time, special_instruction, servings }]
            items      JSONB NOT NULL DEFAULT '[]'::jsonb,
            active     BOOLEAN NOT NULL DEFAULT true,
            updated_by UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    label: 'menu_plans: meal_time, photo_file_ids, dish_ids, source',
    sql: `ALTER TABLE menu_plans ADD COLUMN IF NOT EXISTS meal_time VARCHAR(5);
          ALTER TABLE menu_plans ADD COLUMN IF NOT EXISTS photo_file_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
          ALTER TABLE menu_plans ADD COLUMN IF NOT EXISTS dish_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
          ALTER TABLE menu_plans ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'CLIENT'`,
  },
  {
    label: 'food_profiles: meal_times',
    sql: `ALTER TABLE food_profiles ADD COLUMN IF NOT EXISTS meal_times JSONB NOT NULL DEFAULT '{}'::jsonb`,
  },
  {
    label: 'staff_requests: start_time, lat, lng',
    sql: `ALTER TABLE staff_requests ADD COLUMN IF NOT EXISTS start_time VARCHAR(5);
          ALTER TABLE staff_requests ADD COLUMN IF NOT EXISTS lat NUMERIC(10,7);
          ALTER TABLE staff_requests ADD COLUMN IF NOT EXISTS lng NUMERIC(10,7)`,
  },
  {
    label: 'finance_customers: lat, lng',
    sql: `ALTER TABLE finance_customers ADD COLUMN IF NOT EXISTS lat NUMERIC(10,7);
          ALTER TABLE finance_customers ADD COLUMN IF NOT EXISTS lng NUMERIC(10,7)`,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }
  console.log(`Target: ${new URL(url).hostname}\n`);
  // SSL only for managed hosts. Keying on "localhost" breaks inside the compose
  // network, where the host is `postgres` and the server has no SSL.
  const needsSsl = /render\.com|dpg-|sslmode=require/i.test(url);
  const c = new Client({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : false });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const step of STEPS) {
      await c.query(step.sql);
      console.log(`  ok    ${step.label}`);
    }
    await c.query('COMMIT');
    console.log('\nMigration applied.\n');
  } catch (err) {
    await c.query('ROLLBACK');
    console.error('\nRolled back — nothing was changed.');
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
