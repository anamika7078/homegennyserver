import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { VideoCertService } from '../video-cert/video-cert.service';
import { AuthUser } from '../../common/guards/branch-scope.util';
import { SchemaBootstrapService } from '../health/schema-bootstrap.service';

@Injectable()
export class TrainerService {
  private readonly logger = new Logger(TrainerService.name);
  private tablesReady: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly schemaBootstrap: SchemaBootstrapService,
    private readonly videoCertService: VideoCertService,
  ) {}

  private async ensureTables(): Promise<void> {
    try {
      if (!this.tablesReady) {
        this.tablesReady = this.schemaBootstrap.ensureModuleTables().catch((err) => {
          this.tablesReady = null;
          throw err;
        });
      }
      await this.tablesReady;
    } catch (err) {
      this.logger.warn(
        `ensureTables: ${err instanceof Error ? err.message : String(err)} — continuing (tables may already exist)`,
      );
    }
  }

  private branchClause(user: AuthUser): string {
    return user.branchId ? `AND b.branch_id = '${user.branchId}'::uuid` : '';
  }

  private staffBranchClause(user: AuthUser): string {
    return user.branchId ? `AND sa.branch_id = '${user.branchId}'::uuid` : '';
  }

  /**
   * Looks up the HR employee record matching this trainer user's phone number.
   * Returns a SQL snippet `AND b.trainer_id = '<uuid>'` for use in WHERE clauses.
   * Falls back to empty string (no filter) if no matching employee is found,
   * so the system degrades gracefully rather than hiding all batches.
   */
  private async getTrainerEmployeeClause(userId: string): Promise<string> {
    try {
      const userRows = await this.prisma.$queryRawUnsafe<{ phone: string }[]>(
        `SELECT phone FROM users WHERE id = $1::uuid LIMIT 1`, userId,
      );
      const phone = userRows[0]?.phone;
      if (!phone) return `AND b.rm_id = '${userId}'::uuid`;

      const empRows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM employees WHERE mobile = $1 AND deleted_at IS NULL LIMIT 1`, phone,
      );
      const empId = empRows[0]?.id;
      if (!empId) return `AND b.rm_id = '${userId}'::uuid`;

      return `AND (b.trainer_id = '${empId}'::uuid OR b.rm_id = '${userId}'::uuid)`;
    } catch {
      return `AND b.rm_id = '${userId}'::uuid`;
    }
  }

  async getVideoCerts(user: AuthUser) {
    await this.ensureTables();
    const branchClause = this.staffBranchClause(user);
    try {
      return await this.prisma.$queryRawUnsafe<
        Array<{
          id: string;
          staffId: string;
          staffName: string;
          staffCode: string;
          series: string;
          promptKey: string;
          videoUrl: string;
          reviewStatus: string;
          attemptNumber: number;
          reviewNotes: string | null;
          createdAt: Date;
        }>
      >(`
        SELECT
          vc.id,
          vc.staff_id::text AS "staffId",
          sa.full_name AS "staffName",
          sa.staff_code AS "staffCode",
          sa.series::text AS series,
          vc.prompt_key AS "promptKey",
          vc.video_url AS "videoUrl",
          vc.review_status AS "reviewStatus",
          vc.attempt_number AS "attemptNumber",
          vc.review_notes AS "reviewNotes",
          vc.created_at AS "createdAt"
        FROM video_certifications vc
        JOIN staff_applicants sa ON sa.id = vc.staff_id
        WHERE sa.deleted_at IS NULL ${branchClause}
        ORDER BY vc.created_at DESC
        LIMIT 100
      `);
    } catch {
      return [];
    }
  }

  async getDashboardStats(user: AuthUser) {
    await this.ensureTables();
    const branchClause = this.branchClause(user);
    const staffBranchClause = this.staffBranchClause(user);

    try {
      const trainerClause = await this.getTrainerEmployeeClause(user.id);
      const trainees = await this.prisma.$queryRawUnsafe<{ total: bigint }[]>(`
        SELECT COUNT(*) as total FROM batch_enrollments e
        JOIN training_batches b ON b.id = e.batch_id
        WHERE 1=1 ${branchClause} ${trainerClause}
      `);

      const sessionsToday = await this.prisma.$queryRawUnsafe<{ total: bigint }[]>(`
        SELECT COUNT(*) as total FROM training_batches b
        WHERE DATE(b.start_date) = CURRENT_DATE ${branchClause} ${trainerClause}
      `);

      const videoCertsRows = await this.prisma.$queryRawUnsafe<{ total: bigint }[]>(`
        SELECT COUNT(*) as total FROM video_certifications vc
        JOIN staff_applicants sa ON sa.id = vc.staff_id
        WHERE vc.review_status = 'PENDING'
          AND sa.deleted_at IS NULL ${staffBranchClause}
      `).catch(() => [{ total: BigInt(0) }]);

      const attendancePendingRows = await this.prisma.$queryRawUnsafe<{ total: bigint }[]>(`
        SELECT COUNT(DISTINCT e.staff_id) as total
        FROM batch_enrollments e
        JOIN training_batches b ON b.id = e.batch_id
        WHERE b.status = 'ACTIVE'
          ${branchClause} ${trainerClause}
      `).catch(() => [{ total: BigInt(0) }]);

      const avgScoreRows = await this.prisma.$queryRawUnsafe<{ avg_score: number }[]>(`
        SELECT COALESCE(AVG(
          (a.skill_scores->>'communication')::float +
          (a.skill_scores->>'technical')::float +
          (a.skill_scores->>'empathy')::float +
          (a.skill_scores->>'driving')::float +
          (a.skill_scores->>'safety')::float
        ) / NULLIF(
          CASE WHEN a.skill_scores ? 'communication' THEN 1 ELSE 0 END +
          CASE WHEN a.skill_scores ? 'technical' THEN 1 ELSE 0 END +
          CASE WHEN a.skill_scores ? 'empathy' THEN 1 ELSE 0 END +
          CASE WHEN a.skill_scores ? 'driving' THEN 1 ELSE 0 END +
          CASE WHEN a.skill_scores ? 'safety' THEN 1 ELSE 0 END, 0
        ), 0) AS avg_score
        FROM assessments a
        JOIN staff_applicants sa ON sa.id = a.staff_id
        WHERE a.status = 'COMPLETED' ${staffBranchClause}
      `).catch(() => [{ avg_score: 0 }]);

      const retriesRows = await this.prisma.$queryRawUnsafe<{ total: bigint }[]>(`
        SELECT COUNT(*) as total FROM assessments
        WHERE attempt_number > 1
          AND created_at >= date_trunc('week', CURRENT_DATE)
      `).catch(() => [{ total: BigInt(0) }]);

      const videoCerts = await this.getVideoCerts(user);

      return {
        activeTrainees: Number(trainees[0]?.total ?? 0),
        sessionsToday: Number(sessionsToday[0]?.total ?? 0),
        videoCertsPending: Number(videoCertsRows[0]?.total ?? 0),
        attendancePending: Number(attendancePendingRows[0]?.total ?? 0),
        avgScore: Math.round(Number(avgScoreRows[0]?.avg_score ?? 0)),
        retries: Number(retriesRows[0]?.total ?? 0),
        videoCerts,
      };
    } catch {
      return {
        activeTrainees: 0,
        sessionsToday: 0,
        videoCertsPending: 0,
        attendancePending: 0,
        avgScore: 0,
        retries: 0,
        videoCerts: [],
      };
    }
  }

  async getAssignedBatches(user: AuthUser) {
    await this.ensureTables();
    const branchClause = this.branchClause(user);
    try {
    const trainerClause = await this.getTrainerEmployeeClause(user.id);
    
    const rows = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT
        b.id, b.batch_code, b.series, b.trainer_name, b.trainer_id, b.classroom,
        b.start_date, b.status, b.branch_id, b.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'id', e.id,
              'staffId', e.staff_id::text,
              'attendance', e.attendance,
              'staffCode', emp.employee_id,
              'fullName', emp.full_name,
              'mobile', emp.mobile,
              'department', emp.department,
              'designation', emp.designation
            ) ORDER BY emp.full_name
          ) FILTER (WHERE e.id IS NOT NULL),
          '[]'::json
        ) AS enrollments
      FROM training_batches b
      LEFT JOIN batch_enrollments e ON e.batch_id = b.id
      LEFT JOIN employees emp ON emp.id = e.staff_id AND emp.deleted_at IS NULL
      WHERE 1=1 ${branchClause} ${trainerClause}
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `);
    
    const mappedRows = rows.map((r) => {
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

    const allStaffIds = new Set<string>();
    const allStaffCodes = new Set<string>();
    for (const b of mappedRows) {
      for (const e of (b.enrollments || [])) {
        if (e.staffId) allStaffIds.add(String(e.staffId));
        if (e.staffCode) allStaffCodes.add(String(e.staffCode));
      }
    }

    if (allStaffIds.size > 0 || allStaffCodes.size > 0) {
      const assessments = await this.prisma.assessment.findMany({
        where: {
          OR: [
            { staffId: { in: Array.from(allStaffIds) } },
            { staff: { staffCode: { in: Array.from(allStaffCodes) } } },
            { staff: { id: { in: Array.from(allStaffIds) } } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        include: { staff: true },
      });

      const assessmentMap = new Map<string, any>();
      for (const a of assessments) {
        const scores = (a.skillScores || {}) as any;
        const scoreVal = Number(scores.score ?? scores.driving ?? scores.communication ?? 75);
        const assessmentObj = {
          score: scoreVal,
          result: a.result || 'PASS',
          remarks: a.remarks || '',
        };
        if (!assessmentMap.has(a.staffId)) assessmentMap.set(a.staffId, assessmentObj);
        if (a.staff?.staffCode && !assessmentMap.has(a.staff.staffCode)) {
          assessmentMap.set(a.staff.staffCode, assessmentObj);
        }
      }

      for (const b of mappedRows) {
        for (const e of (b.enrollments || [])) {
          const matched = assessmentMap.get(String(e.staffId)) || (e.staffCode ? assessmentMap.get(String(e.staffCode)) : undefined);
          if (matched) {
            e.assessment = matched;
          }
        }
      }
    }

    return mappedRows;
    } catch {
      return [];
    }
  }

  async reviewVideoCert(
    reviewerId: string,
    certId: string,
    body: { status: 'APPROVED' | 'REJECTED'; notes?: string },
  ) {
    return this.videoCertService.reviewCertification(
      certId,
      reviewerId,
      body.status,
      body.notes,
    );
  }

  async updateAssessment(trainerId: string, traineeId: string, data: any) {
    let staffId = traineeId;
    let applicant = await this.prisma.staffApplicant.findFirst({
      where: { OR: [{ id: traineeId }, { staffCode: traineeId }] },
    });
    if (!applicant) {
      const emp = await this.prisma.employee.findFirst({
        where: { OR: [{ id: traineeId }, { employeeId: traineeId }] },
      });
      if (emp) {
        applicant = await this.prisma.staffApplicant.findFirst({
          where: { OR: [{ mobile: emp.mobile }, { staffCode: emp.employeeId }] },
        });
        if (!applicant) {
          applicant = await this.prisma.staffApplicant.create({
            data: {
              id: emp.id,
              staffCode: emp.employeeId,
              fullName: emp.fullName,
              mobile: emp.mobile,
              dateOfBirth: emp.dateOfBirth ?? '1995-01-01',
              address: emp.address ?? 'Delhi',
              series: 'DRIVER',
              branchId: emp.branchId || null,
              pipelineStage: 'S3_TRAIN' as any,
              languageTier: 'T1' as any,
              pvStatus: 'CLEAR',
            },
          }).catch(async () => {
            return await this.prisma.staffApplicant.create({
              data: {
                staffCode: emp.employeeId,
                fullName: emp.fullName,
                mobile: emp.mobile,
                dateOfBirth: emp.dateOfBirth ?? '1995-01-01',
                address: emp.address ?? 'Delhi',
                series: 'DRIVER',
                branchId: emp.branchId || null,
                pipelineStage: 'S3_TRAIN' as any,
                languageTier: 'T1' as any,
                pvStatus: 'CLEAR',
              },
            });
          });
        }
      }
    }
    if (applicant) {
      staffId = applicant.id;
    }

    const attemptCount = await this.prisma.assessment.count({
      where: { staffId },
    });

    const scoreVal = Number(data?.score ?? 75);
    const skillScores = {
      score: scoreVal,
      communication: scoreVal,
      technical: scoreVal,
      empathy: scoreVal,
      driving: scoreVal,
      safety: scoreVal,
    };
    const resultVal = (data?.result || 'PASS') as any;
    const remarksVal = data?.remarks || '';

    const existing = await this.prisma.assessment.findFirst({
      where: { staffId },
      orderBy: { createdAt: 'desc' },
    });

    let saved;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trainerId);
    if (existing) {
      saved = await this.prisma.assessment.update({
        where: { id: existing.id },
        data: {
          skillScores,
          result: resultVal,
          remarks: remarksVal,
          status: 'COMPLETED',
          approvedAt: new Date(),
        },
      });
    } else {
      saved = await this.prisma.assessment.create({
        data: {
          staffId,
          assessorId: isUuid ? trainerId : null,
          attemptNumber: attemptCount + 1,
          skillScores,
          result: resultVal,
          remarks: remarksVal,
          status: 'COMPLETED',
          approvedAt: new Date(),
        },
      });
    }

    return { success: true, traineeId: staffId, assessment: saved };
  }
}
