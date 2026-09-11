import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { amountInWords } from '../../../common/finance/amount-in-words.util';
import { buildServiceLines, periodRange, type ServiceLine } from '../../../common/finance/service-lines.util';
import { assertTransition, type InvoiceStatus } from '../../../common/finance/invoice-status';
import { NotificationsService } from '../../notifications/notifications.service';

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
      if (params.status) {
        queryParams.push(params.status.toUpperCase());
        sql += ` WHERE u.status = $${queryParams.length}`;
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
      if (params.status) {
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
  ): Promise<InvoiceRow & { line_items: object; reconciles?: boolean; line_items_total?: number }> {
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
            { description: 'GST on Management Fee',  amount: parseFloat(inv.gst_amount),             gst_applicable: false },
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
  private async supplierIdentity() {
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
      address: get('finance.supplier_address'),
      pan: get('finance.supplier_pan'),
      bankName: get('finance.bank_name'),
      bankAccount: get('finance.bank_account'),
      bankIfsc: get('finance.bank_ifsc'),
      bankBranch: get('finance.bank_branch'),
    };
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
    }[]>(
      `SELECT sa.full_name AS staff_name, sa.series::text AS series,
              pr.placement_type, pr.shift_days, pr.hours_worked, pr.hourly_rate,
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

    const period = periodRange(inv.period_month, inv.period_year);
    const asDate = (d: Date) => d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });

    // Each tax line states the value it was charged on as well as the tax, so
    // the rate can be checked against the base without doing the sum.
    const taxLine = (label: string, amount: number) =>
      `<tr><td>${label}</td><td class="r base">${fmt(taxedOn)}</td><td class="r">${fmt(amount)}</td></tr>`;
    const taxRows = isPayslip ? '' : igst > 0
      ? taxLine('18% IGST', igst)
      : (cgst > 0 || sgst > 0)
        ? taxLine('9% CGST', cgst) + taxLine('9% SGST', sgst)
        : '';

    // Say on the document what is stopping this from being a tax invoice,
    // rather than quietly issuing a lesser one and hoping someone checks.
    const missing: string[] = [];
    if (!isPayslip) {
      if (!supplier.gstin) missing.push('supplier GSTIN');
      if (!supplier.state) missing.push('supplier state');
      if (!sac) missing.push('SAC code');
    }
    const notice = missing.length
      ? `<div class="notice"><strong>This is a Bill of Supply, not a Tax Invoice.</strong>
           No GST has been charged, because this is not on file yet:
           ${esc(missing.join(', '))}. Add it in Finance settings and invoices
           raised afterwards will carry tax.</div>`
      : '';

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
      <div>GSTIN: ${esc(supplier.gstin ?? '—')}</div>
      ${supplier.pan ? `<div>PAN: ${esc(supplier.pan)}</div>` : ''}
      <div>State: ${esc(supplier.state ?? '—')}</div>
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
    <div><span>Period</span><strong>${String(inv.period_month).padStart(2, '0')}/${inv.period_year}</strong></div>
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

  async approveInvoice(id: string) {
    return this.transition(id, 'APPROVED', 'Invoice approved successfully');
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
    }[]>(
      `SELECT ci.invoice_number, ci.total_amount, ci.period_month, ci.period_year,
              ci.due_date, ci.document_type,
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

    const period = `${String(inv.period_month).padStart(2, '0')}/${inv.period_year}`;
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
