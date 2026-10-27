import { BadRequestException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

/**
 * When a payroll row stops being a working figure and becomes a payslip.
 *
 * A row used to reach the staff app the moment it was written, and could be
 * approved and paid while the invoice built from it was still a DRAFT nobody
 * had checked — so a wrong rate typed on a placement went straight onto a
 * payslip and could go into a bank account. Salary is never clawed back, so the
 * mistake has to be caught before anything leaves.
 *
 * A row is released when Finance approves the invoice it is on. Finance reading
 * the invoice is the rate check: rate, duties and total are all on it. An Admin
 * can release a row by hand with a written reason once Finance has had
 * RELEASE_GRACE_DAYS — so a stuck invoice cannot hold someone's salary forever.
 */

export const RELEASE_GRACE_DAYS = 3;

type Db = DataSource | EntityManager;

export interface ReleasedRow {
  id: string;
  staff_id: string;
  period_month: number;
  period_year: number;
  net_salary: string;
}

/** Releases every unreleased row on an invoice. Returns the rows it released. */
export async function releaseInvoicePayroll(db: Db, invoiceId: string, actorId?: string | null) {
  const res = await db.query(
    `UPDATE payroll_records
        SET released_at = NOW(), released_by = $2, release_reason = NULL
      WHERE client_invoice_id = $1 AND released_at IS NULL
    RETURNING id, staff_id, period_month, period_year, net_salary`,
    [invoiceId, actorId ?? null],
  );
  // TypeORM hands back `[rows, affectedCount]` for UPDATE ... RETURNING.
  return (Array.isArray(res[0]) ? res[0] : res) as ReleasedRow[];
}

/**
 * Takes the payslip back for rows on an invoice being cancelled. A row that has
 * already been paid stays released: the slip is the record of money that moved.
 */
export async function unreleaseInvoicePayroll(db: Db, invoiceId: string) {
  await db.query(
    `UPDATE payroll_records
        SET released_at = NULL, released_by = NULL, release_reason = NULL
      WHERE client_invoice_id = $1 AND disbursed_at IS NULL
        AND disbursement_status NOT IN ('PROCESSING','PAID')`,
    [invoiceId],
  );
}

/** Why a row cannot be approved or paid yet, or null when it can. */
export async function unreleasedReason(db: Db, payrollId: string): Promise<string | null> {
  const rows = await db.query(
    `SELECT pr.released_at, ci.invoice_number, ci.status AS invoice_status
       FROM payroll_records pr
       LEFT JOIN client_invoices ci ON ci.id = pr.client_invoice_id
      WHERE pr.id = $1`,
    [payrollId],
  );
  const r = rows[0] as { released_at: Date | null; invoice_number: string | null; invoice_status: string | null } | undefined;
  if (!r || r.released_at) return null;
  return r.invoice_number
    ? `Invoice ${r.invoice_number} is ${r.invoice_status}. Finance has to approve the invoice first — ` +
        `the salary is released with it, so a wrong rate is caught before anyone is paid.`
    : `This payroll is not on any invoice yet. Raise the client's invoice and approve it first — ` +
        `or, after ${RELEASE_GRACE_DAYS} days, an Admin can release it with a reason.`;
}

export async function assertReleased(db: Db, payrollId: string) {
  const reason = await unreleasedReason(db, payrollId);
  if (reason) throw new BadRequestException(reason);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (m: number, y: number) => `${MONTHS[m - 1] ?? m} ${y}`;
