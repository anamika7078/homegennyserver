import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { round2, GST_RATE_DEFAULT } from '../../../common/finance/statutory-calc.util';
import {
  computeGst,
  formatInvoiceNumber,
  type SupplierTaxIdentity,
} from '../../../common/finance/gst.util';

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
 * line-item group (salary, employer ESIC, employer PF, management fee) and the
 * fee is what carries GST. See F-14 for the tax side.
 */
@Injectable()
export class ConsolidatedInvoiceService {
  private readonly logger = new Logger(ConsolidatedInvoiceService.name);

  constructor(private readonly dataSource: DataSource) {}

  /** Supplier tax identity from system_settings — blank until Finance fills it in. */
  private async supplierIdentity(): Promise<SupplierTaxIdentity> {
    const rows = await this.dataSource.query<{ key: string; value: unknown }[]>(
      `SELECT key, value FROM system_settings WHERE key LIKE 'finance.%'`,
    );
    const get = (k: string): string | null => {
      const raw = rows.find((r) => r.key === k)?.value;
      const v = typeof raw === 'string' ? raw : raw == null ? '' : String(raw).replace(/^"|"$/g, '');
      return v.trim() ? v.trim() : null;
    };
    return {
      legalName: get('finance.supplier_legal_name') ?? 'HomeGenny',
      gstin: get('finance.supplier_gstin'),
      state: get('finance.supplier_state'),
      sacCode: get('finance.sac_code'),
    };
  }

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
  ) {
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
              p.management_fee
       FROM payroll_records pr
       JOIN placements p ON p.id = pr.placement_id
       JOIN staff_applicants sa ON sa.id = pr.staff_id
       WHERE p.client_id = $1
         AND pr.period_month = $2 AND pr.period_year = $3
         AND pr.client_invoice_id IS NULL
       ORDER BY sa.staff_code`,
      [customerId, month, year],
    );

    const supplier = await this.supplierIdentity();

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
      items.push({
        ...base,
        description: `${l.staff_name} — Staff Salary (${this.workingFor(l, month, year)})`,
        amount: salary, is_taxable: false, sort_order: order++,
      });
      if (esic > 0) items.push({ ...base, description: `${l.staff_name} — Employer ESIC`, amount: esic, is_taxable: false, sort_order: order++ });
      if (pf > 0) items.push({ ...base, description: `${l.staff_name} — Employer PF`, amount: pf, is_taxable: false, sort_order: order++ });
      items.push({ ...base, description: `${l.staff_name} — Management Fee`, amount: fee, is_taxable: true, sort_order: order++ });
    }

    const gst = computeGst({
      managementFee: round2(feeTotal),
      gstRatePct: GST_RATE_DEFAULT,
      supplier,
      recipientGstin: cust.gstn,
      recipientState: cust.state,
    });

    if (gst.totalTax > 0) {
      items.push({
        staff_id: '', staff_name: '', placement_id: '',
        description: gst.isInterState
          ? `IGST @ ${GST_RATE_DEFAULT}% on management fee`
          : `CGST @ ${GST_RATE_DEFAULT / 2}% + SGST @ ${GST_RATE_DEFAULT / 2}% on management fee`,
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
      staff_count: lines.length,
      document_type: gst.documentType,
      supplier,
      recipient_gstin: cust.gstn,
      recipient_state: cust.state,
      place_of_supply: gst.placeOfSupply,
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

  async generate(customerId: string, month: number, year: number, actorId?: string) {
    const existing = await this.dataSource.query<{ id: string; invoice_number: string }[]>(
      `SELECT id, invoice_number FROM client_invoices
       WHERE client_id = $1 AND period_month = $2 AND period_year = $3 AND is_consolidated = true
       LIMIT 1`,
      [customerId, month, year],
    );
    if (existing.length) {
      throw new BadRequestException(
        `A consolidated invoice already exists for this customer in ${month}/${year} (${existing[0].invoice_number}).`,
      );
    }

    const preview = await this.preview(customerId, month, year);
    if (preview.staff_count === 0) {
      throw new BadRequestException(
        `No un-invoiced payroll for this customer in ${month}/${year}.`,
      );
    }
    if (!preview.reconciles) {
      throw new BadRequestException('Line items do not reconcile to the invoice total — refusing to issue.');
    }

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

      const dueDate = new Date(year, month, 5);
      const t = preview.totals;

      const invoiceResult = await manager.query(
        `INSERT INTO client_invoices
           (id, placement_id, client_id, invoice_number, invoice_seq, period_month, period_year,
            staff_salary_component, management_fee, gst_amount, esic_employer, pf_employer,
            total_amount, due_date, status, is_consolidated, document_type,
            supplier_gstin, supplier_state, recipient_gstin, recipient_state,
            place_of_supply, sac_code, taxable_value, cgst_amount, sgst_amount, igst_amount)
         VALUES (gen_random_uuid(), NULL, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DRAFT',true,
                 $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
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
        ],
      );
      // Same `[rows, affectedCount]` shape as the UPDATE above.
      const invoiceRows = (Array.isArray(invoiceResult[0]) ? invoiceResult[0] : invoiceResult) as
        Record<string, unknown>[];
      const invoice = invoiceRows[0];
      if (!invoice?.id) {
        throw new BadRequestException('Invoice insert returned no row — nothing was issued.');
      }

      for (const item of preview.line_items) {
        await manager.query(
          `INSERT INTO invoice_items
             (id, invoice_id, description, amount, is_taxable, staff_id, staff_name,
              placement_id, sac_code, sort_order)
           VALUES (gen_random_uuid(), $1,$2,$3,$4,
                   NULLIF($5,'')::uuid, NULLIF($6,''), NULLIF($7,'')::uuid, $8, $9)`,
          [
            invoice.id, item.description, item.amount, item.is_taxable,
            item.staff_id, item.staff_name, item.placement_id,
            item.is_taxable ? preview.sac_code : null, item.sort_order,
          ],
        );
      }

      // Link each payroll row to the invoice that billed it, so the same work
      // can never be invoiced twice.
      await manager.query(
        `UPDATE payroll_records SET client_invoice_id = $1 WHERE id = ANY($2::uuid[])`,
        [invoice.id, preview.payroll_ids],
      );

      this.logger.log(
        `[CONSOLIDATED_INVOICE] ${invoiceNumber} — ${preview.staff_count} staff, ` +
        `${preview.document_type}, total ${t.total}, by ${actorId ?? 'unknown'}`,
      );

      return { invoice, preview };
    });
  }

  /**
   * Issue this client's invoice for the period, or fold newly-run payroll into
   * the one already open.
   *
   * Payroll is produced one staff member at a time, but a client is owed one
   * invoice. So when the second person's payroll lands, the right answer is not
   * a second invoice — it is the same invoice, now listing two people. That is
   * only safe while the document is still a DRAFT: once it has been approved or
   * sent, the client has seen it, and the correction is a credit note rather
   * than a silent edit.
   *
   * Returns `{ invoice, preview, amended }`.
   */
  async generateOrAmend(customerId: string, month: number, year: number, actorId?: string) {
    const open = await this.dataSource.query<
      { id: string; invoice_number: string; status: string }[]
    >(
      `SELECT id, invoice_number, status FROM client_invoices
        WHERE client_id = $1 AND period_month = $2 AND period_year = $3
          AND status <> 'CANCELLED'
        LIMIT 1`,
      [customerId, month, year],
    );

    if (!open.length) {
      const result = await this.generate(customerId, month, year, actorId);
      return { ...result, amended: false };
    }

    const existing = open[0];
    if (existing.status !== 'DRAFT') {
      throw new BadRequestException(
        `Invoice ${existing.invoice_number} for ${month}/${year} is already ${existing.status} — ` +
          `it cannot be amended. Issue a credit note instead.`,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      // Release this invoice's payroll so the recompute below sees the full
      // set — the rows already on it, plus whatever has been run since.
      await manager.query(
        `UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`,
        [existing.id],
      );
      await manager.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [existing.id]);

      const preview = await this.preview(customerId, month, year, manager);
      if (preview.staff_count === 0) {
        throw new BadRequestException(
          `No payroll left to bill for this customer in ${month}/${year}.`,
        );
      }
      if (!preview.reconciles) {
        throw new BadRequestException(
          'Line items do not reconcile to the invoice total — refusing to amend.',
        );
      }

      const t = preview.totals;
      // The invoice keeps its id and its number: a client who has been told
      // "your invoice is BILL/0007" must not find it renumbered.
      const updated = await manager.query(
        `UPDATE client_invoices
            SET staff_salary_component = $2, management_fee = $3, gst_amount = $4,
                esic_employer = $5, pf_employer = $6, total_amount = $7,
                document_type = $8, taxable_value = $9,
                cgst_amount = $10, sgst_amount = $11, igst_amount = $12
          WHERE id = $1
        RETURNING *`,
        [
          existing.id,
          t.staff_salary, t.management_fee, t.gst_total, t.employer_esic, t.employer_pf,
          t.total, preview.document_type, t.taxable_value, t.cgst, t.sgst, t.igst,
        ],
      );
      // TypeORM hands back `[rows, affectedCount]` for UPDATE ... RETURNING.
      const updatedRows = (Array.isArray(updated[0]) ? updated[0] : updated) as
        Record<string, unknown>[];
      const invoice = updatedRows[0];

      for (const item of preview.line_items) {
        await manager.query(
          `INSERT INTO invoice_items
             (id, invoice_id, description, amount, is_taxable, staff_id, staff_name,
              placement_id, sac_code, sort_order)
           VALUES (gen_random_uuid(), $1,$2,$3,$4,
                   NULLIF($5,'')::uuid, NULLIF($6,''), NULLIF($7,'')::uuid, $8, $9)`,
          [
            existing.id, item.description, item.amount, item.is_taxable,
            item.staff_id, item.staff_name, item.placement_id,
            item.is_taxable ? preview.sac_code : null, item.sort_order,
          ],
        );
      }

      await manager.query(
        `UPDATE payroll_records SET client_invoice_id = $1 WHERE id = ANY($2::uuid[])`,
        [existing.id, preview.payroll_ids],
      );

      this.logger.log(
        `[CONSOLIDATED_INVOICE] amended ${existing.invoice_number} — now ` +
          `${preview.staff_count} staff, total ${t.total}, by ${actorId ?? 'unknown'}`,
      );

      return { invoice, preview, amended: true };
    });
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
              p.shift_hours,
              sa.staff_code, sa.full_name AS staff_name,
              COALESCE(a.days, 0)::int    AS days_this_period,
              COALESCE(a.hours, 0)::float AS hours_this_period,
              pr.id IS NOT NULL           AS payroll_run,
              pr.client_invoice_id IS NOT NULL AS invoiced
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
         LEFT JOIN payroll_records pr
           ON pr.placement_id = p.id AND pr.period_month = $2 AND pr.period_year = $3
        WHERE p.client_id = $1 AND p.status IN ('CONFIRMED','TRIAL')
        ORDER BY p.placement_type, sa.staff_code`,
      [customer.id, month, year],
    );

    const existing = await this.dataSource.query<
      { id: string; invoice_number: string; status: string; total_amount: string }[]
    >(
      `SELECT id, invoice_number, status, total_amount
         FROM client_invoices
        WHERE client_id = $1 AND period_month = $2 AND period_year = $3
          AND status <> 'CANCELLED'
        LIMIT 1`,
      [customer.id, month, year],
    );

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
      existing_invoice: existing[0] ?? null,
      un_invoiced: {
        staff_count: parseInt(pending[0]?.n ?? '0', 10),
        salary_total: parseFloat(pending[0]?.total ?? '0'),
      },
    };
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
