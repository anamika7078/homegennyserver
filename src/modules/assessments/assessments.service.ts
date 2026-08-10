import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, AssessmentResult } from '@prisma/client';

const MAX_PRACTICAL_ATTEMPTS = 3;
export const DRIVER_PRACTICAL_ASSESSMENT_TYPE = 'DRIVER_PRACTICAL';
const TERMINAL_SCENARIO_DR09 = 'DR-09';

/**
 * NOTE (Phase 3 fix): this service previously used a TypeORM entity
 * (`./entities/assessment.entity.ts`, table `assessments`) whose columns
 * (`candidate_id`, `assessment_type`, `series`, `scenario_code`, `score`,
 * `updated_at`) do not exist on the live `assessments` table — the table was
 * actually created by Prisma's schema (`staff_id`, `skill_scores` jsonb,
 * `overreach_flags` jsonb, `approved_at`, `result` enum). Every call here
 * would have failed with a Postgres "column does not exist" error; the
 * referenced `assessment_audit_logs` table didn't exist in the database at
 * all. This rewrite targets the real schema via Prisma and reuses the app's
 * actual audit trail (AuditService/AuditLog) instead of the missing table.
 * "Assessment type" (e.g. the DR practical test) has no dedicated column in
 * the live schema, so it's stored as `skillScores.assessmentType` — the
 * `skillScores` JSON field already exists for exactly this kind of flexible,
 * per-assessment data.
 */
@Injectable()
export class AssessmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll() {
    return this.prisma.assessment.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string) {
    const assessment = await this.prisma.assessment.findUnique({ where: { id } });
    if (!assessment) throw new NotFoundException('Assessment not found');
    return assessment;
  }

  private async resolveStaff(candidateRef: string) {
    const applicant = await this.prisma.staffApplicant.findFirst({
      where: {
        OR: [
          { id: candidateRef },
          { staffCode: { equals: candidateRef, mode: 'insensitive' } },
        ],
      },
    });
    if (!applicant) throw new BadRequestException(`Staff applicant not found: ${candidateRef}`);
    return applicant;
  }

  /** Attempts already recorded for this staff + assessment type. */
  private async countAttempts(staffId: string, assessmentType: string): Promise<number> {
    const existing = await this.prisma.assessment.findMany({ where: { staffId } });
    return existing.filter((a) => (a.skillScores as Record<string, unknown> | null)?.assessmentType === assessmentType).length;
  }

  async create(data: Record<string, unknown>) {
    const candidateRef = String(data.staff_id ?? data.candidate_id ?? '');
    if (!candidateRef) throw new BadRequestException('staff_id is required');
    const applicant = await this.resolveStaff(candidateRef);

    const assessmentType = String(data.assessment_type ?? 'GENERAL').toUpperCase();
    const attemptCount = await this.countAttempts(applicant.id, assessmentType);

    // Enforce the 3-attempt limit BEFORE creating a new attempt for the DR
    // practical test — this is the actual server-side enforcement the audit
    // required; the button-hiding alone was never a control.
    if (assessmentType === DRIVER_PRACTICAL_ASSESSMENT_TYPE && attemptCount >= MAX_PRACTICAL_ATTEMPTS) {
      throw new BadRequestException(
        `DR series practical test limit of ${MAX_PRACTICAL_ATTEMPTS} attempts reached. Candidate must be terminated (${TERMINAL_SCENARIO_DR09}).`,
      );
    }

    const assessorId = data.assessor_id && data.assessor_id !== 'system' ? String(data.assessor_id) : null;
    const skillScoresInput = (data.skill_scores as Record<string, unknown>) ?? {};

    const created = await this.prisma.assessment.create({
      data: {
        staffId: applicant.id,
        assessorId,
        attemptNumber: attemptCount + 1,
        skillScores: { ...skillScoresInput, assessmentType },
        status: 'PENDING',
        remarks: data.remarks ? String(data.remarks) : null,
      },
    });

    await this.audit.log({
      actorId: assessorId ?? undefined,
      action: AuditAction.STAGE_TRANSITION,
      entityType: 'assessment',
      entityId: created.id,
      metadata: { staffId: applicant.id, assessmentType, attemptNumber: created.attemptNumber },
    });

    return created;
  }

  async update(id: string, data: Record<string, unknown>) {
    await this.findOne(id);
    const patch: Record<string, unknown> = {};
    if (data.status) patch.status = String(data.status);
    if (data.remarks !== undefined) patch.remarks = data.remarks ? String(data.remarks) : null;
    if (data.assessor_id) patch.assessorId = String(data.assessor_id);
    return this.prisma.assessment.update({ where: { id }, data: patch });
  }

  async submit(data: { id: string; score?: number; result: AssessmentResult; remarks?: string }) {
    const { id, score, result, remarks } = data;
    const assessment = await this.findOne(id);

    const skillScores = { ...(assessment.skillScores as Record<string, unknown> | null), score };
    const updated = await this.prisma.assessment.update({
      where: { id },
      data: { skillScores, result, remarks: remarks ?? assessment.remarks, status: 'COMPLETED' },
    });

    await this.audit.log({
      actorId: assessment.assessorId ?? undefined,
      action: AuditAction.STAGE_TRANSITION,
      entityType: 'assessment',
      entityId: id,
      metadata: { score, result },
    });

    // ── Pillar 2: 3-attempt hard limit for DR practical test ────────────────
    const assessmentType = (assessment.skillScores as Record<string, unknown> | null)?.assessmentType;
    if (assessmentType === DRIVER_PRACTICAL_ASSESSMENT_TYPE && result === 'FAIL') {
      const all = await this.prisma.assessment.findMany({ where: { staffId: assessment.staffId } });
      const totalFails = all.filter(
        (a) => (a.skillScores as Record<string, unknown> | null)?.assessmentType === DRIVER_PRACTICAL_ASSESSMENT_TYPE
          && a.result === 'FAIL',
      ).length;

      if (totalFails >= MAX_PRACTICAL_ATTEMPTS) {
        await this.prisma.staffApplicant.update({
          where: { id: assessment.staffId },
          data: {
            pipelineStage: 'TERMINAL',
            terminalOutcome: 'DENIED',
            currentScenarioCode: TERMINAL_SCENARIO_DR09,
          },
        });

        await this.prisma.pipelineEvent.create({
          data: {
            staffId: assessment.staffId,
            eventType: 'AUTO_TERMINAL',
            fromStage: 'S2_5_ASSESS',
            toStage: 'TERMINAL',
            actorId: assessment.assessorId,
            scenarioCode: TERMINAL_SCENARIO_DR09,
            reasonCode: TERMINAL_SCENARIO_DR09,
            payload: {
              reason: 'Exceeded maximum 3 practical test attempts',
              fail_count: totalFails,
              assessment_id: id,
            },
          },
        });

        return {
          ...updated,
          autoTerminated: true,
          terminalOutcome: 'DENIED',
          message: `Staff auto-terminated after ${MAX_PRACTICAL_ATTEMPTS} failed DR practical tests.`,
        };
      }
    }

    return updated;
  }
}
