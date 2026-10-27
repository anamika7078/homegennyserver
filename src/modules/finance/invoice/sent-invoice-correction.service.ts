import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PayrollService } from '../../payroll/payroll.service';
import { CreditNoteService } from '../settlement/credit-note.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { round2 } from '../../../common/finance/statutory-calc.util';
import { formatInvoiceNumber } from '../../../common/finance/gst.util';
import { formatPeriod, isoDate } from '../../../common/finance/period.util';

/**
 * The staff side of a line. Owed > 0: arrears. Owed < 0: overpaid — recorded
 * as absorbed, only the part not already recorded (never deducted).
 */
function staffDelta(owed: number, alreadyAbsorbed: number) {
  if (owed >= 0) return round2(owed);
  const more = round2(-owed - alreadyAbsorbed);
  return more > 0 ? -more : 0;
}

/** An invoice the client already has. DRAFT/APPROVED are rejected instead. */
const CORRECTABLE = ['SENT', 'PARTIALLY_PAID', 'OVERDUE', 'PAID'];
const PENNY = 0.005;

export interface CorrectionLine {
  payroll_id: string; placement_id: string; staff_id: string; staff_name: string; period: string;
  rate_now: number | null;
  billed_before: number; billed_after: number; client_delta: number;
  paid_before: number; paid_after: number; staff_delta: number;
}

interface InvoiceHead {
  id: string; invoice_number: string; status: string; client_id: string;
  period_month: number; period_year: number; period_from: unknown; period_to: unknown;
  taxable_value: string; gst_amount: string; igst_amount: string; document_type: string | null;
  supplier_gstin: string | null; supplier_state: string | null; recipient_gstin: string | null;
  recipient_state: string | null; place_of_supply: string | null; sac_code: string | null;
}

/**
 * Putting right an invoice the client already has.
 *
 * A sent invoice is a legal document: it is never edited. What it should have
 * said is worked out line by line at the rate now in force for each day (and
 * the attendance as it stands), and only the difference is settled:
 *   - client billed too much  → a credit note for the difference, tax included
 *   - client billed too little → a supplementary invoice (DRAFT) for it
 *   - staff paid too little   → arrears, added to their next salary slip
 *   - staff paid too much     → recorded; salary is never taken back
 *
 * Each correction records its lines, so a second one settles only what the
 * first did not.
 */
@Injectable()
export class SentInvoiceCorrectionService {
  private readonly logger = new Logger(SentInvoiceCorrectionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly payroll: PayrollService,
    private readonly creditNotes: CreditNoteService,
    private readonly notifications: NotificationsService,
  ) {}

  private async head(invoiceId: string): Promise<InvoiceHead> {
    const rows = await this.dataSource.query(
      `SELECT id, invoice_number, status, client_id, period_month, period_year, period_from, period_to,
              taxable_value, gst_amount, igst_amount, document_type, supplier_gstin, supplier_state,
              recipient_gstin, recipient_state, place_of_supply, sac_code
         FROM client_invoices WHERE id = $1`,
      [invoiceId],
    ) as InvoiceHead[];
    const inv = rows[0];
    if (!inv) throw new NotFoundException(`Invoice ${invoiceId} not found`);
    if (!CORRECTABLE.includes(inv.status)) {
      throw new BadRequestException(
        inv.status === 'DRAFT' || inv.status === 'APPROVED'
          ? `${inv.invoice_number} has not been sent yet — reject it instead; the corrected invoice is raised fresh.`
          : `${inv.invoice_number} is ${inv.status} and cannot be corrected.`,
      );
    }
    return inv;
  }

  /** What the invoice should have said, line by line, and the difference. Changes nothing. */
  async preview(invoiceId: string) {
    const inv = await this.head(invoiceId);
    const rows = await this.dataSource.query(
      `SELECT pr.id, pr.placement_id, pr.staff_id, sa.full_name AS staff_name, pr.period_month, pr.period_year,
              pr.period_from::text AS period_from, pr.period_to::text AS period_to,
              pr.gross_salary, pr.esic_employer, pr.pf_employer, pr.management_fee, pr.net_salary, pr.arrears
         FROM payroll_records pr JOIN staff_applicants sa ON sa.id = pr.staff_id
        WHERE pr.client_invoice_id = $1
        ORDER BY sa.full_name, pr.period_from`,
      [invoiceId],
    ) as {
      id: string; placement_id: string; staff_id: string; staff_name: string; period_month: number; period_year: number;
      period_from: string; period_to: string; gross_salary: string; esic_employer: string; pf_employer: string;
      management_fee: string | null; net_salary: string; arrears: string | null;
    }[];
    if (!rows.length) throw new BadRequestException(`${inv.invoice_number} bills no payroll — there is nothing to recompute.`);

    // What earlier corrections already settled. Client side: credit notes and
    // supplementary invoices are real money, so they move what was billed.
    // Staff side: arrears are real money paid; an overpayment recorded as
    // absorbed is not — nothing was taken back — so it never lowers what the
    // staff member actually received, it only stops being recorded twice.
    const prior = await this.dataSource.query(
      `SELECT payroll_id,
              COALESCE(SUM(client_delta), 0)::float AS c,
              COALESCE(SUM(staff_delta) FILTER (WHERE staff_delta > 0), 0)::float AS arrears,
              COALESCE(-SUM(staff_delta) FILTER (WHERE staff_delta < 0), 0)::float AS absorbed
         FROM invoice_correction_lines WHERE payroll_id = ANY($1::uuid[]) GROUP BY payroll_id`,
      [rows.map((r) => r.id)],
    ) as { payroll_id: string; c: number; arrears: number; absorbed: number }[];
    const priorOf = new Map(prior.map((p) => [p.payroll_id, p]));

    const lines: CorrectionLine[] = [];
    for (const r of rows) {
      const n = (v: unknown) => Number(v ?? 0);
      const billedBefore = round2(n(r.gross_salary) + n(r.esic_employer) + n(r.pf_employer) + n(r.management_fee) + (priorOf.get(r.id)?.c ?? 0));
      // What the staff member actually received for these days: the row's net
      // (less any arrears for other periods riding on it) plus arrears already
      // owed to them by earlier corrections of this row.
      const paidBefore = round2(n(r.net_salary) - n(r.arrears) + (priorOf.get(r.id)?.arrears ?? 0));
      const alreadyAbsorbed = priorOf.get(r.id)?.absorbed ?? 0;
      let billedAfter = 0;
      let paidAfter = 0;
      let rate: number | null = null;
      try {
        const p = await this.payroll.previewAttendancePayroll(
          r.placement_id, r.period_month, r.period_year, { from: r.period_from, to: r.period_to },
        );
        const calc = p.calculation as { grossSalary: number; esicEmployer: number; pfEmployer: number; managementFee: number; netSalary: number };
        billedAfter = round2(calc.grossSalary + calc.esicEmployer + calc.pfEmployer + (p.prorated_management_fee ?? calc.managementFee));
        paidAfter = round2(calc.netSalary);
        rate = (p.duty_rate ?? p.hourly_rate ?? null) as number | null;
      } catch (e) {
        // No attendance left in those days: the line should not have been billed at all.
        if (!/^No |nothing/i.test((e as Error).message)) throw e;
      }
      lines.push({
        payroll_id: r.id,
        placement_id: r.placement_id,
        staff_id: r.staff_id,
        staff_name: r.staff_name,
        period: formatPeriod({ from: r.period_from, to: r.period_to }),
        rate_now: rate,
        billed_before: billedBefore,
        billed_after: billedAfter,
        client_delta: round2(billedAfter - billedBefore),
        paid_before: paidBefore,
        paid_after: paidAfter,
        staff_delta: staffDelta(paidAfter - paidBefore, alreadyAbsorbed),
      });
    }

    const taxable = Number(inv.taxable_value ?? 0);
    const gstRate = taxable > 0 ? Number(inv.gst_amount ?? 0) / taxable : 0;
    const clientDelta = round2(lines.reduce((s, l) => s + l.client_delta, 0));
    const gstDelta = round2(clientDelta * gstRate);
    const arrears = round2(lines.filter((l) => l.staff_delta > 0).reduce((s, l) => s + l.staff_delta, 0));
    const absorbed = round2(lines.filter((l) => l.staff_delta < 0).reduce((s, l) => s - l.staff_delta, 0));
    return {
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      invoice_status: inv.status,
      lines,
      totals: {
        client_delta: clientDelta,
        gst_delta: gstDelta,
        client_delta_with_gst: round2(clientDelta + gstDelta),
        staff_arrears: arrears,
        staff_overpaid_absorbed: absorbed,
      },
      actions: {
        credit_note: clientDelta < -PENNY ? round2(-(clientDelta + gstDelta)) : 0,
        supplementary_invoice: clientDelta > PENNY ? round2(clientDelta + gstDelta) : 0,
        arrears_to_pay: arrears,
        overpayment_recorded: absorbed,
      },
      nothing_to_correct: lines.every((l) => Math.abs(l.client_delta) < PENNY && Math.abs(l.staff_delta) < PENNY),
    };
  }

  /** Settles the difference. Never edits the sent invoice, never takes salary back. */
  async apply(invoiceId: string, reason: string | undefined, actorId?: string) {
    const text = String(reason ?? '').trim();
    if (text.length < 10) {
      throw new BadRequestException('Write why this invoice is being corrected (at least 10 characters) — it goes on the credit note or supplementary invoice.');
    }
    const p = await this.preview(invoiceId);
    if (p.nothing_to_correct) {
      throw new BadRequestException(
        `${p.invoice_number} already matches today's rates and attendance — there is nothing to correct. ` +
          `Change the rate on the placement first (back-dated to the period), then correct.`,
      );
    }
    // Check the credit note will go through before recording anything.
    if (p.actions.credit_note > 0) {
      await this.creditNotes.preview(invoiceId, p.actions.credit_note, { allowPaid: true });
    }

    const inv = await this.head(invoiceId);
    const correction = await this.dataSource.transaction(async (m) => {
      const [c] = await m.query(
        `INSERT INTO invoice_corrections (invoice_id, reason, client_delta, gst_delta, staff_delta, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [invoiceId, text, p.totals.client_delta, p.totals.gst_delta,
          round2(p.totals.staff_arrears - p.totals.staff_overpaid_absorbed), actorId ?? null],
      ) as { id: string }[];
      for (const l of p.lines) {
        if (Math.abs(l.client_delta) < PENNY && Math.abs(l.staff_delta) < PENNY) continue;
        await m.query(
          `INSERT INTO invoice_correction_lines
             (correction_id, payroll_id, placement_id, staff_id, billed_before, billed_after, paid_before, paid_after,
              client_delta, staff_delta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [c.id, l.payroll_id, l.placement_id, l.staff_id, l.billed_before, l.billed_after,
            l.paid_before, l.paid_after, l.client_delta, l.staff_delta],
        );
        if (Math.abs(l.staff_delta) >= PENNY) {
          await m.query(
            `INSERT INTO pay_adjustments
               (staff_id, placement_id, amount, kind, status, reason, correction_id, source_payroll_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [l.staff_id, l.placement_id, Math.abs(l.staff_delta),
              l.staff_delta > 0 ? 'ARREARS' : 'ABSORBED', l.staff_delta > 0 ? 'PENDING' : 'RECORDED',
              `${p.invoice_number} ${l.period}: ${text}`, c.id, l.payroll_id, actorId ?? null],
          );
        }
      }
      let supplementary: { id: string; invoice_number: string } | null = null;
      if (p.actions.supplementary_invoice > 0) {
        supplementary = await this.raiseSupplementary(m, inv, p, text);
        await m.query(`UPDATE invoice_corrections SET supplementary_invoice_id = $2 WHERE id = $1`, [c.id, supplementary.id]);
      }
      return { id: c.id, supplementary };
    });

    let creditNote: { credit_note_number: string; credit_amount: number } | null = null;
    if (p.actions.credit_note > 0) {
      const cn = await this.creditNotes.issue(
        invoiceId, `Correction: ${text}`, p.actions.credit_note, actorId, { allowPaid: true },
      );
      creditNote = { credit_note_number: cn.credit_note_number, credit_amount: cn.credit_amount };
      await this.dataSource.query(
        `UPDATE invoice_corrections SET credit_note_id = $2 WHERE id = $1`,
        [correction.id, (cn.credit_note as { id?: string })?.id ?? null],
      );
    }

    await this.tellStaff(p.lines.filter((l) => l.staff_delta >= PENNY), p.invoice_number);
    this.logger.warn(
      `[INVOICE_CORRECTED] ${p.invoice_number} by ${actorId ?? 'unknown'}: client ${p.totals.client_delta_with_gst}, ` +
        `arrears ${p.totals.staff_arrears}, absorbed ${p.totals.staff_overpaid_absorbed} — ${text}`,
    );
    return {
      correction_id: correction.id,
      invoice_number: p.invoice_number,
      credit_note: creditNote,
      supplementary_invoice: correction.supplementary,
      arrears_pending: p.totals.staff_arrears,
      overpayment_recorded: p.totals.staff_overpaid_absorbed,
      lines: p.lines,
    };
  }

  /**
   * A supplementary invoice for what was under-billed: its own number from the
   * client's series, the same tax treatment as the original, and DRAFT — it
   * goes through Finance's approval like any other invoice.
   */
  private async raiseSupplementary(
    m: EntityManager, inv: InvoiceHead, p: Awaited<ReturnType<SentInvoiceCorrectionService['preview']>>, reason: string,
  ) {
    const seqResult = await m.query(
      `UPDATE finance_customers SET bill_seq = bill_seq + 1 WHERE id = $1 RETURNING bill_no_prefix, bill_seq`,
      [inv.client_id],
    );
    const cust = ((Array.isArray(seqResult[0]) ? seqResult[0] : seqResult) as { bill_no_prefix: string; bill_seq: number }[])[0];
    if (!cust?.bill_no_prefix) throw new BadRequestException('Could not reserve an invoice number for the supplementary invoice.');
    let seq = cust.bill_seq;
    let number = formatInvoiceNumber(cust.bill_no_prefix, seq);
    for (let guard = 0; guard < 1000; guard++) {
      const taken = await m.query(`SELECT 1 FROM client_invoices WHERE invoice_number = $1 LIMIT 1`, [number]);
      if (!taken.length) break;
      seq += 1;
      number = formatInvoiceNumber(cust.bill_no_prefix, seq);
    }
    if (seq !== cust.bill_seq) await m.query(`UPDATE finance_customers SET bill_seq = $1 WHERE id = $2`, [seq, inv.client_id]);

    const taxable = p.totals.client_delta;
    const gst = p.totals.gst_delta;
    const interState = Number(inv.igst_amount ?? 0) > 0;
    const cgst = interState ? 0 : round2(gst / 2);
    const sgst = interState ? 0 : round2(gst - cgst);
    const igst = interState ? gst : 0;
    const due = new Date();
    due.setUTCDate(due.getUTCDate() + 5);

    const res = await m.query(
      `INSERT INTO client_invoices
         (id, placement_id, client_id, invoice_number, invoice_seq, period_month, period_year,
          staff_salary_component, management_fee, gst_amount, esic_employer, pf_employer,
          total_amount, due_date, status, is_consolidated, document_type,
          supplier_gstin, supplier_state, recipient_gstin, recipient_state,
          place_of_supply, sac_code, taxable_value, cgst_amount, sgst_amount, igst_amount,
          period_from, period_to, payment_ref)
       VALUES (gen_random_uuid(), NULL, $1,$2,$3,$4,$5, $6, 0, $7, 0, 0, $8, $9::date, 'DRAFT', false, $10,
               $11,$12,$13,$14,$15,$16, $6, $17,$18,$19, $20::date, $21::date, $22)
       RETURNING id, invoice_number`,
      [
        inv.client_id, number, seq, inv.period_month, inv.period_year,
        taxable, gst, round2(taxable + gst), isoDate(due),
        inv.document_type ?? 'TAX_INVOICE',
        inv.supplier_gstin, inv.supplier_state, inv.recipient_gstin, inv.recipient_state,
        inv.place_of_supply, inv.sac_code, cgst, sgst, igst,
        isoDate(inv.period_from), isoDate(inv.period_to), `supplementary to ${inv.invoice_number}`,
      ],
    );
    const created = ((Array.isArray(res[0]) ? res[0] : res) as { id: string; invoice_number: string }[])[0];

    let order = 0;
    for (const l of p.lines.filter((x) => Math.abs(x.client_delta) >= PENNY)) {
      await m.query(
        `INSERT INTO invoice_items (id, invoice_id, description, amount, is_taxable, staff_id, staff_name, placement_id, sac_code, sort_order)
         VALUES (gen_random_uuid(), $1, $2, $3, true, $4, $5, $6, $7, $8)`,
        [created.id, `${l.staff_name} — correction of ${inv.invoice_number}, ${l.period}: ${reason}`,
          l.client_delta, l.staff_id, l.staff_name, l.placement_id, inv.sac_code, order++],
      );
    }
    if (gst > 0) {
      await m.query(
        `INSERT INTO invoice_items (id, invoice_id, description, amount, is_taxable, sort_order)
         VALUES (gen_random_uuid(), $1, $2, $3, false, $4)`,
        [created.id, interState ? 'IGST' : 'CGST + SGST', gst, order++],
      );
    }
    return created;
  }

  private async tellStaff(lines: { staff_id: string; staff_delta: number }[], invoiceNumber: string) {
    if (!lines.length) return;
    const users = await this.dataSource.query(
      `SELECT id, user_id FROM staff_applicants WHERE id = ANY($1::uuid[]) AND user_id IS NOT NULL`,
      [lines.map((l) => l.staff_id)],
    ) as { id: string; user_id: string }[];
    for (const u of users) {
      const owed = round2(lines.filter((l) => l.staff_id === u.id).reduce((s, l) => s + l.staff_delta, 0));
      await this.notifications
        .createInAppNotification(
          'Arrears on your next salary',
          `You were paid ₹${owed.toLocaleString('en-IN')} less than you should have been (${invoiceNumber}). ` +
            `It will be added to your next salary slip as arrears.`,
          u.user_id,
        )
        .catch(() => undefined);
    }
  }

  /** Corrections made to an invoice, with their lines. */
  async history(invoiceId: string) {
    return this.dataSource.query(
      `SELECT c.id, c.reason, c.client_delta, c.gst_delta, c.staff_delta, c.created_at,
              u.full_name AS created_by_name, cn.credit_note_number, si.invoice_number AS supplementary_invoice_number,
              (SELECT json_agg(json_build_object(
                         'staff_name', sa.full_name, 'billed_before', l.billed_before, 'billed_after', l.billed_after,
                         'paid_before', l.paid_before, 'paid_after', l.paid_after,
                         'client_delta', l.client_delta, 'staff_delta', l.staff_delta))
                 FROM invoice_correction_lines l JOIN staff_applicants sa ON sa.id = l.staff_id
                WHERE l.correction_id = c.id) AS lines
         FROM invoice_corrections c
         LEFT JOIN users u ON u.id = c.created_by
         LEFT JOIN credit_notes cn ON cn.id = c.credit_note_id
         LEFT JOIN client_invoices si ON si.id = c.supplementary_invoice_id
        WHERE c.invoice_id = $1
        ORDER BY c.created_at DESC`,
      [invoiceId],
    );
  }

  /** Arrears and recorded overpayments, newest first — Finance's view of what is owed or was absorbed. */
  async adjustments(status?: string) {
    return this.dataSource.query(
      `SELECT a.id, a.kind, a.status, a.amount, a.reason, a.created_at, a.applied_at,
              sa.full_name AS staff_name, sa.staff_code, pr.period_month AS applied_month, pr.period_year AS applied_year
         FROM pay_adjustments a
         JOIN staff_applicants sa ON sa.id = a.staff_id
         LEFT JOIN payroll_records pr ON pr.id = a.applied_payroll_id
        WHERE ($1::text IS NULL OR a.status = $1)
        ORDER BY a.created_at DESC`,
      [status ?? null],
    );
  }
}
