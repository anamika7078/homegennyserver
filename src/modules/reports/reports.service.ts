import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class ReportsService {
  constructor(private readonly dataSource: DataSource) {}

  async getRevenueAnalytics(startDate: string, endDate: string) {
    return this.dataSource.query(`
      SELECT 
        EXTRACT(MONTH FROM created_at) as month,
        SUM(total_amount) as total,
        SUM(management_fee) as fee
      FROM client_invoices
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY month
      ORDER BY month ASC
    `, [startDate, endDate]);
  }

  async getStaffDistribution() {
    return this.dataSource.query(`
      SELECT series, COUNT(*) as count
      FROM staff_applicants
      GROUP BY series
    `);
  }

  async getPlacementMetrics() {
    return this.dataSource.query(`
      SELECT pipeline_stage, COUNT(*) as count
      FROM staff_applicants
      GROUP BY pipeline_stage
    `);
  }

  async getRmProductivity(rmId?: string) {
    if (rmId) {
      return this.dataSource.query(
        `
        SELECT
          DATE_TRUNC('month', created_at) AS month,
          COUNT(*) FILTER (WHERE pipeline_stage = 'S1_INTAKE') AS intakes,
          COUNT(*) FILTER (WHERE pipeline_stage = 'TERMINAL' AND terminal_outcome = 'ENROLLED') AS placements
        FROM staff_applicants
        WHERE deleted_at IS NULL AND assigned_rm_id = $1
        GROUP BY month
        ORDER BY month DESC
        LIMIT 12
      `,
        [rmId],
      );
    }
    return this.dataSource.query(`
      SELECT
        DATE_TRUNC('month', created_at) AS month,
        COUNT(*)::int AS intakes,
        COUNT(*) FILTER (WHERE pipeline_stage = 'TERMINAL')::int AS terminal_count
      FROM staff_applicants
      WHERE deleted_at IS NULL
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `);
  }

  async getConversionReport() {
    const [funnel, trials] = await Promise.all([
      this.getPlacementMetrics(),
      this.dataSource.query(`
        SELECT status, COUNT(*)::int AS count FROM placements GROUP BY status
      `),
    ]);
    return { funnel, trials };
  }
}
