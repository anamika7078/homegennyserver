/**
 * Signed muster rolls (M2) — additive, safe to re-run.
 *
 * The Form XVI muster roll is built live from attendance; this stores the ones
 * a client has signed — in the client app, or on paper (the RM uploads the
 * signed scan) — exactly as they were signed. A month signed again (attendance
 * corrected afterwards) gets a new version; the old one is SUPERSEDED and kept.
 *
 *   muster_rolls  client_id, period_month, period_year, version,
 *                 status SIGNED_DIGITAL | SIGNED_PAPER | SUPERSEDED,
 *                 snapshot (the roll as signed), sign_method CLIENT_APP | PAPER_UPLOAD,
 *                 signed_at/_by/_name, scan_key/scan_mime (paper), note,
 *                 invoice_id/locked_at (frozen with an approved invoice — M3)
 *
 *   node scratch/_muster_roll_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'muster_rolls',
    sql: `CREATE TABLE IF NOT EXISTS muster_rolls (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            client_id     UUID NOT NULL,
            period_month  INT NOT NULL CHECK (period_month BETWEEN 1 AND 12),
            period_year   INT NOT NULL,
            version       INT NOT NULL DEFAULT 1,
            status        VARCHAR(20) NOT NULL CHECK (status IN ('SIGNED_DIGITAL','SIGNED_PAPER','SUPERSEDED')),
            snapshot      JSONB NOT NULL,
            sign_method   VARCHAR(20) NOT NULL CHECK (sign_method IN ('CLIENT_APP','PAPER_UPLOAD')),
            signed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            signed_by     UUID,
            signed_name   TEXT,
            scan_key      TEXT,
            scan_mime     VARCHAR(100),
            note          TEXT,
            invoice_id    UUID,
            locked_at     TIMESTAMPTZ,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT muster_rolls_version_uniq UNIQUE (client_id, period_year, period_month, version)
          )`,
  },
  { label: 'idx muster rolls by client month', sql: `CREATE INDEX IF NOT EXISTS idx_muster_rolls_client_month ON muster_rolls (client_id, period_year, period_month)` },
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
    await db.query(step.sql);
    console.log(`  ok  ${step.label}`);
  }
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
