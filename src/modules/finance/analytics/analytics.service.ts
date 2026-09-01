import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface MonthlyRevenue {
  period_label: string;
  period_month: number;
  period_year: number;
  management_fee_income: string;
  gst_collected: string;
  total_payroll_cost: string;
  staff_count: string;
}

export interface BranchPnl {
  branch_id: string;
  branch_name: string;
  /** What HomeGenny actually earns: the management fee. Not the client's total. */
  revenue: string;
  /** GST charged on the fee — collected for the government, never income. */
  gst_collected: string;
  /** Salary + employer ESIC/PF: billed to the client and paid straight out. */
  pass_through: string;
  /** Everything invoiced to clients, revenue + GST + pass-through. */
  client_billed: string;
  /** Internal (non-EOR) employee payroll attributable to this branch. */
  internal_payroll_cost: string;
  /** revenue − internal payroll. Pass-through is excluded: it is reimbursed. */
  contribution: string;
  staff_count: string;
}

export interface AgingBucket {
  bucket: string;
  count: string;
  total_amount: string;
}

@Injectable()
export class FinanceAnalyticsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Revenue, net of anything credited back.
   *
   * A credit note used to leave the original invoice counting in full, so the
   * books showed revenue that had been reversed — and a partial credit was
   * invisible entirely. Each invoice's contribution is now scaled by the share
   * of it that has not been credited. See F-18.
   */
  async getRevenueDashboard(): Promise<MonthlyRevenue[]> {
    return this.dataSource.query<MonthlyRevenue[]>(
      `SELECT
        CONCAT(period_month, '/', period_year) AS period_label,
        period_month,
        period_year,
        COALESCE(SUM(management_fee * net_ratio), 0)         AS management_fee_income,
        COALESCE(SUM(gst_amount * net_ratio), 0)             AS gst_collected,
        COALESCE(SUM(staff_salary_component * net_ratio), 0) AS total_payroll_cost,
        COUNT(DISTINCT placement_id)                          AS staff_count
       FROM (
         SELECT ci.*,
                CASE WHEN ci.total_amount > 0
                     THEN GREATEST(0, (ci.total_amount - COALESCE(ci.credited_amount, 0)) / ci.total_amount)
                     ELSE 0 END AS net_ratio
         FROM client_invoices ci
         WHERE ci.status IN ('PAID', 'APPROVED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE')
       ) AS net
       GROUP BY period_year, period_month
       ORDER BY period_year DESC, period_month DESC
       LIMIT 12`,
    );
  }

  /** Credit notes issued per period — what was reversed, and why it matters. */
  async getCreditNoteSummary() {
    type CreditRow = {
      period_label: string; note_count: string; credited_amount: string; tax_reversed: string;
    };
    const monthly: CreditRow[] = await this.dataSource.query<CreditRow[]>(
      `SELECT CONCAT(ci.period_month, '/', ci.period_year) AS period_label,
              COUNT(*)::text AS note_count,
              COALESCE(SUM(cn.total_amount), 0) AS credited_amount,
              COALESCE(SUM(cn.cgst_amount + cn.sgst_amount + cn.igst_amount), 0) AS tax_reversed
       FROM credit_notes cn
       JOIN client_invoices ci ON ci.id = cn.invoice_id
       WHERE cn.status = 'ISSUED'
       GROUP BY ci.period_year, ci.period_month
       ORDER BY ci.period_year DESC, ci.period_month DESC
       LIMIT 12`,
    ).catch(() => [] as CreditRow[]);

    const total = monthly.reduce((s, m) => s + parseFloat(m.credited_amount), 0);
    const taxReversed = monthly.reduce((s, m) => s + parseFloat(m.tax_reversed), 0);
    return {
      total_credited: Math.round(total * 100) / 100,
      total_tax_reversed: Math.round(taxReversed * 100) / 100,
      monthly,
    };
  }

  async getGstSummary() {
    const rows = await this.dataSource.query<{
      period_label: string; gst_amount: string; management_fee: string;
    }[]>(
      `SELECT
        CONCAT(period_month, '/', period_year) AS period_label,
        COALESCE(SUM(gst_amount), 0) AS gst_amount,
        COALESCE(SUM(management_fee), 0) AS management_fee
       FROM client_invoices
       GROUP BY period_year, period_month
       ORDER BY period_year DESC, period_month DESC
       LIMIT 12`,
    );
    const totalGst = rows.reduce((s, r) => s + parseFloat(r.gst_amount), 0);
    return { total_gst_liability: Math.round(totalGst * 100) / 100, monthly: rows };
  }

  async getEsicPfOutflow() {
    return this.dataSource.query(
      `SELECT
        CONCAT(period_month, '/', period_year)       AS period_label,
        period_month,
        period_year,
        COALESCE(SUM(esic_employee + esic_employer), 0) AS total_esic,
        COALESCE(SUM(pf_employee + pf_employer), 0)     AS total_pf,
        COALESCE(SUM(esic_employee + esic_employer + pf_employee + pf_employer), 0) AS total_statutory
       FROM payroll_records
       GROUP BY period_year, period_month
       ORDER BY period_year DESC, period_month DESC
       LIMIT 12`,
    );
  }

  /**
   * Branch P&L.
   *
   * The previous version counted `management_fee + gst_amount` as revenue and
   * then subtracted `staff_salary_component` from it. Both halves were wrong:
   * GST is collected on the government's behalf and is a liability, not income;
   * and staff salary is reimbursed by the client in the same invoice, so
   * deducting it from fee-only revenue reported a large loss on every branch
   * that was in fact profitable. See F-10.
   *
   * The EOR model is simple once stated: HomeGenny earns the **management fee**.
   * Salary and employer ESIC/PF pass through — billed and paid out, netting to
   * zero. Real costs are the branch's own staff, so contribution is fee minus
   * internal payroll.
   */
  async getBranchPnl(): Promise<BranchPnl[]> {
    return this.dataSource.query<BranchPnl[]>(
      `WITH eor AS (
         SELECT
           p.branch_id,
           SUM(ci.management_fee)                                   AS revenue,
           SUM(ci.gst_amount)                                       AS gst_collected,
           SUM(ci.staff_salary_component
               + COALESCE(ci.esic_employer, 0)
               + COALESCE(ci.pf_employer, 0))                       AS pass_through,
           SUM(ci.total_amount)                                     AS client_billed,
           COUNT(DISTINCT ci.placement_id)                          AS staff_count
         FROM client_invoices ci
         JOIN placements p ON p.id = ci.placement_id
         WHERE ci.status = 'PAID'
         GROUP BY p.branch_id
       ),
       internal AS (
         -- Branch overhead: what the office staff themselves cost.
         SELECT e.branch_id, SUM(ep.gross_salary) AS internal_payroll_cost
         FROM employee_payrolls ep
         JOIN employees e ON e.id = ep.employee_id
         WHERE e.deleted_at IS NULL
         GROUP BY e.branch_id
       )
       SELECT
         b.id   AS branch_id,
         b.name AS branch_name,
         COALESCE(eor.revenue, 0)                  AS revenue,
         COALESCE(eor.gst_collected, 0)            AS gst_collected,
         COALESCE(eor.pass_through, 0)             AS pass_through,
         COALESCE(eor.client_billed, 0)            AS client_billed,
         COALESCE(internal.internal_payroll_cost, 0) AS internal_payroll_cost,
         COALESCE(eor.revenue, 0)
           - COALESCE(internal.internal_payroll_cost, 0) AS contribution,
         COALESCE(eor.staff_count, 0)              AS staff_count
       FROM branches b
       LEFT JOIN eor      ON eor.branch_id = b.id
       LEFT JOIN internal ON internal.branch_id = b.id
       ORDER BY revenue DESC`,
    );
  }

  async getInvoiceAging(): Promise<AgingBucket[]> {
    return this.dataSource.query<AgingBucket[]>(
      `SELECT
        CASE
          WHEN NOW() - due_date <= INTERVAL '30 days' THEN '0-30 days'
          WHEN NOW() - due_date <= INTERVAL '60 days' THEN '31-60 days'
          ELSE '60+ days'
        END AS bucket,
        COUNT(*) AS count,
        COALESCE(SUM(total_amount), 0) AS total_amount
       FROM client_invoices
       WHERE status NOT IN ('PAID', 'CREDIT_NOTE') AND due_date < NOW()
       GROUP BY bucket
       ORDER BY bucket`,
    );
  }

  async getDashboardSummary() {
    const [revenue, gst, esicPf, aging] = await Promise.all([
      this.getRevenueDashboard(),
      this.getGstSummary(),
      this.getEsicPfOutflow(),
      this.getInvoiceAging(),
    ]);

    const currentRevenue = parseFloat((revenue[0] as MonthlyRevenue)?.management_fee_income ?? '0');
    const prevRevenue    = parseFloat((revenue[1] as MonthlyRevenue)?.management_fee_income ?? '0');
    const revenueGrowth  = prevRevenue > 0
      ? Math.round(((currentRevenue - prevRevenue) / prevRevenue) * 100 * 10) / 10
      : 0;

    return {
      current_month_revenue: currentRevenue,
      revenue_growth_pct:    revenueGrowth,
      total_gst_liability:   gst.total_gst_liability,
      revenue_trend:         revenue.slice(0, 6).reverse(),
      esic_pf_trend:         (esicPf as object[]).slice(0, 6).reverse(),
      invoice_aging:         aging,
    };
  }
}
