import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { amountInWords } from '../../../common/finance/amount-in-words.util';
import { buildServiceLines, periodRange, type ServiceLine } from '../../../common/finance/service-lines.util';
import { assertTransition, type InvoiceStatus } from '../../../common/finance/invoice-status';
import { readSupplierSettings } from '../../../common/finance/supplier-settings';
import { formatPeriod, isoDate, monthBounds, type Period } from '../../../common/finance/period.util';
import { designationFor } from '../../../common/finance/service-lines.util';
import { NotificationsService } from '../../notifications/notifications.service';
import {
  monthLabel, releaseInvoicePayroll, unreleaseInvoicePayroll, type ReleasedRow,
} from '../../../common/finance/payroll-release';

export interface InvoiceRow {
  id: string;
  placement_id: string | null;
  client_id: string | null;
  invoice_number: string;
  period_month: number;
  period_year: number;
  staff_salary_component: string;
  management_fee: string;
  gst_amount: string;
  esic_employer?: string;
  pf_employer?: string;
  total_amount: string;
  due_date: string;
  paid_at: string | null;
  payment_ref: string | null;
  razorpay_order_id: string | null;
  status: string;
  created_at: string;
  client_name?: string;
  is_consolidated?: boolean;
  /** Set only on legacy per-placement invoices, which billed one person. */
  staff_name?: string;
  staff_code?: string;
  /** How many people this invoice bills — the client-first replacement for staff_name. */
  staff_count?: number;
  type?: 'PLACEMENT' | 'EMPLOYEE';
}

@Injectable()
export class FinanceInvoiceService {
  private readonly logger = new Logger(FinanceInvoiceService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  async listInvoices(params: { status?: string; page?: number; limit?: number } = {}) {
    try {
      const page  = params.page  ?? 1;
      const limit = params.limit ?? 50;
      const offset = (page - 1) * limit;

      let sql = `
        SELECT * FROM (
          SELECT
            ci.id,
            ci.placement_id,
            ci.client_id,
            ci.invoice_number,
            ci.period_month,
            ci.period_year,
            ci.staff_salary_component,
            ci.management_fee,
            ci.gst_amount,
            ci.total_amount,
            ci.due_date,
            ci.paid_at,
            ci.payment_ref,
            ci.razorpay_order_id,
            ci.status,
            ci.created_at,
            ci.is_consolidated,
            -- What the GST was charged on. The list used to divide the tax by
            -- the management fee and print "170% GST on fee", because the tax
            -- is on the whole value now, not on the fee.
            ci.taxable_value,
            ci.document_type,
            -- An invoice can cover part of a month now; the list shows its dates.
            ci.period_from,
            ci.period_to,
            -- A rejected invoice says why in the list, not only when opened.
            ci.reject_reason,
            ci.rejected_at,
            c.customer_name AS client_name,
            -- Only a legacy per-placement invoice has a single staff member.
            -- A consolidated invoice covers a whole client, so it reports how
            -- many people it bills instead. See ONE_STAFF_MODEL_PLAN.md §F3.
            sa.full_name  AS staff_name,
            sa.staff_code AS staff_code,
            (SELECT COUNT(DISTINCT ii.staff_id)::int
               FROM invoice_items ii
              WHERE ii.invoice_id = ci.id AND ii.staff_id IS NOT NULL) AS staff_count,
            'PLACEMENT'   AS type
          FROM client_invoices ci
          LEFT JOIN finance_customers c ON c.id = ci.client_id
          LEFT JOIN placements p ON p.id = ci.placement_id
          LEFT JOIN staff_applicants sa ON sa.id = p.staff_id

          UNION ALL

          SELECT
            ep.id,
            NULL::uuid           AS placement_id,
            NULL::uuid           AS client_id,
            ('PAY-' || ep.period_year || LPAD(ep.period_month::text, 2, '0') || '-' || SUBSTRING(emp.employee_id, 1, 6)) AS invoice_number,
            ep.period_month,
            ep.period_year,
            ep.gross_salary      AS staff_salary_component,
            0.00                 AS management_fee,
            0.00                 AS gst_amount,
            ep.net_salary        AS total_amount,
            ep.created_at::date  AS due_date,
            ep.disbursed_at      AS paid_at,
            NULL::varchar        AS payment_ref,
            NULL::varchar        AS razorpay_order_id,
            ep.status,
            ep.created_at,
            false                AS is_consolidated,
            NULL::numeric        AS taxable_value,
            NULL::varchar        AS document_type,
            NULL::date           AS period_from,
            NULL::date           AS period_to,
            NULL::text           AS reject_reason,
            NULL::timestamptz    AS rejected_at,
            'Internal HR'        AS client_name,
            emp.full_name        AS staff_name,
            emp.employee_id      AS staff_code,
            1                    AS staff_count,
            'EMPLOYEE'           AS type
          FROM employee_payrolls ep
          LEFT JOIN employees emp ON emp.id = ep.employee_id
        ) AS u
      `;

      const queryParams: unknown[] = [];
      if (params.status?.toUpperCase() === 'REJECTED') {
        sql += ` WHERE u.status = 'CANCELLED' AND u.rejected_at IS NOT NULL`;
      } else if (params.status) {
        queryParams.push(params.status.toUpperCase());
        sql += ` WHERE u.status = ${queryParams.length}`;
      }
      
      sql += ` ORDER BY u.created_at DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
      queryParams.push(limit, offset);

      const rows = await this.dataSource.query<InvoiceRow[]>(sql, queryParams);

      // Count query
      let countSql = `
        SELECT COUNT(*) AS total FROM (
          SELECT id, status FROM client_invoices
          UNION ALL
          SELECT id, status FROM employee_payrolls
        ) AS u
      `;
      const countParams: unknown[] = [];
      if (params.status?.toUpperCase() === 'REJECTED') {
        countSql = `SELECT COUNT(*) AS total FROM client_invoices WHERE status = 'CANCELLED' AND rejected_at IS NOT NULL`;
      } else if (params.status) {
        countParams.push(params.status.toUpperCase());
        countSql += ` WHERE u.status = $1`;
      }
      const countRow = await this.dataSource.query<{ total: string }[]>(countSql, countParams);
      const total = parseInt(countRow[0]?.total ?? '0', 10);

      return { data: rows, total, page, limit };
    } catch (e) {
      console.error('Error listing invoices/payrolls:', e);
      return { data: [], total: 0, page: params.page ?? 1, limit: params.limit ?? 50 };
    }
  }

  async getInvoice(
    id: string,
  ): Promise<InvoiceRow & { line_items: object; reconciles?: boolean; line_items_total?: number; rate_notes?: unknown[] }> {
    // 1. Try to get from client_invoices
    //
    // Joined to `finance_customers`, not the legacy `clients` table:
    // Placement.clientId is a finance_customers id (placement.service.ts
    // getClientMeta), and that is what gets copied onto the invoice — so the
    // old join could never match and every invoice showed a blank client.
    // Carrying gstn/pan_card through here is what F2's tax-invoice work needs.
    const rows = await this.dataSource.query<InvoiceRow[]>(
      `SELECT ci.*, c.customer_name AS client_name, c.gstn AS client_gstn,
              c.pan_card AS client_pan, c.address AS client_address,
              c.city AS client_city, c.state AS client_state,
              sa.full_name AS staff_name, sa.staff_code, 'PLACEMENT' AS type
       FROM client_invoices ci
       LEFT JOIN finance_customers c ON c.id = ci.client_id
       LEFT JOIN placements p ON p.id = ci.placement_id
       LEFT JOIN staff_applicants sa ON sa.id = p.staff_id
       WHERE ci.id = $1`,
      [id],
    );

    if (rows.length) {
      const inv = rows[0];

      // Real line items, written alongside the invoice by
      // PayrollService.insertInvoiceWithItems(). They sum to total_amount by
      // construction — the old hardcoded list omitted employer ESIC/PF and so
      // came up short of the invoice's own total (F-03).
      const stored = await this.dataSource.query<{
        description: string; amount: string; is_taxable: boolean;
      }[]>(
        `SELECT description, amount, is_taxable
         FROM invoice_items WHERE invoice_id = $1 ORDER BY created_at`,
        [id],
      );

      const line_items = stored.length
        ? stored.map((li) => ({
            description: li.description,
            amount: parseFloat(li.amount),
            gst_applicable: li.is_taxable,
          }))
        // Invoices raised before F1 have no stored items. Reconstruct from the
        // columns, including the employer contributions now persisted, rather
        // than showing a set that doesn't add up.
        : [
            { description: 'Staff Salary Component', amount: parseFloat(inv.staff_salary_component), gst_applicable: false },
            { description: 'Employer ESIC',          amount: parseFloat(inv.esic_employer ?? '0'),   gst_applicable: false },
            { description: 'Employer PF',            amount: parseFloat(inv.pf_employer ?? '0'),     gst_applicable: false },
            { description: 'Management Fee',         amount: parseFloat(inv.management_fee),         gst_applicable: true  },
            { description: 'GST',                    amount: parseFloat(inv.gst_amount),             gst_applicable: false },
          ];

      // Who this invoice bills.
      //
      // A consolidated invoice covers every staff member placed with the
      // client, so it has no `placement_id` and the join above leaves
      // staff_name null — which is why the document used to print "Staff: — ()"
      // and the dialog said "0 staff" even with four line items naming a
      // person. The line items are the authority on who is billed.
      const billed = await this.dataSource.query<{ staff_name: string; staff_code: string }[]>(
        `SELECT DISTINCT sa.full_name AS staff_name, sa.staff_code
           FROM invoice_items ii
           JOIN staff_applicants sa ON sa.id = ii.staff_id
          WHERE ii.invoice_id = $1 AND ii.staff_id IS NOT NULL
          ORDER BY sa.staff_code`,
        [id],
      );
      const staff_name = inv.staff_name ?? (billed.length ? billed.map((b) => b.staff_name).join(', ') : undefined);
      const staff_code = inv.staff_code ?? (billed.length === 1 ? billed[0].staff_code : undefined);

      const itemsTotal = Math.round(line_items.reduce((s, li) => s + li.amount, 0) * 100) / 100;
      const total = parseFloat(inv.total_amount);

      return {
        ...inv,
        staff_name,
        staff_code,
        staff_count: billed.length || (inv.staff_name ? 1 : 0),
        line_items,
        // Surfaced rather than hidden: a legacy invoice whose stored columns
        // can't explain its total should be visible to Finance, not silently
        // rendered as if it balanced.
        reconciles: Math.abs(itemsTotal - total) <= 0.01,
        line_items_total: itemsTotal,
        rate_notes: await this.rateNotes(id),
      };
    }

    // 2. Try to get from employee_payrolls
    const empRows = await this.dataSource.query<any[]>(
      `SELECT ep.*, emp.full_name AS staff_name, emp.employee_id AS staff_code, emp.department
       FROM employee_payrolls ep
       LEFT JOIN employees emp ON emp.id = ep.employee_id
       WHERE ep.id = $1`,
      [id],
    );

    if (empRows.length) {
      const r = empRows[0];
      const gross = parseFloat(r.gross_salary);
      const net = parseFloat(r.net_salary);
      const dec = typeof r.deductions === 'string' ? JSON.parse(r.deductions) : r.deductions;
      const esic = parseFloat(dec?.esic ?? 0);
      const pf = parseFloat(dec?.pf ?? 0);

      const line_items = [
        { description: 'Gross Salary Component', amount: gross, gst_applicable: false },
        { description: 'ESIC Deduction (0.75%)', amount: -esic, gst_applicable: false },
        { description: 'PF Deduction (12%)',    amount: -pf,   gst_applicable: false },
        { description: 'Net Salary (Disbursed)', amount: net,   gst_applicable: false },
      ];

      return {
        id: r.id,
        placement_id: null,
        client_id: null,
        invoice_number: `PAY-${r.period_year}${String(r.period_month).padStart(2, '0')}-${r.staff_code?.slice(0, 6).toUpperCase()}`,
        period_month: r.period_month,
        period_year: r.period_year,
        staff_salary_component: r.gross_salary,
        management_fee: '0.00',
        gst_amount: '0.00',
        total_amount: r.net_salary,
        due_date: r.created_at,
        paid_at: r.disbursed_at,
        payment_ref: null,
        razorpay_order_id: null,
        status: r.status,
        created_at: r.created_at,
        client_name: 'Internal HR',
        staff_name: r.staff_name,
        staff_code: r.staff_code,
        type: 'EMPLOYEE',
        line_items,
      } as any;
    }

    throw new NotFoundException(`Invoice or payroll record ${id} not found`);
  }

  /**
   * The supplier's own identity, as it has to appear on the document.
   *
   * Read fresh rather than cached: these are filled in once, by hand, and a
   * document printed from a stale blank GSTIN would be the wrong document
   * entirely.
   */
  private supplierIdentity() {
    return readSupplierSettings(this.dataSource);
  }

  /**
   * The lines the client sees: one per kind of staff, all-inclusive.
   *
   * `invoice_items` holds the real breakdown — salary, employer ESIC, employer
   * PF, fee — and keeps reconciling to the total, because Finance and the
   * statutory filings read it. None of that belongs on the client's copy, so
   * this rebuilds the lines from the payroll rows the invoice settled: how
   * many people, how many duties, what it came to.
   *
   * Falls back to the stored items when an invoice has no payroll linked to it
   * (one raised by hand, or an old per-placement invoice), because a document
   * that renders nothing is worse than one showing the breakdown.
   */
  private async clientServiceLines(
    invoiceId: string, month: number, year: number,
  ): Promise<ServiceLine[] | null> {
    const rows = await this.dataSource.query<{
      staff_name: string; series: string | null; placement_type: string | null;
      shift_days: string | null; hours_worked: string | null; hourly_rate: string | null;
      shift_hours: string | null; amount: string | null;
      rate_basis: string | null; duties: string | null; duty_billing_rate: string | null;
    }[]>(
      `SELECT sa.full_name AS staff_name, sa.series::text AS series,
              pr.placement_type, pr.shift_days, pr.hours_worked, pr.hourly_rate,
             pr.rate_basis, pr.duties, pr.duty_billing_rate,
              p.shift_hours,
              (SELECT COALESCE(SUM(ii.amount), 0) FROM invoice_items ii
                WHERE ii.invoice_id = $1 AND ii.staff_id = pr.staff_id) AS amount
         FROM payroll_records pr
         JOIN placements p ON p.id = pr.placement_id
         JOIN staff_applicants sa ON sa.id = pr.staff_id
        WHERE pr.client_invoice_id = $1
        ORDER BY sa.staff_code`,
      [invoiceId],
    );
    if (!rows.length) return null;

    const { days } = periodRange(month, year);
    return buildServiceLines(
      rows.map((r) => ({
        staff_name: r.staff_name,
        series: r.series,
        placement_type: r.placement_type,
        shift_days: Number(r.shift_days ?? 0),
        hours_worked: r.hours_worked == null ? null : Number(r.hours_worked),
        rate_basis: r.rate_basis ?? null,
        duties: r.duties == null ? null : Number(r.duties),
        duty_billing_rate: r.duty_billing_rate == null ? null : Number(r.duty_billing_rate),
        hourly_rate: r.hourly_rate == null ? null : Number(r.hourly_rate),
        shift_hours: r.shift_hours == null ? null : Number(r.shift_hours),
        amount: Number(r.amount ?? 0),
      })),
      days,
    );
  }

  /**
   * The printable document a client actually receives.
   *
   * It carries what an Indian tax invoice is required to carry: both parties
   * named with their GSTINs, the place of supply, the SAC for the service, the
   * taxable value stated apart from the tax, that tax split into CGST+SGST or
   * IGST according to where the supply lands, and the total in words as well
   * as figures.
   *
   * With no supplier GSTIN on file the heading reads **Bill of Supply** and no
   * tax is shown, because that is the correct document for an unregistered
   * supplier. The template this replaces called every document a "Client
   * Invoice" regardless, showed no tax breakdown at all, and printed
   * "Staff: — ()" on every consolidated invoice. What is still missing to make
   * this a tax invoice is now stated on the document instead of left for
   * someone to notice.
   */
  /**
   * The days an invoice covers, as the document prints them.
   *
   * `period_from`/`period_to` are what the invoice locks — no other invoice
   * can bill those days. The printed "From" is when service actually began
   * inside them: a household whose first live-in started on the 5th reads
   * "From 05/10 To 31/10", not from the 1st.
   */
  private async printedPeriod(
    invoiceId: string, row: Record<string, unknown>, month: number, year: number,
  ): Promise<Period> {
    const bounds = monthBounds(month, year);
    const from = isoDate(row.period_from) ?? bounds.from;
    const to = isoDate(row.period_to) ?? bounds.to;
    const started = await this.dataSource.query<{ d: unknown }[]>(
      `SELECT MIN(GREATEST(pr.period_from, COALESCE(p.trial_start_date, p.confirmed_at::date, pr.period_from))) AS d
         FROM payroll_records pr
         JOIN placements p ON p.id = pr.placement_id
        WHERE pr.client_invoice_id = $1`,
      [invoiceId],
    ).catch(() => []);
    const first = isoDate(started[0]?.d);
    return { from: first && first > from && first <= to ? first : from, to };
  }

  async generateInvoiceHtml(id: string): Promise<string> {
    const inv = await this.getInvoice(id);
    const supplier = await this.supplierIdentity();

    const fmt = (n: number | string) =>
      new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        .format(Number(n ?? 0));
    const esc = (s: unknown) =>
      String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

    const isPayslip = inv.type === 'EMPLOYEE';
    const row = inv as unknown as Record<string, string | number | null>;

    const cgst = Number(row.cgst_amount ?? 0);
    const sgst = Number(row.sgst_amount ?? 0);
    const igst = Number(row.igst_amount ?? 0);
    const totalTax = Number(row.gst_amount ?? 0);
    // What the tax was charged on, as recorded at the time. An invoice raised
    // under the old rule stored the management fee alone here, so this is not
    // always the sum of the lines below — and the tax rows have to keep
    // naming the base that was actually used, whatever that was.
    const taxedOn = Number(row.taxable_value ?? 0)
      || Math.round((Number(inv.total_amount) - totalTax) * 100) / 100;
    const sac = row.sac_code ?? supplier.sacCode;
    const isTaxInvoice = row.document_type === 'TAX_INVOICE';
    const title = isPayslip ? 'Staff Payslip' : isTaxInvoice ? 'Tax Invoice' : 'Bill of Supply';

    // A tax invoice prints the GSTIN and state it was issued under, not
    // whatever the settings say today.
    const supplierGstin = (isTaxInvoice ? (row.supplier_gstin as string | null) : null) ?? supplier.gstin;
    const supplierState = (isTaxInvoice ? (row.supplier_state as string | null) : null) ?? supplier.state;

    // The rate actually charged, read back from the stored figures. The labels
    // used to be hardcoded to 18% / 9% whatever rate had been applied.
    const ratePct = taxedOn > 0 ? Math.round((totalTax / taxedOn) * 10000) / 100 : 0;
    const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, '')}%`;

    // What the client is charged for, stated the way the trade states it: one
    // line per kind of staff, strength and duties and the all-in rate. The
    // salary/ESIC/PF/fee breakdown behind it stays on invoice_items, where
    // Finance and the statutory filings read it, and off the client's copy.
    const service = isPayslip ? null : await this.clientServiceLines(id, inv.period_month, inv.period_year);
    const charges = (inv.line_items as { description: string; amount: number }[])
      .filter((li) => !/^(CGST|SGST|IGST|GST)\b/i.test(li.description));

    const lineRows = (service ?? charges.map((li) => ({ strength: 1, ...li })))
      .map((li, i) => `
        <tr>
          <td class="c">${i + 1}</td>
          <td class="c">${service ? (li as ServiceLine).strength.toFixed(2) : ''}</td>
          <td>${esc(li.description)}</td>
          <td class="c">${esc(sac ?? '—')}</td>
          <td class="r">${fmt(li.amount)}</td>
        </tr>`).join('');

    // The subtotal has to be the lines printed above it, or the document
    // contradicts itself. A legacy invoice stored only the management fee as
    // its taxable value, so taking that figure here printed "Amount 466.67"
    // above a total of 5,307.17 — the tax rows still name the base the tax was
    // charged on, which for such an invoice is genuinely the smaller number.
    const lineTotal = (service ?? charges).reduce((t, li) => t + Number(li.amount ?? 0), 0);
    const subtotal = Math.round(lineTotal * 100) / 100;

    const period = await this.printedPeriod(id, row as Record<string, unknown>, inv.period_month, inv.period_year);
    const asDate = (iso: string) => iso.split('-').reverse().join('/');

    // Each tax line states the value it was charged on as well as the tax, so
    // the rate can be checked against the base without doing the sum.
    const taxLine = (label: string, amount: number) =>
      `<tr><td>${label}</td><td class="r base">${fmt(taxedOn)}</td><td class="r">${fmt(amount)}</td></tr>`;
    const taxRows = isPayslip ? '' : igst > 0
      ? taxLine(`${pct(ratePct)} IGST`, igst)
      : (cgst > 0 || sgst > 0)
        ? taxLine(`${pct(ratePct / 2)} CGST`, cgst) + taxLine(`${pct(ratePct / 2)} SGST`, sgst)
        : '';

    // Say on the document why it carries no tax, rather than quietly issuing
    // a lesser one and hoping someone checks. Driven by what the invoice *is*
    // (its stored type) — reading only today's settings printed "this is a
    // Bill of Supply" on a Tax Invoice whenever a setting was later cleared.
    const missing: string[] = [];
    if (!isPayslip && !isTaxInvoice) {
      if (!supplier.isRegistered) missing.push('supplier GSTIN');
      if (!supplier.state) missing.push('supplier state');
      if (!sac) missing.push('SAC code');
    }
    const notice = isPayslip || isTaxInvoice
      ? ''
      : missing.length
        ? `<div class="notice"><strong>This is a Bill of Supply, not a Tax Invoice.</strong>
             No GST has been charged, because this is not on file yet:
             ${esc(missing.join(', '))}. Add it under Finance → Company &amp; GST and
             invoices raised afterwards will carry tax.</div>`
        : `<div class="notice"><strong>This is a Bill of Supply, not a Tax Invoice.</strong>
             It was raised before the GST registration was recorded, so no GST was
             charged. Finance can recalculate it as a Tax Invoice while it has not
             been sent.</div>`;

    const bankBlock = (supplier.bankAccount || supplier.bankIfsc)
      ? `<div class="bank"><div class="h">Bank details for payment</div>
           <div>${esc(supplier.bankName ?? '')}${supplier.bankBranch ? ' — ' + esc(supplier.bankBranch) : ''}</div>
           <div>A/c <strong>${esc(supplier.bankAccount ?? '—')}</strong> &nbsp;·&nbsp;
                IFSC <strong>${esc(supplier.bankIfsc ?? '—')}</strong></div></div>`
      : '';

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(title)} ${esc(inv.invoice_number)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:820px;margin:32px auto;
       padding:32px;color:#0f172a;font-size:13px;line-height:1.5}
  h1{margin:0;font-size:24px;letter-spacing:-.01em}
  .doc{margin:2px 0 0;font-size:15px;font-weight:600;color:#334155;
       text-transform:uppercase;letter-spacing:.06em}
  .rule{height:2px;background:#0f172a;margin:16px 0 20px}
  .parties{display:flex;gap:32px;margin-bottom:20px}
  .parties>div{flex:1}
  .h{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin-bottom:4px}
  .name{font-weight:700;font-size:14px}
  .meta{margin:0 0 20px;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden}
  .meta div{display:flex;justify-content:space-between;padding:6px 12px;border-bottom:1px solid #f1f5f9}
  .meta div:last-child{border-bottom:0}
  .meta span{color:#64748b}
  table.items{width:100%;border-collapse:collapse;margin-bottom:16px}
  table.items th{background:#0f172a;color:#fff;font-size:10px;text-transform:uppercase;
                 letter-spacing:.06em;padding:8px;text-align:left}
  table.items td{padding:8px;border-bottom:1px solid #e2e8f0}
  .r{text-align:right;font-variant-numeric:tabular-nums}
  .c{text-align:center}
  tr.svc td{padding:10px 8px;text-align:center;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-weight:600}
  tr.svc .range{display:inline-block;margin-top:4px;font-weight:400;color:#475569}
  .totals{margin-left:auto;width:400px}
  .totals .base{color:#64748b;font-weight:400;width:110px}
  .totals table{width:100%;border-collapse:collapse}
  .totals td{padding:5px 8px}
  .totals tr.sum td{border-top:1px solid #cbd5e1;font-weight:600}
  .totals tr.grand td{border-top:2px solid #0f172a;font-size:15px;font-weight:700;padding-top:8px}
  .words{clear:both;margin:18px 0;padding:10px 12px;background:#f8fafc;border-left:3px solid #0f172a}
  .notice{margin:16px 0;padding:10px 12px;background:#fffbeb;border-left:3px solid #d97706;color:#78350f}
  .bank{margin-top:20px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:6px}
  .foot{margin-top:28px;padding-top:12px;border-top:1px solid #e2e8f0;
        display:flex;justify-content:space-between;color:#94a3b8;font-size:11px}
</style></head>
<body>
  <h1>${esc(supplier.legalName)}</h1>
  <p class="doc">${esc(title)}</p>
  <div class="rule"></div>

  <div class="parties">
    <div>
      <div class="h">Supplier</div>
      <div class="name">${esc(supplier.legalName)}</div>
      ${supplier.address ? `<div>${esc(supplier.address)}</div>` : ''}
      <div>GSTIN: ${esc(supplierGstin ?? '—')}</div>
      ${supplier.pan ? `<div>PAN: ${esc(supplier.pan)}</div>` : ''}
      <div>State: ${esc(supplierState ?? '—')}</div>
    </div>
    <div>
      <div class="h">Billed to</div>
      <div class="name">${esc(inv.client_name ?? '—')}</div>
      ${row.client_address ? `<div>${esc(row.client_address)}</div>` : ''}
      <div>GSTIN: ${esc(row.client_gstn ?? '—')}</div>
      ${row.client_pan ? `<div>PAN: ${esc(row.client_pan)}</div>` : ''}
      <div>State: ${esc(row.client_state ?? '—')}</div>
    </div>
  </div>

  <div class="meta">
    <div><span>${isPayslip ? 'Payslip' : 'Invoice'} no.</span><strong>${esc(inv.invoice_number)}</strong></div>
    <div><span>Date</span><strong>${new Date(inv.due_date).toLocaleDateString('en-IN')}</strong></div>
    <div><span>Period</span><strong>${isPayslip
      ? `${String(inv.period_month).padStart(2, '0')}/${inv.period_year}`
      : `${asDate(period.from)} – ${asDate(period.to)}`}</strong></div>
    ${!isPayslip ? `<div><span>Place of supply</span><strong>${esc(row.place_of_supply ?? row.client_state ?? '—')}</strong></div>` : ''}
    ${!isPayslip ? `<div><span>Staff strength</span><strong>${inv.staff_count ?? 0}</strong></div>` : ''}
    ${inv.staff_name ? `<div><span>Staff billed</span><strong>${esc(inv.staff_name)}</strong></div>` : ''}
    <div><span>Status</span><strong>${esc(inv.status)}</strong></div>
  </div>

  ${notice}

  <table class="items">
    <thead><tr><th style="width:36px">S.No.</th><th style="width:66px" class="c">Strength</th>
      <th>Description of Service</th>
      <th style="width:80px" class="c">SAC</th><th style="width:120px" class="r">Amount (₹)</th></tr></thead>
    ${isPayslip ? '' : `<tr class="svc"><td colspan="5">
      Service charges for domestic staff services rendered at your premises<br>
      <span class="range">From <strong>${asDate(period.from)}</strong> To <strong>${asDate(period.to)}</strong></span>
    </td></tr>`}
    <tbody>${lineRows}</tbody>
  </table>

  <div class="totals"><table>
    <tr class="sum"><td>Amount</td><td class="r base"></td><td class="r">${fmt(subtotal)}</td></tr>
    ${taxRows}
    <tr class="grand"><td>Total</td><td class="r base"></td><td class="r">₹${fmt(inv.total_amount)}</td></tr>
  </table></div>

  <div class="words">
    <div class="h">Total invoice value (in words)</div>
    <strong>${esc(amountInWords(inv.total_amount).toUpperCase())}</strong>
  </div>

  ${bankBlock}

  <div class="foot">
    <span>Generated ${new Date().toLocaleString('en-IN')}</span>
    <span>For ${esc(supplier.legalName)}</span>
  </div>
</body></html>`;
  }

  /**
   * One salary slip per staff member billed on this invoice, for the same days.
   *
   * The invoice tells the client what the work cost; each slip tells the staff
   * member what they earned for it — duties (or days, or hours) at their rate,
   * less their ESIC and PF where those apply. Built from the very payroll rows
   * the invoice billed, so the two can never disagree. One printable page each.
   */
  async generateSalarySlipsHtml(invoiceId: string): Promise<string> {
    const [inv] = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT ci.id, ci.invoice_number, ci.status, ci.period_month, ci.period_year, ci.period_from, ci.period_to,
              fc.customer_name, fc.address, fc.city
         FROM client_invoices ci
         LEFT JOIN finance_customers fc ON fc.id = ci.client_id
        WHERE ci.id = $1`,
      [invoiceId],
    );
    if (!inv) throw new NotFoundException(`Invoice ${invoiceId} not found`);

    const rows = await this.dataSource.query<{
      staff_name: string; staff_code: string; series: string | null; placement_type: string | null;
      rate_basis: string | null; period_from: unknown; period_to: unknown; join_date: unknown;
      duties: string | null; duty_rate: string | null; shift_days: number | null;
      hours_worked: string | null; hourly_rate: string | null;
      gross_salary: string; esic_employee: string; pf_employee: string; net_salary: string;
      arrears: string | null; arrears_note: string | null;
      bank_account: string | null; bank_ifsc: string | null;
    }[]>(
      `SELECT sa.full_name AS staff_name, sa.staff_code, sa.series::text AS series,
              pr.placement_type, pr.rate_basis, pr.period_from, pr.period_to,
              COALESCE(p.trial_start_date, p.confirmed_at::date) AS join_date,
              pr.duties, pr.duty_rate, pr.shift_days, pr.hours_worked, pr.hourly_rate,
              pr.gross_salary, pr.esic_employee, pr.pf_employee, pr.net_salary, pr.arrears, pr.arrears_note,
              sba.account_number AS bank_account, sba.ifsc AS bank_ifsc
         FROM payroll_records pr
         JOIN placements p ON p.id = pr.placement_id
         JOIN staff_applicants sa ON sa.id = pr.staff_id
         LEFT JOIN LATERAL (
           SELECT account_number, ifsc FROM staff_bank_accounts b
            WHERE b.staff_id = pr.staff_id ORDER BY b.created_at DESC LIMIT 1
         ) sba ON true
        WHERE pr.client_invoice_id = $1
        ORDER BY sa.staff_code, pr.period_from`,
      [invoiceId],
    ).catch(async () =>
      // No bank-account table in this database: the slip prints without it.
      this.dataSource.query(
        `SELECT sa.full_name AS staff_name, sa.staff_code, sa.series::text AS series,
                pr.placement_type, pr.rate_basis, pr.period_from, pr.period_to,
                COALESCE(p.trial_start_date, p.confirmed_at::date) AS join_date,
                pr.duties, pr.duty_rate, pr.shift_days, pr.hours_worked, pr.hourly_rate,
                pr.gross_salary, pr.esic_employee, pr.pf_employee, pr.net_salary, pr.arrears, pr.arrears_note,
                NULL AS bank_account, NULL AS bank_ifsc
           FROM payroll_records pr
           JOIN placements p ON p.id = pr.placement_id
           JOIN staff_applicants sa ON sa.id = pr.staff_id
          WHERE pr.client_invoice_id = $1
          ORDER BY sa.staff_code, pr.period_from`,
        [invoiceId],
      ));
    if (!rows.length) {
      throw new BadRequestException(`${inv.invoice_number} bills no payroll, so there are no salary slips for it.`);
    }

    const supplier = await this.supplierIdentity();
    const fmt = (n: number | string) =>
      new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n ?? 0));
    const esc = (v: unknown) =>
      String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    const dmy = (v: unknown) => (isoDate(v) ?? '').split('-').reverse().join('/');

    // Finance can print these to check the figures before approving, but a
    // draft slip is not issued: the staff member cannot see it, and the rate
    // may still be corrected. The print says so on every page.
    const isDraft = inv.status === 'DRAFT';
    const draftBanner = isDraft
      ? `<div class="draft">DRAFT — not issued. Invoice ${esc(inv.invoice_number)} is awaiting Finance approval.</div>`
      : '';
    const slips = rows.map((r) => {
      const from = isoDate(r.period_from)!;
      const join = isoDate(r.join_date);
      const shownFrom = join && join > from && join <= isoDate(r.period_to)! ? join : from;
      const relief = r.placement_type === 'TEMPORARY';
      const worked = r.rate_basis === 'PER_DUTY'
        ? `${Number(r.duties)} ${Number(r.duties) === 1 ? 'duty' : 'duties'} × ₹${fmt(r.duty_rate ?? 0)}`
        : r.rate_basis === 'HOURLY' || (r.rate_basis == null && relief)
          ? `${Number(r.hours_worked ?? 0)} hours × ₹${fmt(r.hourly_rate ?? 0)}`
          : `${r.shift_days ?? 0} days`;
      const esic = Number(r.esic_employee ?? 0);
      const pf = Number(r.pf_employee ?? 0);
      return `
  <section class="slip">${draftBanner}
    <div class="head">
      <div><div class="co">${esc(supplier.legalName)}</div>
        ${supplier.address ? `<div class="muted">${esc(supplier.address)}</div>` : ''}</div>
      <div class="ttl">Salary Slip</div>
    </div>
    <table class="kv">
      <tr><td>Employee</td><td><strong>${esc(r.staff_name)}</strong> (${esc(r.staff_code)})</td>
          <td>Designation</td><td>${esc(designationFor(r.series))}${relief ? ' — relief' : ''}</td></tr>
      <tr><td>Period</td><td>${dmy(shownFrom)} – ${dmy(r.period_to)}</td>
          <td>Date of joining</td><td>${relief ? 'TEMP duty' : dmy(join) || '—'}</td></tr>
      <tr><td>Worked at</td><td colspan="3">${esc(inv.customer_name ?? '—')}${inv.city ? ', ' + esc(inv.city) : ''}</td></tr>
    </table>
    <table class="amt">
      <tr><th>Earnings</th><th class="r">₹</th><th>Deductions</th><th class="r">₹</th></tr>
      <tr><td>Wages (${esc(worked)})</td><td class="r">${fmt(r.gross_salary)}</td>
          <td>Employee PF</td><td class="r">${pf ? fmt(pf) : '—'}</td></tr>
      <tr><td></td><td></td><td>Employee ESIC</td><td class="r">${esic ? fmt(esic) : '—'}</td></tr>
      <tr class="tot"><td>Gross</td><td class="r">${fmt(r.gross_salary)}</td>
          <td>Total deductions</td><td class="r">${fmt(pf + esic)}</td></tr>
    </table>
    ${Number(r.arrears ?? 0) > 0
      ? `<div class="muted">Arrears (correction of an earlier invoice): ₹${fmt(r.arrears ?? 0)}${r.arrears_note ? ` — ${esc(r.arrears_note)}` : ''}</div>`
      : ''}
    <div class="net">Net pay <strong>₹${fmt(r.net_salary)}</strong></div>
    ${r.bank_account ? `<div class="muted">Paid to A/c ${esc(String(r.bank_account).replace(/.(?=.{4})/g, '•'))} · IFSC ${esc(r.bank_ifsc ?? '')}</div>` : ''}
    <div class="foot"><span>Against invoice ${esc(inv.invoice_number)}</span><span>Computer-generated — no signature required</span></div>
  </section>`;
    }).join('');

    const span = formatPeriod({ from: isoDate(inv.period_from)!, to: isoDate(inv.period_to)! });
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Salary slips — ${esc(inv.invoice_number)} (${esc(span)})</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;font-size:13px;margin:0;padding:24px}
  .slip{max-width:760px;margin:0 auto 28px;border:1px solid #cbd5e1;border-radius:8px;padding:20px;page-break-after:always}
  .slip:last-child{page-break-after:auto}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0f172a;padding-bottom:10px;margin-bottom:12px}
  .co{font-weight:700;font-size:16px}
  .ttl{font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#334155}
  .muted{color:#64748b;font-size:12px}
  table{width:100%;border-collapse:collapse;margin-bottom:12px}
  .kv td{padding:5px 6px;border-bottom:1px solid #f1f5f9}
  .kv td:nth-child(odd){color:#64748b;width:18%}
  .amt th{background:#0f172a;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:7px;text-align:left}
  .amt td{padding:7px;border-bottom:1px solid #e2e8f0}
  .amt tr.tot td{font-weight:600;border-top:1px solid #94a3b8}
  .r{text-align:right;font-variant-numeric:tabular-nums}
  .net{font-size:16px;padding:10px 12px;background:#f8fafc;border-left:3px solid #0f172a;margin-bottom:8px}
  .foot{display:flex;justify-content:space-between;color:#94a3b8;font-size:11px;margin-top:12px}
  .draft{background:#fef3c7;border:1px dashed #d97706;color:#92400e;font-weight:600;text-align:center;padding:6px;margin:-8px 0 12px;border-radius:4px}
  @media print{body{padding:0}.slip{border:0}}
</style></head><body>${slips}</body></html>`;
  }

  /**
   * Moves an invoice (or an internal payroll row shown alongside them) to a new
   * status, refusing anything the state machine disallows.
   *
   * Both actions used to be blind `UPDATE ... SET status = '...'`, so an
   * invoice could be re-approved after payment or revived after a credit note.
   * See F-12 and `common/finance/invoice-status.ts`.
   */
  private async transition(id: string, to: InvoiceStatus, successMessage: string) {
    const rows = await this.dataSource.query<{ id: string; status: string; invoice_number: string }[]>(
      `SELECT id, status, invoice_number FROM client_invoices WHERE id = $1`, [id],
    );
    if (rows.length) {
      const inv = rows[0];
      assertTransition(inv.status, to, inv.invoice_number);
      await this.dataSource.query(
        `UPDATE client_invoices SET status = $1 WHERE id = $2`, [to, id],
      );
      return { id, from: inv.status, status: to, message: successMessage };
    }

    const empRows = await this.dataSource.query<{ id: string; status: string }[]>(
      `SELECT id, status FROM employee_payrolls WHERE id = $1`, [id],
    );
    if (empRows.length) {
      const row = empRows[0];
      assertTransition(row.status, to);
      await this.dataSource.query(
        `UPDATE employee_payrolls SET status = $1 WHERE id = $2`, [to, id],
      );
      return { id, from: row.status, status: to, message: `Employee payroll ${to.toLowerCase()}` };
    }

    throw new NotFoundException(`Invoice or payroll ${id} not found`);
  }

  /**
   * Finance's approval of an invoice is the moment its figures — rates, duties,
   * totals — are accepted, so it is also the moment the salary built from them
   * is released: the payslips appear in the staff app and the rows become
   * payable. Before this, a DRAFT invoice's payroll was already on payslips and
   * could be paid out at a rate nobody had checked.
   */
  async approveInvoice(id: string, actorId?: string) {
    const out = await this.dataSource.transaction(async (m) => {
      const rows = await m.query(
        `SELECT id, status, invoice_number FROM client_invoices WHERE id = $1 FOR UPDATE`, [id],
      ) as { id: string; status: string; invoice_number: string }[];
      if (!rows.length) return null;
      const inv = rows[0];
      assertTransition(inv.status, 'APPROVED', inv.invoice_number);
      await m.query(
        `UPDATE client_invoices SET status = 'APPROVED', approved_by = $2, approved_at = NOW() WHERE id = $1`,
        [id, actorId ?? null],
      );
      const released = await releaseInvoicePayroll(m, id, actorId);
      // Finance has now looked at these rates on a real invoice. Cleared again
      // whenever the rate changes, so the next invoice flags what is new.
      await m.query(
        `UPDATE placements SET rate_verified_at = NOW(), rate_verified_by = $2, rate_verified_invoice_id = $1
          WHERE id IN (SELECT placement_id FROM payroll_records WHERE client_invoice_id = $1)`,
        [id, actorId ?? null],
      );
      return { from: inv.status, invoice_number: inv.invoice_number, released };
    });
    // Not a client invoice: an HR employee_payrolls row shown alongside them.
    if (!out) return this.transition(id, 'APPROVED', 'Invoice approved successfully');

    await this.notifyPayslipsReady(out.released);
    this.logger.log(
      `[INVOICE_APPROVED] ${out.invoice_number} by ${actorId ?? 'unknown'} — ${out.released.length} payslip(s) released`,
    );
    return {
      id, from: out.from, status: 'APPROVED' as const,
      message: 'Invoice approved successfully',
      payslips_released: out.released.length,
    };
  }

  /**
   * What Finance should look at before approving: for each placement on the
   * invoice, whether its rate has ever been through an approved invoice, and
   * every rate change since it last was — with who made it and why. Finance
   * reading the invoice is the rate check, so it has to show what is new.
   */
  async rateNotes(invoiceId: string) {
    const placements = await this.dataSource.query(
      `SELECT DISTINCT p.id AS placement_id, sa.full_name AS staff_name, p.rate_verified_at
         FROM payroll_records pr
         JOIN placements p ON p.id = pr.placement_id
         JOIN staff_applicants sa ON sa.id = p.staff_id
        WHERE pr.client_invoice_id = $1
        ORDER BY sa.full_name`,
      [invoiceId],
    ).catch(() => []) as { placement_id: string; staff_name: string; rate_verified_at: Date | null }[];
    if (!placements.length) return [];
    const changes = await this.dataSource.query(
      `SELECT c.placement_id, c.effective_from::text AS effective_from, c.before, c.after, c.reason,
              c.changed_at, u.full_name AS changed_by_name
         FROM placement_rate_changes c
         JOIN placements p ON p.id = c.placement_id
         LEFT JOIN users u ON u.id = c.changed_by
        WHERE c.placement_id = ANY($1::uuid[]) AND c.superseded_at IS NULL
          AND (p.rate_verified_at IS NULL OR c.changed_at > p.rate_verified_at)
        ORDER BY c.changed_at`,
      [placements.map((p) => p.placement_id)],
    ).catch(() => []) as {
      placement_id: string; effective_from: string; before: Record<string, unknown>; after: Record<string, unknown>;
      reason: string | null; changed_at: Date; changed_by_name: string | null;
    }[];
    const fields = ['staff_salary', 'management_fee', 'hourly_rate', 'hourly_fee', 'duty_rate', 'duty_billing_rate', 'rate_basis'];
    return placements
      .map((p) => ({
        placement_id: p.placement_id,
        staff_name: p.staff_name,
        first_invoice: !p.rate_verified_at,
        changes: changes
          .filter((c) => c.placement_id === p.placement_id)
          .map((c) => ({
            effective_from: c.effective_from,
            changed_at: c.changed_at,
            changed_by: c.changed_by_name,
            reason: c.reason,
            fields: fields
              .filter((f) => JSON.stringify(c.before?.[f] ?? null) !== JSON.stringify(c.after?.[f] ?? null))
              .map((f) => ({ field: f, before: c.before?.[f] ?? null, after: c.after?.[f] ?? null })),
          })),
      }))
      .filter((p) => p.first_invoice || p.changes.length);
  }

  /** One in-app note per staff member: their slip for the month is ready. */
  async notifyPayslipsReady(rows: ReleasedRow[]) {
    if (!rows.length) return;
    const staffIds = [...new Set(rows.map((r) => r.staff_id))];
    const users = await this.dataSource.query(
      `SELECT id, user_id FROM staff_applicants WHERE id = ANY($1::uuid[]) AND user_id IS NOT NULL`,
      [staffIds],
    ) as { id: string; user_id: string }[];
    const userOf = new Map(users.map((u) => [u.id, u.user_id]));
    for (const staffId of staffIds) {
      const userId = userOf.get(staffId);
      if (!userId) continue;
      const months = [...new Set(
        rows.filter((r) => r.staff_id === staffId).map((r) => monthLabel(r.period_month, r.period_year)),
      )];
      await this.notifications
        .createInAppNotification(
          'Salary slip ready',
          `Your salary slip for ${months.join(', ')} is ready. Open Salary in the app to see it.`,
          userId,
        )
        .catch((e: Error) => this.logger.warn(`payslip note for ${staffId}: ${e.message}`));
    }
  }

  /**
   * Actually send the invoice to the client, then mark it SENT.
   *
   * This used to only move the status. Nothing left the building — Finance
   * saw "Invoice sent to client" and the client never received anything.
   *
   * The status only moves if delivery succeeded. If there is no email on file,
   * it says so rather than claiming a send: an invoice wrongly marked SENT is
   * one nobody chases.
   */
  async sendInvoice(id: string) {
    const rows = await this.dataSource.query<{
      invoice_number: string; total_amount: string; period_month: number; period_year: number;
      due_date: string; document_type: string | null;
      customer_name: string | null; email: string | null; user_id: string | null;
      period_from: unknown; period_to: unknown;
    }[]>(
      `SELECT ci.invoice_number, ci.total_amount, ci.period_month, ci.period_year,
              ci.due_date, ci.document_type, ci.period_from, ci.period_to,
              fc.customer_name, u.email, u.id AS user_id
         FROM client_invoices ci
         LEFT JOIN finance_customers fc ON fc.id = ci.client_id
         LEFT JOIN users u ON u.id = fc.user_id
        WHERE ci.id = $1`,
      [id],
    );
    const inv = rows[0];
    if (!inv) throw new NotFoundException(`Invoice ${id} not found`);

    // Email is the preferred channel, but not the only one — no client in
    // either database has an address on file, and refusing on that alone would
    // block every invoice. The portal reaches anyone with an account. Refuse
    // only when there is genuinely no way to reach them, because a document
    // marked SENT that nobody received is one nobody chases.
    if (!inv.email && !inv.user_id) {
      throw new BadRequestException(
        `${inv.customer_name ?? 'This client'} has no email address and no portal ` +
          `account, so ${inv.invoice_number} cannot be delivered. Add one on the ` +
          `Customers page first.`,
      );
    }

    // An invoice can be one part of a month, so it is named by its dates.
    const period = inv.period_from && inv.period_to
      ? formatPeriod({ from: isoDate(inv.period_from)!, to: isoDate(inv.period_to)! })
      : `${String(inv.period_month).padStart(2, '0')}/${inv.period_year}`;
    const amount = new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR', maximumFractionDigits: 2,
    }).format(Number(inv.total_amount));
    const due = new Date(inv.due_date).toLocaleDateString('en-IN');
    const doc = inv.document_type === 'BILL_OF_SUPPLY' ? 'Bill of Supply' : 'Tax Invoice';

    const body =
      `Dear ${inv.customer_name ?? 'Customer'},\n\n` +
      `Your ${doc} ${inv.invoice_number} for ${period} is ready.\n\n` +
      `Amount payable: ${amount}\n` +
      `Due date: ${due}\n\n` +
      `This covers every staff member placed with you for the period. ` +
      `A full breakdown, line by line and person by person, is available in your portal.\n\n` +
      `Thank you,\nHomeGenny`;

    const channels: string[] = [];

    if (inv.email) {
      await this.notifications.sendEmail(inv.email, `Invoice ${inv.invoice_number}`, body);
      channels.push(inv.email);
    }

    if (inv.user_id) {
      await this.notifications
        .createInAppNotification(
          `Invoice ${inv.invoice_number}`,
          `${doc} for ${period} — ${amount}, due ${due}.`,
          inv.user_id,
        )
        .then(() => { channels.push('their portal'); })
        .catch(() => undefined);
    }

    if (!channels.length) {
      throw new BadRequestException(
        `${inv.invoice_number} could not be delivered to ` +
          `${inv.customer_name ?? 'this client'} — no channel accepted it.`,
      );
    }

    const where = channels.join(' and ');
    const result = await this.transition(id, 'SENT', `Invoice sent to ${where}`);
    this.logger.log(`[INVOICE_SENT] ${inv.invoice_number} → ${where}`);
    return { ...result, sent_to: where, channels };
  }

  async cancelInvoice(id: string, reason: string) {
    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required to cancel an invoice.');
    }
    const result = await this.transition(id, 'CANCELLED', 'Invoice cancelled');
    await this.dataSource.query(
      `UPDATE client_invoices SET payment_ref = COALESCE(payment_ref, $1) WHERE id = $2`,
      [`cancelled: ${reason.trim().slice(0, 80)}`, id],
    ).catch(() => undefined);
    // The payslips go back with it: what the cancelled invoice said is no
    // longer agreed. A row already paid out keeps its slip.
    await unreleaseInvoicePayroll(this.dataSource, id);
    // Hand the work back so it can be billed again. Left linked, the payroll
    // stayed "already invoiced" against a cancelled document and the corrected
    // invoice had nothing to bill.
    await this.dataSource.query(
      `UPDATE payroll_records SET client_invoice_id = NULL WHERE client_invoice_id = $1`,
      [id],
    );
    return { ...result, reason };
  }

  /** Summary stats for dashboard */
  async getInvoiceSummary() {
    const rows = await this.dataSource.query<{
      status: string; count: string; total: string;
    }[]>(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS total
       FROM client_invoices GROUP BY status`,
    );
    const overdue = await this.dataSource.query<{ count: string; total: string }[]>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS total
       FROM client_invoices WHERE status NOT IN ('PAID') AND due_date < NOW()`,
    );
    return { by_status: rows, overdue: overdue[0] };
  }
}
