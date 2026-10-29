import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { NotificationsService } from '../../notifications/notifications.service';
import { PayrollService } from '../../payroll/payroll.service';
import { ConsolidatedInvoiceService } from './consolidated-invoice.service';
import { FinanceInvoiceService } from './invoice.service';
import { formatPeriod, isoDate } from '../../../common/finance/period.util';
import { unlockMusterRollForInvoice } from '../../muster-roll/muster-roll-lock';

type VoidSource = 'REJECT' | 'CANCEL' | 'RERUN';

const MIN_REASON = 10;

/**
 * Putting a wrong figure right before it reaches anyone.
 *
 * An invoice built on a wrong rate used to be a dead end: cancelling it left
 * its payroll rows at the wrong rate, so generating again produced the same
 * wrong invoice; and a payroll row, once written, blocked its period for good,
 * so it could not be re-run either.
 *
 * Here a wrong row is voided — moved whole into payroll_records_voided with
 * who, when and why — and the period is free to be run again at today's rate.
 * Nothing that reads payroll can count a voided row, and nothing is lost.
 *
 * Salary is never clawed back, so a row that has been paid is never voided;
 * that correction is a credit note.
 */
@Injectable()
export class InvoiceCorrectionService {
  private readonly logger = new Logger(InvoiceCorrectionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly payroll: PayrollService,
    private readonly consolidated: ConsolidatedInvoiceService,
    private readonly invoices: FinanceInvoiceService,
  ) {}

  private static reasonOrThrow(reason: string | undefined, what: string) {
    const text = String(reason ?? '').trim();
    if (text.length < MIN_REASON) {
      throw new BadRequestException(`Write why you are ${what} (at least ${MIN_REASON} characters) — it is kept on the record.`);
    }
    return text;
  }

  /**
   * Refuses rows that cannot be voided:
   *  - paid out (or a payout in flight): salary is never taken back;
   *  - followed by a later payroll row of the same placement in the same
   *    month: ESIC and PF are trued up month-to-date per placement, so a
   *    later row subtracted this one. Undo the later one first. Another
   *    client's row does not depend on this one — its share is worked out
   *    from attendance, not from these rows — so it does not block.
   */
  private async assertVoidable(m: EntityManager | DataSource, ids: string[]) {
    if (!ids.length) return;
    const paid = await m.query(
      `SELECT sa.full_name, pr.period_from, pr.period_to, pr.disbursement_ref
         FROM payroll_records pr JOIN staff_applicants sa ON sa.id = pr.staff_id
        WHERE pr.id = ANY($1::uuid[])
          AND (pr.disbursed_at IS NOT NULL OR pr.disbursement_status IN ('PROCESSING','PAID'))
        LIMIT 1`,
      [ids],
    ) as { full_name: string; period_from: unknown; period_to: unknown; disbursement_ref: string | null }[];
    if (paid.length) {
      const p = paid[0];
      throw new BadRequestException(
        `${p.full_name}'s salary for ${formatPeriod({ from: isoDate(p.period_from)!, to: isoDate(p.period_to)! })} ` +
          `has already been paid${p.disbursement_ref ? ` (${p.disbursement_ref})` : ''}. A paid salary is never taken back — ` +
          `correct the invoice with a credit note instead.`,
      );
    }

    const later = await m.query(
      `SELECT sa.full_name, l.period_from, l.period_to, fc.customer_name, ci.invoice_number
         FROM payroll_records pr
         JOIN payroll_records l
           ON l.placement_id = pr.placement_id AND l.period_month = pr.period_month AND l.period_year = pr.period_year
          AND l.period_from > pr.period_to
          AND NOT (l.id = ANY($1::uuid[]))
         JOIN staff_applicants sa ON sa.id = l.staff_id
         JOIN placements p ON p.id = l.placement_id
         LEFT JOIN finance_customers fc ON fc.id = p.client_id
         LEFT JOIN client_invoices ci ON ci.id = l.client_invoice_id
        WHERE pr.id = ANY($1::uuid[])
        ORDER BY l.period_from
        LIMIT 1`,
      [ids],
    ) as { full_name: string; period_from: unknown; period_to: unknown; customer_name: string | null; invoice_number: string | null }[];
    if (later.length) {
      const l = later[0];
      throw new BadRequestException(
        `${l.full_name} already has later payroll at this client this month — ` +
          `${formatPeriod({ from: isoDate(l.period_from)!, to: isoDate(l.period_to)! })} at ${l.customer_name ?? 'another client'}` +
          `${l.invoice_number ? ` (invoice ${l.invoice_number})` : ''}. ESIC and PF for the month are worked out in order, ` +
          `so undo that one first.`,
      );
    }
  }

  /** Moves rows into payroll_records_voided, whole, and out of payroll_records. */
  private async voidRows(
    m: EntityManager, ids: string[], source: VoidSource, reason: string, actorId?: string | null,
  ) {
    if (!ids.length) return 0;
    await m.query(
      `INSERT INTO payroll_records_voided
         (payroll_id, placement_id, staff_id, period_month, period_year, period_from, period_to,
          client_invoice_id, invoice_number, gross_salary, net_salary, row,
          void_source, void_reason, voided_by)
       SELECT pr.id, pr.placement_id, pr.staff_id, pr.period_month, pr.period_year, pr.period_from, pr.period_to,
              pr.client_invoice_id, ci.invoice_number, pr.gross_salary, pr.net_salary, to_jsonb(pr),
              $2, $3, $4
         FROM payroll_records pr
         LEFT JOIN client_invoices ci ON ci.id = pr.client_invoice_id
        WHERE pr.id = ANY($1::uuid[])`,
      [ids, source, reason, actorId ?? null],
    );
    // Arrears that rode on a voided row go back to waiting for the next one.
    await m.query(
      `UPDATE pay_adjustments SET status = 'PENDING', applied_payroll_id = NULL, applied_at = NULL
        WHERE applied_payroll_id = ANY($1::uuid[]) AND status = 'APPLIED'`,
      [ids],
    ).catch(() => undefined);
    await m.query(`DELETE FROM payroll_records WHERE id = ANY($1::uuid[])`, [ids]);
    return ids.length;
  }

  /**
   * Finance sends an unsent invoice back: it is cancelled, its payroll voided,
   * and every placement on it waits for the RM to confirm or correct the rate
   * before the client can be invoiced again. With `flagForReview` false (a
   * plain cancel) the payroll is still voided — a cancelled invoice's rows at
   * the old figures would otherwise be billed again unchanged.
   */
  async rejectUnsent(
    invoiceId: string, reason: string | undefined, actorId?: string,
    opts: { flagForReview: boolean } = { flagForReview: true },
  ) {
    const source: VoidSource = opts.flagForReview ? 'REJECT' : 'CANCEL';
    // A rejection needs a real reason — it goes to the RM. A cancel keeps the
    // rule it always had: a reason, any reason.
    const text = opts.flagForReview
      ? InvoiceCorrectionService.reasonOrThrow(reason, 'rejecting this invoice')
      : String(reason ?? '').trim();
    if (!text) throw new BadRequestException('A reason is required to cancel an invoice.');

    const out = await this.dataSource.transaction(async (m) => {
      const rows = await m.query(
        `SELECT ci.id, ci.invoice_number, ci.status, ci.client_id, ci.period_month, ci.period_year,
                ci.period_from, ci.period_to, fc.customer_name
           FROM client_invoices ci LEFT JOIN finance_customers fc ON fc.id = ci.client_id
          WHERE ci.id = $1 FOR UPDATE OF ci`,
        [invoiceId],
      ) as {
        id: string; invoice_number: string; status: string; client_id: string; period_month: number;
        period_year: number; period_from: unknown; period_to: unknown; customer_name: string | null;
      }[];
      const inv = rows[0];
      if (!inv) throw new NotFoundException(`Invoice ${invoiceId} not found`);
      if (inv.status !== 'DRAFT' && inv.status !== 'APPROVED') {
        throw new BadRequestException(
          `${inv.invoice_number} is ${inv.status} — the client already has it, so it cannot be ` +
            `${opts.flagForReview ? 'rejected' : 'cancelled this way'}. Issue a credit note instead.`,
        );
      }

      // Only the last invoice of the month: the next one starts the day after
      // this one ends, and a gap behind it could never be billed again.
      const after = await m.query(
        `SELECT invoice_number, status FROM client_invoices
          WHERE client_id = $1 AND period_month = $2 AND period_year = $3 AND id <> $4
            AND is_consolidated AND status <> 'CANCELLED' AND period_from > $5::date
          ORDER BY period_from LIMIT 1`,
        [inv.client_id, inv.period_month, inv.period_year, inv.id, isoDate(inv.period_to)],
      ) as { invoice_number: string; status: string }[];
      if (after.length) {
        throw new BadRequestException(
          `${after[0].invoice_number} (${after[0].status}) comes after ${inv.invoice_number} this month. ` +
            `Only the latest invoice of a month can be ${opts.flagForReview ? 'rejected' : 'cancelled'} — undo ${after[0].invoice_number} first.`,
        );
      }

      const payrollIds = (await m.query(
        `SELECT id FROM payroll_records WHERE client_invoice_id = $1`, [inv.id],
      ) as { id: string }[]).map((r) => r.id);
      await this.assertVoidable(m, payrollIds);

      const placements = await m.query(
        `SELECT DISTINCT p.id, p.rm_id, sa.full_name AS staff_name, sa.assigned_rm_id,
                p.metadata->>'staff_request_id' AS staff_request_id, sr.request_no
           FROM payroll_records pr
           JOIN placements p ON p.id = pr.placement_id
           JOIN staff_applicants sa ON sa.id = p.staff_id
           LEFT JOIN staff_requests sr ON sr.id::text = p.metadata->>'staff_request_id'
          WHERE pr.client_invoice_id = $1`,
        [inv.id],
      ) as { id: string; rm_id: string | null; staff_name: string; assigned_rm_id: string | null; staff_request_id: string | null; request_no: string | null }[];

      await m.query(
        `UPDATE client_invoices
            SET status = 'CANCELLED',
                rejected_at = CASE WHEN $4 THEN NOW() ELSE rejected_at END,
                rejected_by = CASE WHEN $4 THEN $2::uuid ELSE rejected_by END,
                reject_reason = CASE WHEN $4 THEN $3 ELSE reject_reason END,
                payment_ref = COALESCE(payment_ref, $5)
          WHERE id = $1`,
        [inv.id, actorId ?? null, text, opts.flagForReview,
          `${opts.flagForReview ? 'rejected' : 'cancelled'}: ${text.slice(0, 80)}`],
      );
      const voided = await this.voidRows(m, payrollIds, source, `${inv.invoice_number}: ${text}`, actorId);
      await unlockMusterRollForInvoice(m, inv.id);

      if (opts.flagForReview && placements.length) {
        await m.query(
          `UPDATE placements
              SET rate_review_status = 'REVIEW_NEEDED', rate_review_reason = $2, rate_review_at = NOW(),
                  rate_review_invoice_id = $3, rate_review_by = $4
            WHERE id = ANY($1::uuid[])`,
          [placements.map((p) => p.id), text, inv.id, actorId ?? null],
        );
      }
      return { inv, voided, placements };
    });

    if (opts.flagForReview) {
      for (const p of out.placements) {
        const rm = p.rm_id ?? p.assigned_rm_id;
        if (!rm) continue;
        await this.notifications
          .createInAppNotification(
            'Invoice rejected — check the rate',
            `Finance rejected invoice ${out.inv.invoice_number} for ${out.inv.customer_name ?? 'the client'}: "${text}". ` +
              `Check the rate on ${p.staff_name}'s placement${p.request_no ? ` (request ${p.request_no})` : ''} and ` +
              `correct or confirm it — the client cannot be invoiced again until you do.`,
            rm,
          )
          .catch((e: Error) => this.logger.warn(`rate-review note to RM ${rm}: ${e.message}`));
      }
    }
    this.logger.warn(
      `[INVOICE_${source}] ${out.inv.invoice_number} by ${actorId ?? 'unknown'} — ${out.voided} payroll row(s) voided, ` +
        `${opts.flagForReview ? out.placements.length : 0} placement(s) sent for rate review: ${text}`,
    );
    return {
      id: invoiceId,
      invoice_number: out.inv.invoice_number,
      status: 'CANCELLED' as const,
      reason: text,
      payroll_voided: out.voided,
      placements_for_review: opts.flagForReview
        ? out.placements.map((p) => ({ placement_id: p.id, staff_name: p.staff_name, request_no: p.request_no }))
        : [],
    };
  }

  /**
   * Cancel. An unsent invoice is cancelled like a rejection without the rate
   * review: its payroll is voided, so the next invoice is built from today's
   * figures rather than the cancelled ones. A sent invoice keeps the old path —
   * the payroll is handed back unchanged and the correction is a credit note.
   */
  async cancel(invoiceId: string, reason: string | undefined, actorId?: string) {
    const rows = await this.dataSource.query(
      `SELECT status FROM client_invoices WHERE id = $1`, [invoiceId],
    ) as { status: string }[];
    if (rows[0] && (rows[0].status === 'DRAFT' || rows[0].status === 'APPROVED')) {
      return this.rejectUnsent(invoiceId, reason, actorId, { flagForReview: false });
    }
    return this.invoices.cancelInvoice(invoiceId, reason ?? '');
  }

  /**
   * Re-runs one payroll row at the placement's current rate and attendance.
   *
   * The row is voided and the period run again; if it was on a DRAFT invoice,
   * the invoice is rebuilt in place, keeping its number. A row on an approved
   * invoice is already a payslip — reject the invoice instead.
   */
  async rerunPayroll(payrollId: string, reason: string | undefined, actorId?: string) {
    const text = String(reason ?? '').trim() || 'payroll re-run after a correction';
    const rows = await this.dataSource.query(
      `SELECT pr.id, pr.placement_id, pr.period_month, pr.period_year, pr.period_from, pr.period_to,
              pr.released_at, pr.gross_salary, pr.net_salary, pr.client_invoice_id,
              ci.invoice_number, ci.status AS invoice_status
         FROM payroll_records pr LEFT JOIN client_invoices ci ON ci.id = pr.client_invoice_id
        WHERE pr.id = $1`,
      [payrollId],
    ) as {
      id: string; placement_id: string; period_month: number; period_year: number; period_from: unknown;
      period_to: unknown; released_at: Date | null; gross_salary: string; net_salary: string;
      client_invoice_id: string | null; invoice_number: string | null; invoice_status: string | null;
    }[];
    const r = rows[0];
    if (!r) throw new NotFoundException(`Payroll record ${payrollId} not found`);
    if (r.invoice_status && r.invoice_status !== 'DRAFT') {
      throw new BadRequestException(
        `This payroll is on invoice ${r.invoice_number}, which is ${r.invoice_status}. ` +
          (r.invoice_status === 'APPROVED'
            ? 'Reject the invoice instead — that voids its payroll and sends the rate back to the RM.'
            : 'The client has it — correct it with a credit note.'),
      );
    }
    if (r.released_at) {
      throw new BadRequestException(
        'This salary slip has already been released to the staff member, so it cannot be re-run.',
      );
    }
    await this.assertVoidable(this.dataSource, [r.id]);

    const period = { from: isoDate(r.period_from)!, to: isoDate(r.period_to)! };
    // Make sure the re-run has something to pay before taking the old row away.
    const preview = await this.payroll.previewAttendancePayroll(r.placement_id, r.period_month, r.period_year, period);
    const billable = preview.rate_basis === 'PER_DUTY'
      ? Number(preview.duties) > 0
      : preview.rate_basis === 'HOURLY' ? preview.hours_worked > 0 : preview.billable_days > 0;
    if (!billable) {
      throw new BadRequestException(
        `There is nothing to pay for ${formatPeriod(period)} any more — attendance for those days has been removed. ` +
          (r.invoice_number ? `Reject invoice ${r.invoice_number} instead.` : 'Leave it, or ask Finance to cancel it.'),
      );
    }

    await this.dataSource.transaction((m) => this.voidRows(m, [r.id], 'RERUN', text, actorId));

    let invoice: Record<string, unknown> | null = null;
    if (r.client_invoice_id) {
      const rebuilt = await this.consolidated.recalculate(r.client_invoice_id, actorId);
      invoice = rebuilt.invoice;
    } else {
      await this.payroll.runPayrollForPeriod(r.placement_id, r.period_month, r.period_year, period.to);
    }
    const fresh = await this.dataSource.query(
      `SELECT id, gross_salary, net_salary FROM payroll_records
        WHERE placement_id = $1 AND period_month = $2 AND period_year = $3 AND period_to = $4::date`,
      [r.placement_id, r.period_month, r.period_year, period.to],
    ) as { id: string; gross_salary: string; net_salary: string }[];

    this.logger.log(`[PAYROLL_RERUN] ${payrollId} → ${fresh[0]?.id ?? 'none'} by ${actorId ?? 'unknown'}: ${text}`);
    return {
      voided_payroll_id: payrollId,
      payroll: fresh[0] ?? null,
      before: { gross_salary: Number(r.gross_salary), net_salary: Number(r.net_salary) },
      after: fresh[0] ? { gross_salary: Number(fresh[0].gross_salary), net_salary: Number(fresh[0].net_salary) } : null,
      invoice_rebuilt: invoice ? { id: invoice.id, invoice_number: invoice.invoice_number, total_amount: invoice.total_amount } : null,
    };
  }

  /**
   * What a rate change applying from `from` would touch: every live payroll
   * row of the placement that covers a day on or after it. Refused (with the
   * reason) when any of those is already past Finance — an approved invoice
   * is rejected first, a sent one is corrected with a credit note — or when
   * voiding them would break the month-to-date order.
   */
  async rateChangeImpact(placementId: string, from: string) {
    const rows = await this.dataSource.query(
      `SELECT pr.id, pr.period_month, pr.period_year, pr.period_from::text AS period_from,
              pr.period_to::text AS period_to, pr.released_at, pr.client_invoice_id,
              ci.invoice_number, ci.status AS invoice_status
         FROM payroll_records pr
         LEFT JOIN client_invoices ci ON ci.id = pr.client_invoice_id
        WHERE pr.placement_id = $1 AND pr.period_to >= $2::date
        ORDER BY pr.period_from`,
      [placementId, from],
    ) as {
      id: string; period_month: number; period_year: number; period_from: string; period_to: string;
      released_at: Date | null; client_invoice_id: string | null; invoice_number: string | null; invoice_status: string | null;
    }[];
    // Rows on an invoice the client already has stay exactly as billed — the
    // change is settled by correcting that invoice (credit note / supplementary
    // invoice / arrears), which reads the rate now in force. They are reported,
    // not re-run.
    const SENT = ['SENT', 'PARTIALLY_PAID', 'OVERDUE', 'PAID'];
    const settled = rows.filter((r) => r.invoice_status && SENT.includes(r.invoice_status));
    const open = rows.filter((r) => !settled.includes(r));
    const past = open.find((r) => r.released_at || (r.invoice_status && r.invoice_status !== 'DRAFT'));
    if (past) {
      const span = formatPeriod({ from: past.period_from, to: past.period_to });
      const after = past.period_to;
      throw new BadRequestException(
        past.invoice_number
          ? `${span} is on invoice ${past.invoice_number}, already approved by Finance. Ask Finance to reject it ` +
              `first, or make the change from the day after ${after}.`
          : `The salary slip for ${span} has already been released. Make the change from the day after ${after}.`,
      );
    }
    await this.assertVoidable(this.dataSource, open.map((r) => r.id));
    return Object.assign(open, {
      invoicesToCorrect: [...new Set(settled.map((r) => r.invoice_number).filter(Boolean))] as string[],
    });
  }

  /**
   * After a rate change: the rows it touched are voided and run again at the
   * rate now in force on each day — draft invoices rebuilt in place, keeping
   * their numbers. Oldest first, so month-to-date ESIC/PF builds up in order.
   */
  async reapplyAfterRateChange(
    placementId: string,
    rows: Awaited<ReturnType<InvoiceCorrectionService['rateChangeImpact']>>,
    reason: string,
    actorId?: string,
  ) {
    if (!rows.length) return [];
    await this.dataSource.transaction((m) => this.voidRows(m, rows.map((r) => r.id), 'RERUN', reason, actorId));
    const done = new Set<string>();
    // The rate is already saved; a stretch that cannot be re-run at it (a
    // billing rate below pay + PF, say) is reported, not allowed to fail the
    // whole change after the fact.
    const rebuilt: { invoice_number: string | null; period: string; error?: string }[] = [];
    for (const r of rows) {
      const period = formatPeriod({ from: r.period_from, to: r.period_to });
      if (r.client_invoice_id) {
        if (done.has(r.client_invoice_id)) continue;
        done.add(r.client_invoice_id);
        try {
          await this.consolidated.recalculate(r.client_invoice_id, actorId);
          rebuilt.push({ invoice_number: r.invoice_number, period });
        } catch (e) {
          rebuilt.push({
            invoice_number: r.invoice_number, period,
            error: `${(e as Error).message} — invoice ${r.invoice_number} could not be rebuilt; Finance should reject it.`,
          });
        }
      } else {
        try {
          await this.payroll.runPayrollForPeriod(placementId, r.period_month, r.period_year, r.period_to);
          rebuilt.push({ invoice_number: null, period });
        } catch (e) {
          // Nothing left to pay in that stretch is fine.
          if (/^No (duties|hours|billable)|^Payroll already exists/.test((e as Error).message)) {
            rebuilt.push({ invoice_number: null, period });
          } else {
            rebuilt.push({ invoice_number: null, period, error: (e as Error).message });
          }
        }
      }
    }
    this.logger.log(`[RATE_CHANGE_REAPPLIED] placement ${placementId}: ${rows.length} row(s) re-run by ${actorId ?? 'unknown'}`);
    return rebuilt;
  }

  /** The payroll rows taken out of an invoice or a placement, newest first. */
  async voidedFor(params: { invoiceId?: string; placementId?: string }) {
    if (!params.invoiceId && !params.placementId) throw new BadRequestException('invoice_id or placement_id is required.');
    return this.dataSource.query(
      `SELECT v.payroll_id, v.placement_id, sa.full_name AS staff_name, v.period_from, v.period_to,
              v.invoice_number, v.gross_salary, v.net_salary, v.void_source, v.void_reason,
              v.voided_at, u.full_name AS voided_by_name,
              v.row->>'duty_rate' AS duty_rate, v.row->>'hourly_rate' AS hourly_rate
         FROM payroll_records_voided v
         JOIN staff_applicants sa ON sa.id = v.staff_id
         LEFT JOIN users u ON u.id = v.voided_by
        WHERE ($1::uuid IS NULL OR v.client_invoice_id = $1) AND ($2::uuid IS NULL OR v.placement_id = $2)
        ORDER BY v.voided_at DESC`,
      [params.invoiceId ?? null, params.placementId ?? null],
    );
  }
}
