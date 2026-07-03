import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface InvoiceRow {
  id: string;
  placement_id: string;
  client_id: string;
  invoice_number: string;
  period_month: number;
  period_year: number;
  staff_salary_component: string;
  management_fee: string;
  gst_amount: string;
  total_amount: string;
  due_date: string;
  paid_at: string | null;
  payment_ref: string | null;
  razorpay_order_id: string | null;
  status: string;
  created_at: string;
  client_name?: string;
  staff_name?: string;
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
      SELECT
        ci.*,
        c.full_name   AS client_name,
        sa.full_name  AS staff_name,
        sa.staff_code AS staff_code
      FROM client_invoices ci
      LEFT JOIN clients c ON c.id::text = ci.client_id::text
      LEFT JOIN placements p ON p.id = ci.placement_id
      LEFT JOIN staff_applicants sa ON sa.id = p.staff_id
    `;
    const queryParams: unknown[] = [];
    if (params.status) {
      queryParams.push(params.status.toUpperCase());
      sql += ` WHERE ci.status = $${queryParams.length}`;
    }
    sql += ` ORDER BY ci.created_at DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(limit, offset);

    const rows = await this.dataSource.query<InvoiceRow[]>(sql, queryParams);

    // Count query
    let countSql = `SELECT COUNT(*) AS total FROM client_invoices`;
    const countParams: unknown[] = [];
    if (params.status) {
      countParams.push(params.status.toUpperCase());
      countSql += ` WHERE status = $1`;
    }
    const countRow = await this.dataSource.query<{ total: string }[]>(countSql, countParams);
    const total = parseInt(countRow[0]?.total ?? '0', 10);

    return { data: rows, total, page, limit };
    } catch {
      return { data: [], total: 0, page: params.page ?? 1, limit: params.limit ?? 50 };
    }
  }

  async getInvoice(id: string): Promise<InvoiceRow & { line_items: object }> {
    const rows = await this.dataSource.query<InvoiceRow[]>(
      `SELECT ci.*, c.full_name AS client_name, c.email AS client_email,
              sa.full_name AS staff_name, sa.staff_code
       FROM client_invoices ci
       LEFT JOIN clients c ON c.id::text = ci.client_id::text
       LEFT JOIN placements p ON p.id = ci.placement_id
       LEFT JOIN staff_applicants sa ON sa.id = p.staff_id
       WHERE ci.id = $1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException(`Invoice ${id} not found`);
    const inv = rows[0];

    // Build structured line items
    const staffSalary = parseFloat(inv.staff_salary_component);
    const mgmtFee    = parseFloat(inv.management_fee);
    const gst        = parseFloat(inv.gst_amount);
    const total      = parseFloat(inv.total_amount);

    const line_items = [
      { description: 'Staff Salary Component', amount: staffSalary, gst_applicable: false },
      { description: 'Management Fee',          amount: mgmtFee,    gst_applicable: true  },
      { description: 'GST on Management Fee (18%)', amount: gst,   gst_applicable: false  },
      { description: 'Total Client Charge',     amount: total,      gst_applicable: false  },
    ];

    return { ...inv, line_items };
  }

  async approveInvoice(id: string) {
    const rows = await this.dataSource.query<InvoiceRow[]>(
      `SELECT * FROM client_invoices WHERE id = $1`, [id],
    );
    if (!rows.length) throw new NotFoundException(`Invoice ${id} not found`);

    await this.dataSource.query(
      `UPDATE client_invoices SET status = 'APPROVED' WHERE id = $1`, [id],
    );
    return { id, status: 'APPROVED', message: 'Invoice approved successfully' };
  }

  async sendInvoice(id: string) {
    const rows = await this.dataSource.query<InvoiceRow[]>(
      `SELECT * FROM client_invoices WHERE id = $1`, [id],
    );
    if (!rows.length) throw new NotFoundException(`Invoice ${id} not found`);

    await this.dataSource.query(
      `UPDATE client_invoices SET status = 'SENT' WHERE id = $1`, [id],
    );
    return { id, status: 'SENT', message: 'Invoice sent to client' };
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
