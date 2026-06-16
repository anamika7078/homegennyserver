import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class DashboardService {
  constructor(private readonly dataSource: DataSource) {}

  async getAdminStats() {
    const [stats] = await this.dataSource.query(`
      SELECT
        (SELECT COUNT(*) FROM staff_applicants WHERE deleted_at IS NULL) AS total_staff,
        (SELECT COUNT(*) FROM placements WHERE status IN ('TRIAL','CONFIRMED')) AS active_deployments,
        (SELECT COUNT(*) FROM staff_applicants WHERE pipeline_stage = 'S2_VERIFY') AS pending_verifications,
        (SELECT COUNT(*) FROM alarms WHERE status = 'OPEN') AS open_alerts,
        (SELECT COUNT(*) FROM escalation_logs WHERE status = 'OPEN') AS open_escalations,
        (SELECT COALESCE(SUM(total_amount), 0) FROM client_invoices WHERE status = 'PAID') AS revenue,
        (SELECT COUNT(*) FROM clients WHERE status = 'ACTIVE') AS active_clients
    `).catch(() => [{}]);

    const branchPerformance = await this.dataSource.query(`
      SELECT b.name, COUNT(sa.id)::int AS applicants,
             COUNT(CASE WHEN sa.pipeline_stage = 'S5_DEPLOY' THEN 1 END)::int AS deployed
      FROM branches b
      LEFT JOIN staff_applicants sa ON sa.branch_id = b.id AND sa.deleted_at IS NULL
      GROUP BY b.id, b.name
      ORDER BY applicants DESC
      LIMIT 10
    `).catch(() => []);

    return { ...stats, branchPerformance };
  }

  async getBmStats(branchId?: string) {
    const branchFilter = branchId ? 'AND sa.branch_id = $1' : '';
    const params = branchId ? [branchId] : [];
    const [kpis] = await this.dataSource.query(
      `
      SELECT
        (SELECT COUNT(*) FROM staff_applicants sa WHERE sa.deleted_at IS NULL ${branchFilter}) AS total_applicants,
        (SELECT COUNT(*) FROM staff_applicants sa WHERE sa.pipeline_stage = 'S5_DEPLOY' ${branchFilter}) AS deployed,
        (SELECT COUNT(*) FROM alarms WHERE status = 'OPEN') AS pending_approvals,
        (SELECT COUNT(*) FROM escalation_logs WHERE status = 'OPEN') AS escalation_queue,
        (SELECT COUNT(*) FROM placements p
          JOIN staff_applicants sa ON sa.id = p.staff_id
          WHERE p.status = 'TRIAL' AND p.trial_end_date <= CURRENT_DATE + 3 ${branchFilter}) AS trial_expiry_alerts
    `,
      params,
    ).catch(() => [{}]);

    return kpis;
  }

  async getRmStats(rmId?: string) {
    const rmFilter = rmId ? 'AND sa.assigned_rm_id = $1' : '';
    const params = rmId ? [rmId] : [];
    const [tasks] = await this.dataSource.query(
      `
      SELECT
        (SELECT COUNT(*) FROM staff_applicants sa WHERE sa.pipeline_stage = 'S2_VERIFY' ${rmFilter}) AS verification_queue,
        (SELECT COUNT(*) FROM staff_applicants sa WHERE sa.pipeline_stage = 'S3_TRAIN' ${rmFilter}) AS in_training,
        (SELECT COUNT(*) FROM staff_applicants sa WHERE sa.pipeline_stage = 'S5_DEPLOY' ${rmFilter}) AS active_deployments,
        (SELECT COUNT(*) FROM staff_applicants sa WHERE sa.pipeline_stage = 'S1_INTAKE' ${rmFilter}) AS intake_pending,
        (SELECT COUNT(*) FROM escalation_logs WHERE status = 'OPEN') AS care_escalations
    `,
      params,
    ).catch(() => [{}]);

    return tasks;
  }
}
