/**
 * An approved invoice freezes the client's signed muster roll for its month:
 * the roll is the attendance proof the bill was approved on, so it cannot be
 * re-signed under it. Cancelling or rejecting the invoice frees it again.
 *
 * Plain SQL on the caller's transaction (TypeORM EntityManager or DataSource).
 * A database without the muster_rolls table yet is left alone.
 */
type Q = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

async function hasTable(m: Q) {
  const [row] = (await m.query(`SELECT to_regclass('public.muster_rolls') IS NOT NULL AS ok`)) as { ok: boolean }[];
  return !!row?.ok;
}

export async function lockMusterRollForInvoice(m: Q, invoiceId: string): Promise<number> {
  if (!(await hasTable(m))) return 0;
  const rows = (await m.query(
    `UPDATE muster_rolls mr
        SET invoice_id = ci.id, locked_at = NOW()
       FROM client_invoices ci
      WHERE ci.id = $1 AND ci.is_consolidated
        AND mr.client_id = ci.client_id AND mr.period_month = ci.period_month AND mr.period_year = ci.period_year
        AND mr.status <> 'SUPERSEDED' AND mr.locked_at IS NULL
      RETURNING mr.id`,
    [invoiceId],
  )) as unknown[];
  return Array.isArray(rows) ? (Array.isArray(rows[0]) ? (rows[0] as unknown[]).length : rows.length) : 0;
}

export async function unlockMusterRollForInvoice(m: Q, invoiceId: string): Promise<void> {
  if (!(await hasTable(m))) return;
  await m.query(`UPDATE muster_rolls SET invoice_id = NULL, locked_at = NULL WHERE invoice_id = $1`, [invoiceId]);
}
