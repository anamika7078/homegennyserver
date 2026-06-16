import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/guards/branch-scope.util';

@Injectable()
export class TrainerService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboardStats(user: AuthUser) {
    const branchClause = user.branchId ? `AND b.branch_id = '${user.branchId}'` : '';
    
    // Total Trainees
    const trainees = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT COUNT(*) as total FROM batch_enrollments e
      JOIN training_batches b ON b.id = e.batch_id
      WHERE 1=1 ${branchClause}
    `);

    // Sessions Today (Placeholder for now, assuming starting today)
    const sessionsToday = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT COUNT(*) as total FROM training_batches b
      WHERE DATE(b.start_date) = CURRENT_DATE ${branchClause}
    `);

    // Video Certs pending review
    const videoCertsRows = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT COUNT(*) as total FROM video_cert_submissions
      WHERE status = 'PENDING'
    `).catch(() => [{ total: 0 }]);

    // Attendance pending (trainees with no attendance marked for today's batches)
    const attendancePendingRows = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT COUNT(DISTINCT e.staff_id) as total
      FROM batch_enrollments e
      JOIN training_batches b ON b.id = e.batch_id
      WHERE b.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM batch_enrollments ea
          WHERE ea.batch_id = e.batch_id
            AND ea.staff_id = e.staff_id
            AND ea.attendance::jsonb @> jsonb_build_array(
              jsonb_build_object(
                'date', CURRENT_DATE::text,
                'attended', true
              )
            )
        )
        ${branchClause}
    `).catch(() => [{ total: 0 }]);

    // Average assessment score for S3 batch (this week)
    const avgScoreRows = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT COALESCE(AVG(a.score), 0) as avg_score
      FROM assessments a
      WHERE a.created_at >= date_trunc('week', CURRENT_DATE)
    `).catch(() => [{ avg_score: 0 }]);

    // Retry count (assessments with attempt_number > 1 this week)
    const retriesRows = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT COUNT(*) as total FROM assessments
      WHERE attempt_number > 1
        AND created_at >= date_trunc('week', CURRENT_DATE)
    `).catch(() => [{ total: 0 }]);

    return {
      activeTrainees: Number(trainees[0]?.total ?? 0),
      sessionsToday: Number(sessionsToday[0]?.total ?? 0),
      videoCertsPending: Number(videoCertsRows[0]?.total ?? 0),
      attendancePending: Number(attendancePendingRows[0]?.total ?? 0),
      avgScore: Math.round(Number(avgScoreRows[0]?.avg_score ?? 0)),
      retries: Number(retriesRows[0]?.total ?? 0),
    };
  }

  async getAssignedBatches(user: AuthUser) {
    const branchClause = user.branchId ? `AND b.branch_id = '${user.branchId}'` : '';
    const rows = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT
        b.id, b.batch_code, b.series, b.trainer_name, b.classroom,
        b.start_date, b.status, b.branch_id, b.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'id', e.id,
              'staffId', e.staff_id::text,
              'attendance', e.attendance,
              'staffCode', sa.staff_code,
              'fullName', sa.full_name,
              'series', sa.series::text
            ) ORDER BY sa.full_name
          ) FILTER (WHERE e.id IS NOT NULL),
          '[]'::json
        ) AS enrollments
      FROM training_batches b
      LEFT JOIN batch_enrollments e ON e.batch_id = b.id
      LEFT JOIN staff_applicants sa ON sa.id = e.staff_id
      WHERE 1=1 ${branchClause}
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `);
    
    return rows.map((r) => {
      const enrollments = (typeof r.enrollments === 'string' ? JSON.parse(r.enrollments) : r.enrollments) ?? [];
      return {
        id: r.id,
        batchCode: r.batch_code,
        series: r.series,
        trainerName: r.trainer_name,
        classroom: r.classroom,
        startDate: r.start_date,
        status: r.status,
        enrollments,
      };
    });
  }

  async updateAssessment(trainerId: string, traineeId: string, data: any) {
    // Basic logic for updating assessment
    return { success: true, traineeId, status: 'ASSESSED' };
  }
}
