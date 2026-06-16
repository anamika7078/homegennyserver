import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Assessment } from '../assessments/entities/assessment.entity';

@Injectable()
export class AssessorsService {
  constructor(
    @InjectRepository(Assessment)
    private readonly assessmentRepo: Repository<Assessment>,
    private readonly dataSource: DataSource,
  ) {}

  /** Dashboard KPI summary for assessor role */
  async getDashboardStats(assessorId?: string) {
    const assessorFilter = assessorId ? `AND assessor_id = '${assessorId}'` : '';

    const [kpis] = await this.dataSource.query(`
      SELECT
        (SELECT COUNT(*) FROM assessments WHERE status = 'PENDING' ${assessorFilter})           AS pending_assessments,
        (SELECT COUNT(*) FROM assessments WHERE status = 'COMPLETED'
          AND DATE(updated_at) = CURRENT_DATE ${assessorFilter})                                AS completed_today,
        (SELECT COUNT(*) FROM assessments WHERE result = 'DEFERRED' ${assessorFilter})          AS deferred_candidates,
        (SELECT COUNT(*) FROM assessments WHERE attempt_number > 1
          AND status = 'PENDING' ${assessorFilter})                                             AS reassessment_queue
    `).catch(() => [{}]);

    const driverQueue = await this.dataSource.query(`
      SELECT a.id, a.candidate_id, a.series, a.attempt_number, a.status, a.created_at,
             sa.full_name, sa.staff_code
      FROM assessments a
      LEFT JOIN staff_applicants sa ON sa.id = a.candidate_id
      WHERE a.assessment_type = 'DRIVER' AND a.status = 'PENDING'
      ${assessorFilter}
      ORDER BY a.created_at ASC
      LIMIT 20
    `).catch(() => []);

    const scQueue = await this.dataSource.query(`
      SELECT a.id, a.candidate_id, a.series, a.attempt_number, a.status, a.created_at,
             sa.full_name, sa.staff_code
      FROM assessments a
      LEFT JOIN staff_applicants sa ON sa.id = a.candidate_id
      WHERE a.assessment_type = 'SC' AND a.status = 'PENDING'
      ${assessorFilter}
      ORDER BY a.created_at ASC
      LIMIT 20
    `).catch(() => []);

    return {
      kpis: {
        pending_assessments: Number(kpis?.pending_assessments ?? 0),
        completed_today: Number(kpis?.completed_today ?? 0),
        deferred_candidates: Number(kpis?.deferred_candidates ?? 0),
        reassessment_queue: Number(kpis?.reassessment_queue ?? 0),
      },
      driverQueue,
      scQueue,
    };
  }

  /** Full list of pending assessments (driver + SC) */
  async getPendingAssessments(assessorId?: string) {
    const assessorFilter = assessorId ? `AND a.assessor_id = '${assessorId}'` : '';
    return this.dataSource.query(`
      SELECT a.id, a.candidate_id, a.assessment_type, a.series, a.attempt_number,
             a.status, a.created_at, sa.full_name, sa.staff_code, sa.mobile
      FROM assessments a
      LEFT JOIN staff_applicants sa ON sa.id = a.candidate_id
      WHERE a.status = 'PENDING'
      ${assessorFilter}
      ORDER BY a.attempt_number DESC, a.created_at ASC
    `).catch(() => []);
  }

  /** Upcoming scheduled assessments (slots from schedules table if it exists, else assessments with future date) */
  async getSchedules(assessorId?: string) {
    const assessorFilter = assessorId ? `AND a.assessor_id = '${assessorId}'` : '';
    return this.dataSource.query(`
      SELECT a.id, a.candidate_id, a.assessment_type, a.series, a.status,
             a.created_at, sa.full_name, sa.staff_code
      FROM assessments a
      LEFT JOIN staff_applicants sa ON sa.id = a.candidate_id
      WHERE a.status = 'PENDING'
        AND DATE(a.created_at) >= CURRENT_DATE
      ${assessorFilter}
      ORDER BY a.created_at ASC
      LIMIT 50
    `).catch(() => []);
  }

  /** Pass/fail analytics for the reports page */
  async getReports(assessorId?: string) {
    const assessorFilter = assessorId ? `AND assessor_id = '${assessorId}'` : '';

    const passFail = await this.dataSource.query(`
      SELECT result, assessment_type, COUNT(*)::int AS count
      FROM assessments
      WHERE result IS NOT NULL
      ${assessorFilter}
      GROUP BY result, assessment_type
      ORDER BY assessment_type, result
    `).catch(() => []);

    const weeklyTrend = await this.dataSource.query(`
      SELECT DATE_TRUNC('week', created_at)::date AS week,
             COUNT(*)::int AS total,
             COUNT(CASE WHEN result = 'PASS' THEN 1 END)::int AS passed
      FROM assessments
      WHERE created_at >= NOW() - INTERVAL '8 weeks'
      ${assessorFilter}
      GROUP BY 1
      ORDER BY 1 ASC
    `).catch(() => []);

    return { passFail, weeklyTrend };
  }
}
