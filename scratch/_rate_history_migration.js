/**
 * Placement rate history — additive, safe to re-run.
 *
 * A placement's rate was a single set of columns, overwritten in place: no
 * record of what it was before, who changed it, or from when the new figure
 * applies. Payroll used whatever the columns said on the day it ran, so a
 * raise from the 15th either paid the whole month at the new rate or none of it.
 *
 *   placement_rate_changes  one row per change: the rates in force before and
 *                           after (JSON), the date it applies from, who, why.
 *                           A later edit with an earlier date supersedes the
 *                           changes it overlaps (superseded_at), so the active
 *                           rows always form one timeline.
 *   placements              rate_verified_at / _by / _invoice_id — the last
 *                           time Finance approved an invoice on this placement;
 *                           rate changes after it are shown to Finance as new.
 *
 *   node scratch/_rate_history_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'placement_rate_changes',
    sql: `CREATE TABLE IF NOT EXISTS placement_rate_changes (
            id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            placement_id   UUID NOT NULL,
            effective_from DATE NOT NULL,
            before         JSONB NOT NULL,
            after          JSONB NOT NULL,
            reason         TEXT,
            source         VARCHAR(20) NOT NULL DEFAULT 'TERMS_EDIT',
            changed_by     UUID,
            changed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            superseded_at  TIMESTAMPTZ,
            superseded_by  UUID
          )`,
  },
  {
    label: 'idx active changes per placement',
    sql: `CREATE INDEX IF NOT EXISTS idx_rate_changes_active
            ON placement_rate_changes (placement_id, effective_from) WHERE superseded_at IS NULL`,
  },
  { label: 'placements.rate_verified_at', sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS rate_verified_at TIMESTAMPTZ` },
  { label: 'placements.rate_verified_by', sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS rate_verified_by UUID` },
  { label: 'placements.rate_verified_invoice_id', sql: `ALTER TABLE placements ADD COLUMN IF NOT EXISTS rate_verified_invoice_id UUID` },
  {
    // Placements already billed on an approved/sent/paid invoice have had their
    // rate looked at by Finance; say so, rather than flag every one as new.
    label: 'backfill: verified by the latest approved invoice',
    sql: `UPDATE placements p
             SET rate_verified_at = x.approved_at, rate_verified_invoice_id = x.invoice_id
            FROM (
              SELECT DISTINCT ON (pr.placement_id) pr.placement_id, ci.id AS invoice_id,
                     COALESCE(ci.approved_at, ci.created_at) AS approved_at
                FROM payroll_records pr
                JOIN client_invoices ci ON ci.id = pr.client_invoice_id
               WHERE ci.status IN ('APPROVED','SENT','PARTIALLY_PAID','PAID','OVERDUE')
               ORDER BY pr.placement_id, ci.created_at DESC
            ) x
           WHERE p.id = x.placement_id AND p.rate_verified_at IS NULL`,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  // SSL only for hosted databases that require it (Render). The dev server runs
  // postgres in a sibling container without SSL, so "not localhost" is not enough.
  const needsSsl = /render\.com|dpg-|sslmode=require/i.test(url);
  const db = new Client({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : false });
  await db.connect();
  console.log(`Migrating ${new URL(url).hostname}/${new URL(url).pathname.slice(1)}`);
  for (const step of STEPS) {
    const r = await db.query(step.sql);
    console.log(`  ok  ${step.label}${r.command === 'UPDATE' ? ` (${r.rowCount} placements)` : ''}`);
  }
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
