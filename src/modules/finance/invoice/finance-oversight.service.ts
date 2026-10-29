import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NotificationsService } from '../../notifications/notifications.service';
import { RELEASE_GRACE_DAYS } from '../../../common/finance/payroll-release';

/**
 * What is stuck, and the story of an invoice.
 *
 * The approval gate holds salary until Finance approves the invoice, and a
 * rejected invoice holds the client until the RM answers. Both are right —
 * and both are how money quietly stops moving if nobody looks. This is the
 * list someone looks at every morning.
 */
@Injectable()
export class FinanceOversightService {
  private readonly logger = new Logger(FinanceOversightService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  async attention() {
    const q = <T>(sql: string, params: unknown[] = []) =>
      this.dataSource.query(sql, params).catch((e: Error) => {
        this.logger.warn(`attention: ${e.message}`);
        return [] as T[];
      }) as Promise<T[]>;

    const [draftInvoices, heldSlips, rateReviews, sentRateChanged, arrears, readyToReinvoice, oldDisputes, unsignedRolls] = await Promise.all([
      // Salary waits on these: every day one sits in DRAFT is a day staff go unpaid.
      q<Record<string, unknown>>(
        `SELECT ci.id, ci.invoice_number, fc.customer_name, ci.total_amount, ci.created_at,
                (CURRENT_DATE - ci.created_at::date) AS days_waiting,
                (SELECT COUNT(*)::int FROM payroll_records pr WHERE pr.client_invoice_id = ci.id) AS staff_rows
           FROM client_invoices ci LEFT JOIN finance_customers fc ON fc.id = ci.client_id
          WHERE ci.status = 'DRAFT' AND ci.created_at < NOW() - make_interval(days => $1)
          ORDER BY ci.created_at`,
        [RELEASE_GRACE_DAYS],
      ),
      // Payroll not released past the grace period — the Admin release is open for these.
      q<Record<string, unknown>>(
        `SELECT pr.id AS payroll_id, sa.full_name AS staff_name, sa.staff_code, pr.period_month, pr.period_year,
                pr.net_salary, ci.invoice_number, ci.status AS invoice_status,
                (CURRENT_DATE - COALESCE(ci.created_at, pr.created_at)::date) AS days_waiting
           FROM payroll_records pr
           JOIN staff_applicants sa ON sa.id = pr.staff_id
           LEFT JOIN client_invoices ci ON ci.id = pr.client_invoice_id
          WHERE pr.released_at IS NULL
            AND COALESCE(ci.created_at, pr.created_at) < NOW() - make_interval(days => $1)
          ORDER BY COALESCE(ci.created_at, pr.created_at)`,
        [RELEASE_GRACE_DAYS],
      ),
      // The client cannot be invoiced until the RM answers.
      q<Record<string, unknown>>(
        `SELECT p.id AS placement_id, sa.full_name AS staff_name, fc.customer_name, p.rate_review_reason,
                p.rate_review_at, ci.invoice_number, u.full_name AS rm_name, p.rm_id,
                (CURRENT_DATE - p.rate_review_at::date) AS days_waiting
           FROM placements p
           JOIN staff_applicants sa ON sa.id = p.staff_id
           LEFT JOIN finance_customers fc ON fc.id = p.client_id
           LEFT JOIN client_invoices ci ON ci.id = p.rate_review_invoice_id
           LEFT JOIN users u ON u.id = p.rm_id
          WHERE p.rate_review_status = 'REVIEW_NEEDED'
          ORDER BY p.rate_review_at`,
      ),
      // A rate changed, back-dated over days the client was already invoiced
      // for, and the invoice has not been corrected since.
      q<Record<string, unknown>>(
        `SELECT DISTINCT ON (ci.id) ci.id, ci.invoice_number, ci.status, fc.customer_name, sa.full_name AS staff_name,
                c.effective_from::text AS effective_from, c.changed_at, c.reason
           FROM placement_rate_changes c
           JOIN payroll_records pr ON pr.placement_id = c.placement_id AND pr.period_to >= c.effective_from
           JOIN client_invoices ci ON ci.id = pr.client_invoice_id
           JOIN staff_applicants sa ON sa.id = pr.staff_id
           LEFT JOIN finance_customers fc ON fc.id = ci.client_id
          WHERE c.superseded_at IS NULL
            AND ci.status IN ('SENT','PARTIALLY_PAID','OVERDUE','PAID')
            AND c.changed_at > COALESCE(ci.approved_at, ci.created_at)
            AND NOT EXISTS (SELECT 1 FROM invoice_corrections ic WHERE ic.invoice_id = ci.id AND ic.created_at > c.changed_at)
          ORDER BY ci.id, c.changed_at DESC`,
      ),
      // Arrears owed and still waiting for a payroll row to ride on.
      q<Record<string, unknown>>(
        `SELECT a.id, sa.full_name AS staff_name, sa.staff_code, a.amount, a.reason, a.created_at,
                (CURRENT_DATE - a.created_at::date) AS days_waiting
           FROM pay_adjustments a JOIN staff_applicants sa ON sa.id = a.staff_id
          WHERE a.kind = 'ARREARS' AND a.status = 'PENDING'
          ORDER BY a.created_at`,
      ),
      // Rejected, every rate on it answered by the RM, and not raised again
      // yet: Finance can re-invoice the same days now.
      q<Record<string, unknown>>(
        `SELECT ci.id, ci.invoice_number, ci.client_id, fc.customer_name, ci.period_month, ci.period_year,
                ci.period_from::text AS period_from, ci.period_to::text AS period_to, ci.reject_reason, ci.rejected_at
           FROM client_invoices ci LEFT JOIN finance_customers fc ON fc.id = ci.client_id
          WHERE ci.status = 'CANCELLED' AND ci.rejected_at IS NOT NULL AND ci.is_consolidated
            AND NOT EXISTS (SELECT 1 FROM placements p
                             WHERE p.client_id = ci.client_id AND p.rate_review_status = 'REVIEW_NEEDED')
            AND NOT EXISTS (SELECT 1 FROM client_invoices n
                             WHERE n.client_id = ci.client_id AND n.is_consolidated
                               AND n.status <> 'CANCELLED' AND n.period_month = ci.period_month
                               AND n.period_year = ci.period_year AND n.period_to >= ci.period_to)
          ORDER BY ci.rejected_at DESC`,
      ),
      // Days the client disputed that the RM has not resolved in two days —
      // neither billed nor paid while they wait.
      q<Record<string, unknown>>(
        `SELECT sda.id, sda.attendance_date::text AS date, sa.full_name AS staff_name, sa.staff_code,
                fc.customer_name, sda.client_note, sda.client_action_at, u.full_name AS rm_name,
                (CURRENT_DATE - sda.client_action_at::date) AS days_waiting
           FROM staff_daily_attendance sda
           JOIN placements p ON p.id = sda.placement_id
           JOIN staff_applicants sa ON sa.id = sda.staff_id
           LEFT JOIN finance_customers fc ON fc.id = p.client_id
           LEFT JOIN users u ON u.id = COALESCE(p.rm_id, sa.assigned_rm_id)
          WHERE sda.client_status = 'DISPUTED' AND sda.client_action_at < NOW() - INTERVAL '48 hours'
          ORDER BY sda.client_action_at`,
      ),
      // Last month is over and the client's muster roll is not signed, where a
      // signed roll is the proof: paper clients, or days the RM marked by hand.
      q<Record<string, unknown>>(
        `WITH m AS (SELECT date_trunc('month', (NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 month')::date AS d)
         SELECT fc.id AS client_id, fc.customer_name, fc.attendance_proof_mode,
                EXTRACT(MONTH FROM m.d)::int AS period_month, EXTRACT(YEAR FROM m.d)::int AS period_year,
                COUNT(*)::int AS days, COUNT(*) FILTER (WHERE sda.source = 'RM')::int AS rm_days
           FROM m, staff_daily_attendance sda
           JOIN placements p ON p.id = sda.placement_id
           JOIN finance_customers fc ON fc.id = p.client_id
          WHERE sda.attendance_date >= m.d AND sda.attendance_date < (m.d + INTERVAL '1 month')
            AND NOT EXISTS (SELECT 1 FROM muster_rolls mr
                             WHERE mr.client_id = fc.id AND mr.status <> 'SUPERSEDED'
                               AND mr.period_month = EXTRACT(MONTH FROM m.d) AND mr.period_year = EXTRACT(YEAR FROM m.d))
          GROUP BY fc.id, fc.customer_name, fc.attendance_proof_mode, m.d
         HAVING fc.attendance_proof_mode IN ('PAPER', 'BOTH') OR COUNT(*) FILTER (WHERE sda.source = 'RM') > 0
          ORDER BY fc.customer_name`,
      ),
    ]);

    return {
      generated_at: new Date().toISOString(),
      draft_invoices_waiting: draftInvoices,
      slips_held: heldSlips,
      rate_reviews_open: rateReviews,
      sent_invoices_needing_correction: sentRateChanged,
      arrears_pending: arrears,
      ready_to_reinvoice: readyToReinvoice,
      disputes_unresolved: oldDisputes,
      muster_rolls_unsigned: unsignedRolls,
      counts: {
        draft_invoices_waiting: draftInvoices.length,
        slips_held: heldSlips.length,
        rate_reviews_open: rateReviews.length,
        sent_invoices_needing_correction: sentRateChanged.length,
        arrears_pending: arrears.length,
        ready_to_reinvoice: readyToReinvoice.length,
        disputes_unresolved: oldDisputes.length,
        muster_rolls_unsigned: unsignedRolls.length,
      },
    };
  }

  /**
   * The morning note: Finance gets the counts, each RM gets the rate reviews
   * waiting on them for more than a day. Nothing is sent when nothing is stuck.
   */
  async notifyDaily() {
    const a = await this.attention();
    const c = a.counts;
    const lines = [
      c.draft_invoices_waiting ? `${c.draft_invoices_waiting} draft invoice(s) waiting more than ${RELEASE_GRACE_DAYS} days — staff are not paid until they are approved` : null,
      c.slips_held ? `${c.slips_held} salary slip(s) held past ${RELEASE_GRACE_DAYS} days` : null,
      c.rate_reviews_open ? `${c.rate_reviews_open} placement(s) waiting for an RM to check the rate` : null,
      c.sent_invoices_needing_correction ? `${c.sent_invoices_needing_correction} sent invoice(s) with a rate changed since — correct them` : null,
      c.arrears_pending ? `${c.arrears_pending} arrears waiting for the next payroll` : null,
      c.ready_to_reinvoice ? `${c.ready_to_reinvoice} rejected invoice(s) ready to raise again — the RM has answered` : null,
      c.disputes_unresolved ? `${c.disputes_unresolved} disputed attendance day(s) unresolved for over 48 hours — neither billed nor paid` : null,
      c.muster_rolls_unsigned ? `${c.muster_rolls_unsigned} client(s) without a signed muster roll for last month` : null,
    ].filter(Boolean) as string[];

    let financeNotes = 0;
    if (lines.length) {
      const finance = await this.dataSource.query(
        `SELECT id FROM users WHERE role = 'FINANCE' AND is_active = true`,
      ).catch(() => []) as { id: string }[];
      for (const u of finance) {
        await this.notifications
          .createInAppNotification('Finance — needs attention today', lines.join('\n'), u.id)
          .catch(() => undefined);
        financeNotes += 1;
      }
    }

    let rmNotes = 0;
    const byRm = new Map<string, string[]>();
    for (const r of a.rate_reviews_open as { rm_id: string | null; staff_name: string; customer_name: string; days_waiting: number }[]) {
      if (!r.rm_id || Number(r.days_waiting) < 1) continue;
      byRm.set(r.rm_id, [...(byRm.get(r.rm_id) ?? []), `${r.staff_name} at ${r.customer_name ?? 'a client'}`]);
    }
    for (const [rmId, who] of byRm) {
      await this.notifications
        .createInAppNotification(
          'Rate check still waiting',
          `Finance rejected an invoice and is waiting for you to correct or confirm the rate: ${who.join(', ')}. ` +
            `These clients cannot be invoiced until you do.`,
          rmId,
        )
        .catch(() => undefined);
      rmNotes += 1;
    }
    this.logger.log(`[FINANCE_ATTENTION] ${JSON.stringify(c)} — ${financeNotes} Finance and ${rmNotes} RM note(s)`);
    return { counts: c, finance_notified: financeNotes, rms_notified: rmNotes };
  }

  /** Everything that happened to an invoice, oldest first. */
  async invoiceHistory(invoiceId: string) {
    const [inv] = await this.dataSource.query(
      `SELECT ci.id, ci.invoice_number, ci.status, ci.created_at, ci.approved_at, ci.rejected_at, ci.reject_reason,
              ci.paid_at, ci.payment_ref, ua.full_name AS approved_by_name, ur.full_name AS rejected_by_name
         FROM client_invoices ci
         LEFT JOIN users ua ON ua.id = ci.approved_by
         LEFT JOIN users ur ON ur.id = ci.rejected_by
        WHERE ci.id = $1`,
      [invoiceId],
    ) as Record<string, unknown>[];
    if (!inv) throw new NotFoundException(`Invoice ${invoiceId} not found`);

    type Event = { at: unknown; what: string; who?: unknown; detail?: unknown };
    const events: Event[] = [{ at: inv.created_at, what: 'Raised as DRAFT' }];
    if (inv.approved_at) events.push({ at: inv.approved_at, what: 'Approved — salary slips released', who: inv.approved_by_name });
    if (inv.rejected_at) events.push({ at: inv.rejected_at, what: 'Rejected', who: inv.rejected_by_name, detail: inv.reject_reason });
    else if (inv.status === 'CANCELLED') events.push({ at: null, what: 'Cancelled', detail: inv.payment_ref });
    if (inv.paid_at) events.push({ at: inv.paid_at, what: 'Paid', detail: inv.payment_ref });

    const voided = await this.dataSource.query(
      `SELECT v.voided_at, v.void_source, v.void_reason, v.net_salary, sa.full_name AS staff_name, u.full_name AS who
         FROM payroll_records_voided v
         JOIN staff_applicants sa ON sa.id = v.staff_id
         LEFT JOIN users u ON u.id = v.voided_by
        WHERE v.client_invoice_id = $1`,
      [invoiceId],
    ).catch(() => []) as Record<string, unknown>[];
    for (const v of voided) {
      events.push({
        at: v.voided_at,
        what: `Payroll voided (${String(v.void_source).toLowerCase()}) — ${v.staff_name}`,
        who: v.who,
        detail: v.void_reason,
      });
    }
    const corrections = await this.dataSource.query(
      `SELECT c.created_at, c.reason, c.client_delta, c.gst_delta, u.full_name AS who,
              cn.credit_note_number, si.invoice_number AS supplementary
         FROM invoice_corrections c
         LEFT JOIN users u ON u.id = c.created_by
         LEFT JOIN credit_notes cn ON cn.id = c.credit_note_id
         LEFT JOIN client_invoices si ON si.id = c.supplementary_invoice_id
        WHERE c.invoice_id = $1`,
      [invoiceId],
    ).catch(() => []) as Record<string, unknown>[];
    for (const c of corrections) {
      events.push({
        at: c.created_at,
        what: `Corrected${c.credit_note_number ? ` — credit note ${c.credit_note_number}` : ''}${c.supplementary ? ` — supplementary ${c.supplementary}` : ''}`,
        who: c.who,
        detail: c.reason,
      });
    }
    const notes = await this.dataSource.query(
      `SELECT created_at AS issued_at, credit_note_number, total_amount, reason FROM credit_notes WHERE invoice_id = $1`,
      [invoiceId],
    ).catch(() => []) as Record<string, unknown>[];
    for (const n of notes) {
      if (corrections.some((c) => c.credit_note_number === n.credit_note_number)) continue;
      events.push({ at: n.issued_at, what: `Credit note ${n.credit_note_number} (₹${n.total_amount})`, detail: n.reason });
    }

    events.sort((x, y) => new Date(String(x.at ?? 0)).getTime() - new Date(String(y.at ?? 0)).getTime());
    return { invoice_number: inv.invoice_number, status: inv.status, events };
  }
}
