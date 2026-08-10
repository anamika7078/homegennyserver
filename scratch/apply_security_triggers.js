/**
 * Applies (idempotently) the append-only DB triggers on pipeline_events,
 * admin_audit_logs, and (Phase 4, Pillar 8) right_to_refuse_log. Plain JS +
 * `pg` (a production dependency) rather than ts-node + Prisma, so it works
 * in every deploy path — including the slim production Docker image, which
 * only installs production deps and never has ts-node available.
 *
 * Deliberately independent of Prisma's migration state tracking: the
 * `20260528000000_admin_security_triggers` migration exists but has long
 * been marked rolled-back in `_prisma_migrations` (see render_pre_migrate.js),
 * so `prisma migrate deploy` silently skips it — this script is the actual
 * enforcement mechanism now, run explicitly on every startup, in every
 * environment, regardless of migration bookkeeping state.
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[apply_security_triggers] DATABASE_URL not set — skipping');
    return;
  }

  const client = new Client({
    connectionString: url,
    ssl: /render\.com|dpg-|sslmode=require/i.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  try {
    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_update_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Table is append-only. Modification or deletion is not allowed.';
      END;
      $$ LANGUAGE plpgsql;
    `);

    for (const table of ['pipeline_events', 'admin_audit_logs', 'right_to_refuse_log']) {
      const exists = await client.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) AS exists`,
        [table],
      );
      if (!exists.rows[0].exists) {
        console.warn(`[apply_security_triggers] table "${table}" does not exist yet — skipping (will apply on next startup once it's created)`);
        continue;
      }
      await client.query(`DROP TRIGGER IF EXISTS prevent_update_delete_${table} ON ${table}`);
      await client.query(`
        CREATE TRIGGER prevent_update_delete_${table}
        BEFORE UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION prevent_update_delete();
      `);
      console.log(`[apply_security_triggers] append-only trigger applied to ${table}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // Non-fatal by convention with the rest of this project's startup scripts
  // (see render_pre_migrate.js) — but this one is a real security control, so
  // fail loudly rather than swallowing it silently.
  console.error('[apply_security_triggers] FAILED — append-only protection may not be active:', err.message);
  process.exit(1);
});
