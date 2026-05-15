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
}
