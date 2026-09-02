/**
 * B2 — one invoice per client per period, enforced by the database.
 *
 * The month-end cron now issues a single consolidated invoice per customer
 * (ONE_STAFF_MODEL_PLAN.md §B1). This index makes the rule structural rather
 * than a convention any future code path could quietly break: whatever calls
 * what, a client cannot end up with two live consolidated invoices for the
 * same month.
 *
 * Two deliberate exclusions in the predicate:
 *
 * - **CANCELLED**, so a cancelled document can be reissued.
 * - **is_consolidated = false**, which is every invoice issued under the old
 *   one-per-placement model. Those are real historical documents — a client
 *   with three staff genuinely received three invoices, and some are already
 *   SENT or APPROVED. Rewriting that history is not this migration's business,
 *   and picking "which one was really the invoice" is not a choice a script
 *   should make. Since B3 removed the per-placement writer, no new
 *   non-consolidated invoice can be created, so scoping the index this way
 *   still constrains everything the system is now able to produce.
 *
 * Refuses to create the index if live consolidated invoices already violate
 * it, reporting the offending clients rather than failing on a half-built
 * index.
 */
const { Client } = require('pg');
require('dotenv').config();

const INDEX = 'uniq_client_invoice_period';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }

  // Managed Postgres (Render, Neon, RDS) refuses plaintext external connections.
  const isLocal = /localhost|127\.0\.0\.1/.test(new URL(url).hostname);
  const c = new Client({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  try {
    const exists = await c.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = $1`,
      [INDEX],
    );
    if (exists.rowCount) {
      console.log(`  ok    ${INDEX} already exists — nothing to do`);
      return;
    }

    // Would the index be violated by what is already stored?
    const dupes = await c.query(
      `SELECT client_id, period_month, period_year, count(*)::int AS n,
              string_agg(invoice_number, ', ' ORDER BY invoice_number) AS invoices
         FROM client_invoices
        WHERE status <> 'CANCELLED' AND is_consolidated = true
        GROUP BY client_id, period_month, period_year
       HAVING count(*) > 1
        ORDER BY n DESC`,
    );

    if (dupes.rowCount) {
      console.error(
        `\n  REFUSING — ${dupes.rowCount} client/period combination(s) already ` +
          `hold more than one live invoice:\n`,
      );
      for (const d of dupes.rows) {
        console.error(
          `    ${d.period_month}/${d.period_year}  client ${d.client_id}  ` +
            `${d.n} invoices: ${d.invoices}`,
        );
      }
      console.error(
        `\n  Decide which invoice is the real one and CANCEL or credit-note the\n` +
          `  rest, then re-run this script. Nothing was changed.\n`,
      );
      process.exitCode = 1;
      return;
    }

    // CONCURRENTLY cannot run inside a transaction; it also cannot be rolled
    // back, which is why the violation check above runs first.
    await c.query(
      `CREATE UNIQUE INDEX CONCURRENTLY ${INDEX}
         ON client_invoices (client_id, period_month, period_year)
       WHERE status <> 'CANCELLED' AND is_consolidated = true`,
    );
    console.log(`  ok    ${INDEX} created`);
    console.log('\nB2 migration applied — one live consolidated invoice per client per period.');
  } catch (err) {
    console.error('\nFailed — nothing partial was left behind.');
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
