import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class DashboardService {
  constructor(private readonly dataSource: DataSource) {}

  async getAdminStats() {
    const [stats] = await this.dataSource.query(`
      SELECT 
        (SELECT COUNT(*) FROM staff_applicants) as total_staff,
        (SELECT COUNT(*) FROM clients) as total_clients,
        (SELECT SUM(total_amount) FROM client_invoices WHERE status = 'PAID') as revenue
    `);
    return stats;
  }
}
