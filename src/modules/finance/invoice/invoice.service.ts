import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { assertTransition, type InvoiceStatus } from '../../../common/finance/invoice-status';

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
  staff_name?: string;
  staff_code?: string;
  type?: 'PLACEMENT' | 'EMPLOYEE';
}

@Injectable()
export class FinanceInvoiceService {
  constructor(private readonly dataSource: DataSource) {}

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
            c.customer_name AS client_name,
            sa.full_name  AS staff_name,
            sa.staff_code AS staff_code,
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
            'Internal HR'        AS client_name,
            emp.full_name        AS staff_name,
            emp.employee_id      AS staff_code,
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

      const itemsTotal = Math.round(line_items.reduce((s, li) => s + li.amount, 0) * 100) / 100;
      const total = parseFloat(inv.total_amount);

      return {
        ...inv,
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

  async generateInvoiceHtml(id: string): Promise<string> {
    const inv = await this.getInvoice(id);
    const fmt = (n: number | string) =>
      new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
        .format(Number(n));

    const lineItems = (inv.line_items as { description: string; amount: number }[])
      .map((li) =>
        `<tr>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb">${li.description}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600">${fmt(li.amount)}</td>
        </tr>`,
      )
      .join('');

    const title = inv.type === 'EMPLOYEE' ? 'Staff Payslip' : 'Client Invoice';

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title} ${inv.invoice_number}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:24px;color:#0f172a">
  <h1 style="margin:0 0 4px">HomeGenny</h1>
  <p style="margin:0 0 24px;color:#64748b">${title}</p>
  <p><strong>${inv.type === 'EMPLOYEE' ? 'Payslip' : 'Invoice'} #:</strong> ${inv.invoice_number}</p>
  <p><strong>Client/Department:</strong> ${inv.client_name ?? '—'}</p>
  <p><strong>Staff:</strong> ${inv.staff_name ?? '—'} (${inv.staff_code ?? ''})</p>
  <p><strong>Period:</strong> ${inv.period_month}/${inv.period_year}</p>
  <p><strong>Date:</strong> ${new Date(inv.due_date).toLocaleDateString('en-IN')}</p>
  <p><strong>Status:</strong> ${inv.status}</p>
  <table style="width:100%;border-collapse:collapse;margin-top:24px">${lineItems}</table>
  <p style="margin-top:16px;font-size:18px;font-weight:700;text-align:right">Total Amount: ${fmt(inv.total_amount)}</p>
  <p style="margin-top:32px;font-size:12px;color:#94a3b8">Generated ${new Date().toLocaleString('en-IN')}</p>
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

  async sendInvoice(id: string) {
    return this.transition(id, 'SENT', 'Invoice sent to client');
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
