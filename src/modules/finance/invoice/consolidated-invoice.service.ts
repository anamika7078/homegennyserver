import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { round2 } from '../../../common/finance/statutory-calc.util';
import { computeGst, formatInvoiceNumber } from '../../../common/finance/gst.util';
import { readSupplierSettings } from '../../../common/finance/supplier-settings';
import { assertTransition } from '../../../common/finance/invoice-status';
import {
  cycleEndsOn, formatPeriod, isoDate, monthBounds, nextDay, type Period,
} from '../../../common/finance/period.util';
import { PayrollService } from '../../payroll/payroll.service';

interface PayrollLine {
  payroll_id: string;
  placement_id: string;
  staff_id: string;
  staff_name: string;
  staff_code: string;
  gross_salary: string;
  esic_employer: string;
  pf_employer: string;
  /** The placement's monthly fee — null for an hourly placement. */
  management_fee: string;
  /** What payroll actually charged this client. Preferred over the above. */
  billed_fee: string | null;
  /** Days billed, despite the name. */
  shift_days: number | null;
  placement_type: 'PERMANENT' | 'TEMPORARY' | null;
  hours_worked: string | null;
  hourly_rate: string | null;
  rate_basis: string | null;
  duties: string | null;
  duty_rate: string | null;
  period_from: unknown;
  period_to: unknown;
  placement_start: unknown;
}

/**
 * One invoice per customer per month, instead of one per placement.
 *
 * A client with a driver, a cook and a maid used to receive three unrelated
 * invoices every month, each with its own number — the spec has always said
 * "one consolidated invoice". See F-15.
 *
 * The invoice is built from the month's `payroll_records`, so it cannot
 * disagree with what the staff were actually paid: each staff member becomes a
 * line-item group (salary, employer ESIC, employer PF, management fee), and GST
 * is charged on the whole of it. See F-14 and common/finance/gst.util.ts.
 */
@Injectable()
export class ConsolidatedInvoiceService {
  private readonly logger = new Logger(ConsolidatedInvoiceService.name);

  constructor(
    private readonly dataSource: DataSource,
    // An invoice for part of a month runs that part's payroll first, so the
    // work and the bill always cover the same days.
    private readonly payroll: PayrollService,
  ) {}

  /**
   * What a consolidated invoice for this customer/month would contain, without
   * writing anything. Finance can see the document before committing a number
   * to the series.
   */
  /**
   * `runner` lets an amend-in-place recompute read its own uncommitted unlink
   * (see generateOrAmend). Defaults to the pooled connection, which is what
   * every read-only caller wants.
   */
  async preview(
    customerId: string,
    month: number,
    year: number,
    runner: { query<T = any>(sql: string, params?: unknown[]): Promise<T> } = this.dataSource,
    period?: Period,
  ) {
    const range = period ?? monthBounds(month, year);
    const customer = await runner.query<{
      id: string; customer_name: string; gstn: string | null; state: string | null;
      bill_no_prefix: string; bill_seq: number; address: string | null; city: string | null;
    }[]>(
      `SELECT id, customer_name, gstn, state, bill_no_prefix, bill_seq, address, city
       FROM finance_customers WHERE id = $1`,
      [customerId],
    );
    if (!customer.length) throw new NotFoundException(`Customer ${customerId} not found`);
    const cust = customer[0];

    // Every payroll this customer's placements produced in the period that is
    // not already on an invoice.
    const lines = await runner.query<PayrollLine[]>(
      `SELECT pr.id AS payroll_id, pr.placement_id, pr.staff_id,
              sa.full_name AS staff_name, sa.staff_code,
              -- shift_days is the count of days actually billed, despite the name.
              pr.gross_salary, pr.esic_employer, pr.pf_employer, pr.shift_days,
              -- What this client was actually charged, as payroll computed it.
              -- Deriving it from the placement's monthly figure instead billed
              -- an hourly placement nothing at all, since an hourly placement
              -- has no monthly fee — it has a fee per hour.
              pr.management_fee AS billed_fee,
              pr.placement_type, pr.hours_worked, pr.hourly_rate,
              pr.rate_basis, pr.duties, pr.duty_rate,
              pr.period_from, pr.period_to,
              p.management_fee,
              COALESCE(p.trial_start_date, p.confirmed_at::date) AS placement_start
       FROM payroll_records pr
       JOIN placements p ON p.id = pr.placement_id
       JOIN staff_applicants sa ON sa.id = pr.staff_id
       WHERE p.client_id = $1
         AND pr.period_month = $2 AND pr.period_year = $3
         AND pr.client_invoice_id IS NULL
         -- Everything un-invoiced that ends by the close of this period. A row
         -- run late for days an earlier invoice already passed is swept into
         -- this one rather than left unbilled; it carries its own dates.
         AND pr.period_to <= $4::date
       ORDER BY sa.staff_code, pr.period_from`,
      [customerId, month, year, range.to],
    );

    const supplier = await readSupplierSettings(runner);

    let salaryTotal = 0, esicTotal = 0, pfTotal = 0, feeTotal = 0;
    const items: {
      staff_id: string; staff_name: string; placement_id: string;
      description: string; amount: number; is_taxable: boolean; sort_order: number;
    }[] = [];

    let order = 0;
    for (const l of lines) {
      const salary = round2(parseFloat(l.gross_salary));
      const esic = round2(parseFloat(l.esic_employer ?? '0'));
      const pf = round2(parseFloat(l.pf_employer ?? '0'));
      // The stored management fee is the placement's monthly figure; the
      // payroll pro-rated it, so derive the billed fee the same way rather
      // than billing a full month for a partial one.
      const fee = l.billed_fee != null
        ? round2(parseFloat(l.billed_fee))
        : this.proratedFeeFor(l, month, year);

      salaryTotal += salary; esicTotal += esic; pfTotal += pf; feeTotal += fee;

      const base = { staff_id: l.staff_id, staff_name: l.staff_name, placement_id: l.placement_id };
      // Every line is taxable now. Marking the wage lines exempt was the old
      // pure-agent reading, and it would leave the document's own tax
      // breakdown disagreeing with the tax actually charged.
      items.push({
        ...base,
        description: `${l.staff_name} — Staff Salary (${this.workingFor(l, month, year)}${this.lateNote(l, range)})`,
        amount: salary, is_taxable: true, sort_order: order++,
      });
      // Not "> 0": when a month is billed in parts, a later part can carry a
      // small negative true-up, and leaving it off would break the total.
      if (esic !== 0) items.push({ ...base, description: `${l.staff_name} — Employer ESIC`, amount: esic, is_taxable: true, sort_order: order++ });
      if (pf !== 0) items.push({ ...base, description: `${l.staff_name} — Employer PF`, amount: pf, is_taxable: true, sort_order: order++ });
      items.push({ ...base, description: `${l.staff_name} — Management Fee`, amount: fee, is_taxable: true, sort_order: order++ });
    }

    // The whole consideration is taxable — wages, employer ESIC and PF, and
    // the fee. Manpower supply is not a pure-agent reimbursement, so charging
    // on the fee alone under-collects the tax. See computeGst.
    const taxableValue = round2(salaryTotal + esicTotal + pfTotal + feeTotal);

    const gst = computeGst({
      taxableValue,
      // One rate, set on the Company & GST settings page — the payroll preview
      // reads the same one, so the two cannot quote different tax.
      gstRatePct: supplier.gstRatePct,
      supplier,
      recipientGstin: cust.gstn,
      recipientState: cust.state,
    });

    if (gst.totalTax > 0) {
      items.push({
        staff_id: '', staff_name: '', placement_id: '',
        description: gst.isInterState
          ? `IGST @ ${gst.gstRatePct}%`
          : `CGST @ ${gst.gstRatePct / 2}% + SGST @ ${gst.gstRatePct / 2}%`,
        amount: gst.totalTax, is_taxable: false, sort_order: order++,
      });
    }

    const total = round2(salaryTotal + esicTotal + pfTotal + feeTotal + gst.totalTax);
    const itemsTotal = round2(items.reduce((s, i) => s + i.amount, 0));

    return {
      customer_id: cust.id,
      customer_name: cust.customer_name,
      period_month: month,
      period_year: year,
      period_from: range.from,
      period_to: range.to,
      // When service actually began inside the period — the first placement
      // start among those billed, if later than the period's first day. The
      // printed "From" date reads 05/10 for a household that started on the 5th.
      service_from: this.serviceFrom(lines, range),
      staff_count: new Set(lines.map((l) => l.staff_id)).size,
      document_type: gst.documentType,
      supplier,
      recipient_gstin: cust.gstn,
      recipient_state: cust.state,
      place_of_supply: gst.placeOfSupply,
      place_of_supply_known: gst.placeOfSupplyKnown,
      is_inter_state: gst.isInterState,
      gst_rate_pct: gst.gstRatePct,
      sac_code: supplier.sacCode,
      // Named so it is obvious the invoice is not yet compliant and why.
      missing_for_tax_invoice: gst.missing,
      totals: {
        staff_salary: round2(salaryTotal),
        employer_esic: round2(esicTotal),
        employer_pf: round2(pfTotal),
        management_fee: round2(feeTotal),
        taxable_value: gst.taxableValue,
        cgst: gst.cgst, sgst: gst.sgst, igst: gst.igst,
        gst_total: gst.totalTax,
        total,
      },
      reconciles: Math.abs(itemsTotal - total) <= 0.01,
      line_items: items,
      next_invoice_number: formatInvoiceNumber(cust.bill_no_prefix, cust.bill_seq + 1),
      payroll_ids: lines.map((l) => l.payroll_id),
    };
  }

  /**
   * The fee actually billed for this payroll row.
   *
   * `payroll_records` stores the pro-rated gross but not the pro-rated fee, so
   * it is recomputed from the same ratio the payroll used — billable days over
   * days in the month, which `shift_days` records. Billing a full month's fee
   * against a part-month's salary would quietly overcharge the client.
   */
  /**
   * The arithmetic behind a salary line, in words.
   *
   * A client reading "Sunita Devi — Staff Salary ₹1,800" has to take it on
   * trust. "12 hours × ₹150" they can check. Hourly placements show hours and
   * rate; monthly ones show the days that were pro-rated. See §F4.
   */
  private workingFor(line: PayrollLine, month: number, year: number): string {
    if (line.rate_basis === 'PER_DUTY') {
      const duties = Number(line.duties ?? 0);
      const rate = Number(line.duty_rate ?? 0);
      return `${duties} ${duties === 1 ? 'duty' : 'duties'} × ₹${rate.toLocaleString('en-IN')}`;
    }
    if (line.placement_type === 'TEMPORARY') {
      const hours = Number(line.hours_worked ?? 0);
      const rate = Number(line.hourly_rate ?? 0);
      if (hours > 0 && rate > 0) {
        return `${hours} hours × ₹${rate.toLocaleString('en-IN')}`;
      }
      return `${hours} hours`;
    }
    const daysInMonth = new Date(year, month, 0).getDate();
    return `${Number(line.shift_days ?? 0)} of ${daysInMonth} days`;
  }

  /** Marks a row whose days fall before this invoice's period — billed late. */
  private lateNote(line: PayrollLine, range: Period): string {
    const from = isoDate(line.period_from);
    const to = isoDate(line.period_to);
    if (!from || !to || from >= range.from) return '';
    return `, ${formatPeriod({ from, to })} billed late`;
  }

  private serviceFrom(lines: PayrollLine[], range: Period): string {
    const starts = lines
      .map((l) => isoDate(l.placement_start))
      .filter((d): d is string => !!d && d > range.from && d <= range.to);
    if (!starts.length || starts.length < new Set(lines.map((l) => l.placement_id)).size) return range.from;
    return starts.sort()[0];
  }

  private proratedFeeFor(line: PayrollLine, month: number, year: number): number {
    const monthlyFee = parseFloat(line.management_fee ?? '0');
    if (!Number.isFinite(monthlyFee) || monthlyFee <= 0) return 0;

    const daysInMonth = new Date(year, month, 0).getDate();
    const billableDays = Number(line.shift_days ?? 0);
    // No day count recorded (older rows) — bill the full fee rather than zero,
    // which would silently give the month away.
    if (!billableDays) return round2(monthlyFee);

    return round2(monthlyFee * (Math.min(billableDays, daysInMonth) / daysInMonth));
  }

  /**
   * A Tax Invoice has to name its place of supply — it is what decides
   * CGST+SGST against IGST. When the customer's state is blank or unreadable
   * the old code assumed HomeGenny's own state; now it refuses and says which
   * field to fix.
   */
  private assertPlaceOfSupply(preview: {
    document_type: string; place_of_supply_known: boolean; customer_name: string;
    recipient_state: string | null;
  }) {
    if (preview.document_type === 'TAX_INVOICE' && !preview.place_of_supply_known) {
      throw new BadRequestException(
        `${preview.customer_name} has ${preview.recipient_state?.trim()
          ? `"${preview.recipient_state.trim()}" as their state, which is not a recognised Indian state`
          : 'no state on record'}, so the place of supply — and whether CGST+SGST or IGST applies — ` +
          `cannot be decided. Fix the state on the Customers page, then issue the invoice.`,
      );
    }
  }

  /** This client's live invoices for the month, in date order. */
  private async invoicesInMonth(
    customerId: string, month: number, year: number,
  ): Promise<{ id: string; invoice_number: string; status: string; period_from: string; period_to: string }[]> {
    const rows = await this.dataSource.query<{
      id: string; invoice_number: string; status: string; period_from: unknown; period_to: unknown;
    }[]>(
      `SELECT id, invoice_number, status, period_from, period_to
         FROM client_invoices
        WHERE client_id = $1 AND period_month = $2 AND period_year = $3
          AND is_consolidated = true AND status <> 'CANCELLED'
        ORDER BY period_to`,
      [customerId, month, year],
    );
    return rows.map((r) => ({
      ...r,
      period_from: isoDate(r.period_from) as string,
      period_to: isoDate(r.period_to) as string,
    }));
  }

  /**
   * Runs payroll up to `to` for everyone who worked at this client this month.
   *
   * "Who worked here" is read from attendance, not placement status, so a
   * placement that ended mid-month is still billed for the days it ran.
   * A placement already paid through `to`, or with nothing to pay, is not a
   * failure; anything else is reported back so Finance can see who was left off.
   */
  private async runClientPayroll(customerId: string, month: number, year: number, to: string) {
    const placements = await this.dataSource.query<{ id: string; staff_name: string }[]>(
      `SELECT DISTINCT p.id, sa.full_name AS staff_name
         FROM placements p
         JOIN staff_applicants sa ON sa.id = p.staff_id
         JOIN staff_daily_attendance sda ON sda.placement_id = p.id
        WHERE p.client_id = $1
          AND sda.attendance_date BETWEEN $2::date AND $3::date`,
      [customerId, monthBounds(month, year).from, to],
    );
    const skipped: { staff_name: string; reason: string }[] = [];
    for (const pl of placements) {
      try {
        await this.payroll.runPayrollForPeriod(pl.id, month, year, to);
      } catch (e) {
        const reason = (e as Error).message;
        if (/^Payroll already exists|^No (duties|hours|billable)/.test(reason)) continue;
        skipped.push({ staff_name: pl.staff_name, reason });
      }
    }
    return skipped;
  }

  /**
   * Refuses when someone's payroll already runs past the end of the period
   * asked for — e.g. the whole month was run, and now an invoice up to the 7th
   * is wanted. Billing it would put the 8th–31st on an invoice that says 1–7.
   */
  private async assertNoStraddle(customerId: string, month: number, year: number, to: string) {
    const rows = await this.dataSource.query<{ staff_name: string; period_from: unknown; period_to: unknown }[]>(
      `SELECT sa.full_name AS staff_name, pr.period_from, pr.period_to
         FROM payroll_records pr
         JOIN placements p ON p.id = pr.placement_id
         JOIN staff_applicants sa ON sa.id = pr.staff_id
        WHERE p.client_id = $1 AND pr.period_month = $2 AND pr.period_year = $3
          AND pr.client_invoice_id IS NULL
          AND pr.period_from <= $4::date AND pr.period_to > $4::date
        LIMIT 1`,
      [customerId, month, year, to],
    );
    if (rows.length) {
      const r = rows[0];
      const span = formatPeriod({ from: isoDate(r.period_from)!, to: isoDate(r.period_to)! });
      throw new BadRequestException(
        `${r.staff_name}'s payroll is already run for ${span}, past ${to}. ` +
          `Invoice up to ${isoDate(r.period_to)} instead, or delete that payroll and run it again.`,
      );
    }
  }

  /**
   * Issue a new invoice for this client: from the day after their last invoice
   * this month (or the 1st) up to `till` (or the month end).
   *
   * Placement started on the 1st, invoiced on the 7th → this invoice is 1–7,
   * and nothing else can ever cover those days (also enforced in the database,
   * trg_client_invoices_no_overlap). The next one starts on the 8th.
   */
  async generate(customerId: string, month: number, year: number, actorId?: string, till?: string) {
    const bounds = monthBounds(month, year);
    const existing = await this.invoicesInMonth(customerId, month, year);
    const last = existing[existing.length - 1];
    const from = last ? nextDay(last.period_to) : bounds.from;
    const to = till ?? bounds.to;
    if (from > to) {
      throw new BadRequestException(
        last
          ? last.period_to === bounds.to && !till
            ? `A consolidated invoice already exists for this customer in ${month}/${year} (${last.invoice_number}).`
            : `Up to ${to} is already invoiced — ${last.invoice_number} covers ${formatPeriod({ from: last.period_from, to: last.period_to })}. ` +
              `The next invoice can start from ${nextDay(last.period_to)}.`
          : `Nothing to invoice for ${month}/${year}.`,
      );
    }
    const period: Period = { from, to };

    const payrollSkipped = await this.runClientPayroll(customerId, month, year, to);
    await this.assertNoStraddle(customerId, month, year, to);

    const preview = await this.preview(customerId, month, year, this.dataSource, period);
    if (preview.staff_count === 0) {
      throw new BadRequestException(
        `Nothing to invoice for ${formatPeriod(period)} — no billable attendance at this client in those days.` +
          (payrollSkipped.length
            ? ` Payroll could not run for: ${payrollSkipped.map((x) => `${x.staff_name} (${x.reason})`).join('; ')}`
            : ''),
      );
    }
    if (!preview.reconciles) {
      throw new BadRequestException('Line items do not reconcile to the invoice total — refusing to issue.');
    }
    this.assertPlaceOfSupply(preview);

    return this.dataSource.transaction(async (manager) => {
      // Take the next number inside the transaction so two concurrent runs
      // cannot land on the same one.
      //
      // TypeORM's `manager.query` returns `[rows, affectedCount]` for an
      // UPDATE ... RETURNING, unlike the plain rows a SELECT gives back —
      // destructuring it as rows produced an invoice numbered
      // "INV/undefined". Normalise rather than trust either shape.
      const seqResult = await manager.query(
        `UPDATE finance_customers SET bill_seq = bill_seq + 1
         WHERE id = $1 RETURNING bill_no_prefix, bill_seq`,
        [customerId],
      );
      const seqRows = (Array.isArray(seqResult[0]) ? seqResult[0] : seqResult) as
        { bill_no_prefix: string; bill_seq: number }[];
      const cust = seqRows[0];
      if (!cust?.bill_no_prefix || cust.bill_seq == null) {
        throw new BadRequestException(
          `Could not reserve an invoice number for customer ${customerId} — check its bill_no_prefix.`,
        );
      }
      // `bill_seq` counts per customer, but `invoice_number` is unique across
      // the whole table — and customers onboarded in the same month were given
      // the same `bill_no_prefix` (see customer.service.buildBillPrefix). Two
      // such customers both reach "BILL/202609/0001", and the second one's
      // invoicing died on a raw unique-constraint 500 with nothing to explain
      // it. New customers no longer share a prefix; the ones already created
      // that way still do, so skip past any number already taken rather than
      // leave those clients unable to be billed at all. Skipping leaves a gap
      // in that customer's own count, which is the harmless half of the
      // problem — a number issued twice is not.
      let seq = cust.bill_seq;
      let invoiceNumber = formatInvoiceNumber(cust.bill_no_prefix, seq);
      for (let guard = 0; guard < 1000; guard++) {
        const taken = await manager.query(
          `SELECT 1 FROM client_invoices WHERE invoice_number = $1 LIMIT 1`,
          [invoiceNumber],
        );
        if (!taken.length) break;
        seq += 1;
        invoiceNumber = formatInvoiceNumber(cust.bill_no_prefix, seq);
      }
      if (seq !== cust.bill_seq) {
        await manager.query(
          `UPDATE finance_customers SET bill_seq = $1 WHERE id = $2`,
          [seq, customerId],
        );
        this.logger.warn(
          `[CONSOLIDATED_INVOICE] customer ${customerId} shares bill_no_prefix ` +
            `"${cust.bill_no_prefix}" with another customer — advanced to ${invoiceNumber}.`,
        );
      }

      // Due five days after the period closes — the 5th of next month for a
      // whole-month invoice, as before; a week-one invoice is due on the 12th.
      const due = new Date(`${to}T00:00:00Z`);
      due.setUTCDate(due.getUTCDate() + 5);
      const dueDate = due.toISOString().slice(0, 10);
      const t = preview.totals;

      const invoiceResult = await manager.query(
        `INSERT INTO client_invoices
           (id, placement_id, client_id, invoice_number, invoice_seq, period_month, period_year,
            staff_salary_component, management_fee, gst_amount, esic_employer, pf_employer,
            total_amount, due_date, status, is_consolidated, document_type,
            supplier_gstin, supplier_state, recipient_gstin, recipient_state,
            place_of_supply, sac_code, taxable_value, cgst_amount, sgst_amount, igst_amount,
            period_from, period_to)
         VALUES (gen_random_uuid(), NULL, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,'DRAFT',true,
                 $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, $24::date, $25::date)
         RETURNING *`,
        [
          customerId, invoiceNumber, seq, month, year,
          t.staff_salary, t.management_fee, t.gst_total, t.employer_esic, t.employer_pf,
          t.total, dueDate,
          preview.document_type,
          preview.supplier.gstin, preview.supplier.state,
          preview.recipient_gstin, preview.recipient_state,
          preview.place_of_supply, preview.sac_code,
          t.taxable_value, t.cgst, t.sgst, t.igst,
          period.from, period.to,
        ],
      );
      // Same `[rows, affectedCount]` shape as the UPDATE above.
      const invoiceRows = (Array.isArray(invoiceResult[0]) ? invoiceResult[0] : invoiceResult) as
        Record<string, unknown>[];
      const invoice = invoiceRows[0];
      if (!invoice?.id) {
        throw new BadRequestException('Invoice insert returned no row — nothing was issued.');
      }

      await this.writeItems(manager, invoice.id as string, preview);

      this.logger.log(
        `[CONSOLIDATED_INVOICE] ${invoiceNumber} ${formatPeriod(period)} — ${preview.staff_count} staff, ` +
        `${preview.document_type}, total ${t.total}, by ${actorId ?? 'unknown'}`,
      );

      return { invoice, preview, payroll_skipped: payrollSkipped };
    });
  }

  /** Writes the line items and links the payroll rows they bill. */
  private async writeItems(
    manager: { query<T = any>(sql: string, params?: unknown[]): Promise<T> },
    invoiceId: string,
    preview: Awaited<ReturnType<ConsolidatedInvoiceService['preview']>>,
  ) {
    for (const item of preview.line_items) {
      await manager.query(
        `INSERT INTO invoice_items
           (id, invoice_id, description, amount, is_taxable, staff_id, staff_name,
            placement_id, sac_code, sort_order)
         VALUES (gen_random_uuid(), $1,$2,$3,$4,
                 NULLIF($5,'')::uuid, NULLIF($6,''), NULLIF($7,'')::uuid, $8, $9)`,
        [
          invoiceId, item.description, item.amount, item.is_taxable,
          item.staff_id, item.staff_name, item.placement_id,
          item.is_taxable ? preview.sac_code : null, item.sort_order,
        ],
      );
    }
    // Link each payroll row to the invoice that billed it, so the same work
    // can never be invoiced twice.
    await manager.query(
      `UPDATE payroll_records SET client_invoice_id = $1 WHERE id = ANY($2::uuid[])`,
      [invoiceId, preview.payroll_ids],
    );
  }

  /**
   * The button on the unit-code screen: issue the next invoice, or refresh the
   * open draft.
   *
   *  - No date given and the latest invoice is still a DRAFT: it is
   *    recomputed in place over its own dates — someone who joined since is
   *    folded in, keeping its number.
   *  - A date given that the latest DRAFT already ends on: the same refresh.
   *  - Any later date: a new invoice from the day after the last one.
   *  - A date already covered by an invoice: refused, naming that invoice.
   *
   * Once an invoice has been approved or sent the client has seen it, so it is
   * never silently changed; the correction is a credit note.
   */
  async generateOrAmend(customerId: string, month: number, year: number, actorId?: string, till?: string) {
    const bounds = monthBounds(month, year);
    const existing = await this.invoicesInMonth(customerId, month, year);
    const last = existing[existing.length - 1];
    // No date means "up to the end of the month".
    const target = till ?? bounds.to;

    if (last && last.status === 'DRAFT' && target === last.period_to) {
      const result = await this.amendInPlace(last, customerId, month, year, actorId);
      return { ...result, amended: true };
    }
    if (last && target <= last.period_to) {
      throw new BadRequestException(
        last.period_to === bounds.to && !till
          ? `Invoice ${last.invoice_number} for ${month}/${year} is already ${last.status} — ` +
              `it cannot be amended. Issue a credit note instead.`
          : `Up to ${target} is already invoiced — ${last.invoice_number} (${last.status}) covers ` +
              `${formatPeriod({ from: last.period_from, to: last.period_to })}. ` +
              `The next invoice can start from ${nextDay(last.period_to)}.`,
      );
    }
    const result = await this.generate(customerId, month, year, actorId, till);
    return { ...result, amended: false };
  }

  /**
   * Recompute a DRAFT invoice over its own dates, keeping its id and number.
   * Payroll is run first for anyone who worked those days and has not been
   * paid for them, so a colleague who joined mid-period is folded in.
   */
  private async amendInPlace(
    inv: { id: string; invoice_number: string; period_from: string; period_to: string },
    customerId: string, month: number, year: number, actorId?: string,
  ) {
    const period: Period = { from: inv.period_from, to: inv.period_to };
    const payrollSkipped = await this.runClientPayroll(customerId, month, year, period.to);
    await this.assertNoStraddle(customerId, month, year, period.to);

    return this.dataSource.transaction(async (manager) => {
      // Release this invoice's payroll so the recompute below sees the full
      // set — the rows already on it, plus whatever has been run since.
      await manager.query(
        `UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`,
        [inv.id],
      );
      await manager.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [inv.id]);

      const preview = await this.preview(customerId, month, year, manager, period);
      if (preview.staff_count === 0) {
        throw new BadRequestException(
          `No payroll left to bill for this customer for ${formatPeriod(period)}.`,
        );
      }
      if (!preview.reconciles) {
        throw new BadRequestException(
          'Line items do not reconcile to the invoice total — refusing to amend.',
        );
      }
      this.assertPlaceOfSupply(preview);

      const t = preview.totals;
      // The invoice keeps its id and its number: a client who has been told
      // "your invoice is BILL/0007" must not find it renumbered. The tax header
      // is refreshed with the figures — updating document_type alone left an
      // invoice first raised as a Bill of Supply reading TAX_INVOICE with a
      // blank supplier GSTIN and state on the record.
      const updated = await manager.query(
        `UPDATE client_invoices
            SET staff_salary_component = $2, management_fee = $3, gst_amount = $4,
                esic_employer = $5, pf_employer = $6, total_amount = $7,
                document_type = $8, taxable_value = $9,
                cgst_amount = $10, sgst_amount = $11, igst_amount = $12,
                supplier_gstin = $13, supplier_state = $14,
                recipient_gstin = $15, recipient_state = $16,
                place_of_supply = $17, sac_code = $18
          WHERE id = $1
        RETURNING *`,
        [
          inv.id,
          t.staff_salary, t.management_fee, t.gst_total, t.employer_esic, t.employer_pf,
          t.total, preview.document_type, t.taxable_value, t.cgst, t.sgst, t.igst,
          preview.supplier.gstin, preview.supplier.state,
          preview.recipient_gstin, preview.recipient_state,
          preview.place_of_supply, preview.sac_code,
        ],
      );
      // TypeORM hands back `[rows, affectedCount]` for UPDATE ... RETURNING.
      const updatedRows = (Array.isArray(updated[0]) ? updated[0] : updated) as
        Record<string, unknown>[];
      const invoice = updatedRows[0];

      await this.writeItems(manager, inv.id, preview);

      this.logger.log(
        `[CONSOLIDATED_INVOICE] amended ${inv.invoice_number} ${formatPeriod(period)} — now ` +
          `${preview.staff_count} staff, total ${t.total}, by ${actorId ?? 'unknown'}`,
      );

      return { invoice, preview, payroll_skipped: payrollSkipped };
    });
  }

  /**
   * Rebuild an unsent invoice from its payroll with today's GST settings.
   *
   * An invoice raised before the GSTIN was entered is a Bill of Supply with no
   * tax, and it stays one: amend only ran while it was a DRAFT, and nothing
   * re-taxed an APPROVED one. Until it has been sent the client has not seen
   * it, so it can go back to DRAFT and be recomputed in place, keeping its
   * number and dates. After sending, the correction is a credit note.
   */
  async recalculate(invoiceId: string, actorId?: string) {
    const rows = await this.dataSource.query<{
      id: string; invoice_number: string; status: string; client_id: string;
      period_month: number; period_year: number; is_consolidated: boolean;
      period_from: unknown; period_to: unknown;
    }[]>(
      `SELECT id, invoice_number, status, client_id, period_month, period_year, is_consolidated,
              period_from, period_to
         FROM client_invoices WHERE id = $1`,
      [invoiceId],
    );
    const inv = rows[0];
    if (!inv) throw new NotFoundException(`Invoice ${invoiceId} not found`);
    if (!inv.is_consolidated) {
      throw new BadRequestException(
        `${inv.invoice_number} is an old per-placement invoice and cannot be recalculated. ` +
          `Cancel it and issue a consolidated invoice instead.`,
      );
    }
    if (inv.status !== 'DRAFT' && inv.status !== 'APPROVED') {
      throw new BadRequestException(
        `${inv.invoice_number} is ${inv.status} — the client already has it, so it cannot be ` +
          `recalculated. Issue a credit note and raise a new invoice instead.`,
      );
    }

    if (inv.status === 'APPROVED') {
      assertTransition(inv.status, 'DRAFT', inv.invoice_number);
      await this.dataSource.query(`UPDATE client_invoices SET status = 'DRAFT' WHERE id = $1`, [inv.id]);
    }

    try {
      const result = await this.amendInPlace(
        {
          id: inv.id, invoice_number: inv.invoice_number,
          period_from: isoDate(inv.period_from) as string, period_to: isoDate(inv.period_to) as string,
        },
        inv.client_id, inv.period_month, inv.period_year, actorId,
      );
      if (inv.status === 'APPROVED') {
        // It was approved before; only the figures were refreshed, so put the
        // approval back rather than make Finance approve it twice.
        await this.dataSource.query(`UPDATE client_invoices SET status = 'APPROVED' WHERE id = $1`, [inv.id]);
      }
      this.logger.log(
        `[CONSOLIDATED_INVOICE] recalculated ${inv.invoice_number} — ` +
          `${result.preview.document_type}, GST ${result.preview.totals.gst_total}, by ${actorId ?? 'unknown'}`,
      );
      return { ...result, amended: true, status: inv.status, recalculated: true };
    } catch (e) {
      if (inv.status === 'APPROVED') {
        await this.dataSource.query(`UPDATE client_invoices SET status = 'APPROVED' WHERE id = $1`, [inv.id]);
      }
      throw e;
    }
  }

  /**
   * Everything about a client, found by the code Finance actually knows them by.
   *
   * Issuing an invoice used to start with picking a customer out of a list and
   * hoping it was the right one. Finance identifies a client by their unit
   * code, so that is the way in: type it, see who it is and what they have
   * running, then issue. See docs/HOURLY_MULTI_CLIENT_PLAN.md §F1.
   */
  async lookupByUnitCode(unitCode: string, month: number, year: number) {
    const code = String(unitCode ?? '').trim();
    if (!code) throw new BadRequestException('A unit code is required.');

    const rows = await this.dataSource.query<{
      id: string; customer_name: string; unit_code: string; gstn: string | null;
      address: string | null; city: string | null; state: string | null;
      bill_no_prefix: string;
    }[]>(
      `SELECT id, customer_name, unit_code, gstn, address, city, state, bill_no_prefix
         FROM finance_customers WHERE UPPER(unit_code) = UPPER($1) LIMIT 1`,
      [code],
    );
    if (!rows.length) throw new NotFoundException(`No client with unit code "${code}".`);
    const customer = rows[0];

    // Permanent and temporary listed apart, because they are billed on
    // different things — a month of days against a count of hours.
    const placements = await this.dataSource.query(
      `SELECT p.id, p.placement_type, p.status::text AS status,
              p.staff_salary, p.management_fee, p.hourly_rate, p.hourly_fee,
              p.rate_basis, p.duty_billing_rate,
              p.shift_hours,
              sa.staff_code, sa.full_name AS staff_name,
              COALESCE(a.days, 0)::int    AS days_this_period,
              COALESCE(a.hours, 0)::float AS hours_this_period,
              COALESCE(pr.n, 0) > 0       AS payroll_run,
              -- Invoiced only when every payroll row of the month is.
              COALESCE(pr.n, 0) > 0 AND pr.uninvoiced = 0 AS invoiced,
              pr.paid_to                  AS payroll_through
         FROM placements p
         JOIN staff_applicants sa ON sa.id = p.staff_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE status IN ('PRESENT','HALF_DAY','OVERTIME')) AS days,
                  SUM(hours_worked) FILTER (WHERE status IN ('PRESENT','HALF_DAY','OVERTIME')) AS hours
             FROM staff_daily_attendance sda
            WHERE sda.placement_id = p.id
              AND EXTRACT(MONTH FROM sda.attendance_date) = $2
              AND EXTRACT(YEAR  FROM sda.attendance_date) = $3
         ) a ON true
         -- A placement can have several payroll rows in a month now (invoiced
         -- in parts), so they are summarised rather than joined row by row.
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS n,
                  COUNT(*) FILTER (WHERE client_invoice_id IS NULL) AS uninvoiced,
                  MAX(period_to) AS paid_to
             FROM payroll_records
            WHERE placement_id = p.id AND period_month = $2 AND period_year = $3
         ) pr ON true
        WHERE p.client_id = $1 AND p.status IN ('CONFIRMED','TRIAL')
        ORDER BY p.placement_type, sa.staff_code`,
      [customer.id, month, year],
    );

    const invoices = await this.dataSource.query<
      { id: string; invoice_number: string; status: string; total_amount: string; period_from: unknown; period_to: unknown }[]
    >(
      `SELECT id, invoice_number, status, total_amount, period_from, period_to
         FROM client_invoices
        WHERE client_id = $1 AND period_month = $2 AND period_year = $3
          AND status <> 'CANCELLED'
        ORDER BY period_to`,
      [customer.id, month, year],
    );
    const invoiceList = invoices.map((i) => ({
      ...i, period_from: isoDate(i.period_from), period_to: isoDate(i.period_to),
    }));
    const latest = invoiceList[invoiceList.length - 1] ?? null;
    const bounds = monthBounds(month, year);
    // Where the next invoice would start — the day after the latest one.
    const nextFrom = latest?.period_to ? nextDay(latest.period_to) : bounds.from;

    // What the invoice would carry if issued now — the same query the preview
    // uses, so the button below never promises something different.
    const pending = await this.dataSource.query<{ n: string; total: string }[]>(
      `SELECT COUNT(*)::text AS n, COALESCE(SUM(pr.gross_salary), 0)::text AS total
         FROM payroll_records pr
         JOIN placements p ON p.id = pr.placement_id
        WHERE p.client_id = $1 AND pr.period_month = $2 AND pr.period_year = $3
          AND pr.client_invoice_id IS NULL`,
      [customer.id, month, year],
    );

    return {
      customer,
      period: { month, year },
      placements,
      // The latest invoice of the month (kept under its old name for the screen),
      // and every one of them, in date order.
      existing_invoice: latest,
      invoices: invoiceList,
      next_period: nextFrom <= bounds.to ? { from: nextFrom, to: bounds.to } : null,
      un_invoiced: {
        staff_count: parseInt(pending[0]?.n ?? '0', 10),
        salary_total: parseFloat(pending[0]?.total ?? '0'),
      },
    };
  }

  /**
   * Raises the DRAFT invoice for every client whose billing period ends on
   * `date` — weekly clients on the 7th, 14th, 21st and month end, fortnightly
   * on the 15th and month end, monthly at month end. MANUAL clients are never
   * touched. Each invoice starts the day after that client's last one, so a
   * client also invoiced by hand mid-period is simply billed for the rest.
   *
   * Run every morning for yesterday by the cron, and on demand for any date
   * (the server was down, or a cycle was changed mid-month). Idempotent: a
   * period already invoiced is skipped, never billed twice.
   */
  async runCycleBilling(date: string, actorId?: string) {
    const [year, month] = date.split('-').map(Number);
    // Only clients with someone who worked there this month up to the date.
    const customers = await this.dataSource.query<{ id: string; customer_name: string; billing_cycle: string }[]>(
      `SELECT fc.id, fc.customer_name, fc.billing_cycle
         FROM finance_customers fc
        WHERE fc.billing_cycle <> 'MANUAL'
          AND EXISTS (
            SELECT 1 FROM placements p
              JOIN staff_daily_attendance sda ON sda.placement_id = p.id
             WHERE p.client_id = fc.id
               AND sda.attendance_date BETWEEN make_date($1, $2, 1) AND $3::date)
        ORDER BY fc.customer_name`,
      [year, month, date],
    );

    const issued: { customer: string; cycle: string; invoice_number: string; period: string; total: number }[] = [];
    const skipped: { customer: string; cycle: string; reason: string }[] = [];
    for (const c of customers) {
      if (!cycleEndsOn(c.billing_cycle, date)) continue;
      try {
        const r = await this.generate(c.id, month, year, actorId, date);
        issued.push({
          customer: c.customer_name,
          cycle: c.billing_cycle,
          invoice_number: String(r.invoice.invoice_number),
          period: formatPeriod({ from: r.preview.period_from, to: r.preview.period_to }),
          total: r.preview.totals.total,
        });
      } catch (e) {
        skipped.push({ customer: c.customer_name, cycle: c.billing_cycle, reason: (e as Error).message });
      }
    }
    this.logger.log(
      `[CYCLE_BILLING] ${date}: ${issued.length} invoice(s) raised, ${skipped.length} skipped`,
    );
    return { date, issued, skipped };
  }

  /** Customers with un-invoiced payroll for a period — the month-end worklist. */
  async pendingForPeriod(month: number, year: number) {
    return this.dataSource.query(
      `SELECT fc.id AS customer_id, fc.customer_name, fc.gstn, fc.state,
              COUNT(DISTINCT pr.id)::int AS payroll_count,
              COUNT(DISTINCT pr.staff_id)::int AS staff_count,
              COALESCE(SUM(pr.gross_salary), 0) AS salary_total
       FROM payroll_records pr
       JOIN placements p ON p.id = pr.placement_id
       JOIN finance_customers fc ON fc.id = p.client_id
       WHERE pr.period_month = $1 AND pr.period_year = $2
         AND pr.client_invoice_id IS NULL
       GROUP BY fc.id, fc.customer_name, fc.gstn, fc.state
       ORDER BY fc.customer_name`,
      [month, year],
    );
  }
}
