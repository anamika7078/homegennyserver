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
  revenue: string;
  payroll_cost: string;
  gross_profit: string;
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

  async getRevenueDashboard(): Promise<MonthlyRevenue[]> {
    return this.dataSource.query<MonthlyRevenue[]>(
      `SELECT
        CONCAT(period_month, '/', period_year) AS period_label,
        period_month,
        period_year,
        COALESCE(SUM(management_fee), 0)               AS management_fee_income,
        COALESCE(SUM(gst_amount), 0)                   AS gst_collected,
        COALESCE(SUM(staff_salary_component), 0)       AS total_payroll_cost,
        COUNT(DISTINCT placement_id)                   AS staff_count
       FROM client_invoices
       WHERE status IN ('PAID', 'APPROVED', 'SENT')
       GROUP BY period_year, period_month
       ORDER BY period_year DESC, period_month DESC
       LIMIT 12`,
    );
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

  async getBranchPnl(): Promise<BranchPnl[]> {
    return this.dataSource.query<BranchPnl[]>(
      `SELECT
        b.id   AS branch_id,
        b.name AS branch_name,
        COALESCE(SUM(ci.management_fee + ci.gst_amount), 0)         AS revenue,
        COALESCE(SUM(ci.staff_salary_component), 0)                  AS payroll_cost,
        COALESCE(SUM(ci.management_fee + ci.gst_amount
                    - ci.staff_salary_component), 0)                  AS gross_profit,
        COUNT(DISTINCT ci.placement_id)                               AS staff_count
       FROM branches b
       LEFT JOIN placements p  ON p.branch_id = b.id
       LEFT JOIN client_invoices ci ON ci.placement_id = p.id AND ci.status IN ('PAID')
       GROUP BY b.id, b.name
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
