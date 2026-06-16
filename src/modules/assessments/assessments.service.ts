import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Assessment } from './entities/assessment.entity';
import { AssessmentAuditLog } from './entities/assessment-audit-log.entity';
import { PrismaService } from '../../prisma/prisma.service';

const MAX_PRACTICAL_ATTEMPTS = 3;
const DRIVER_SERIES_TYPE = 'DRIVER';
const TERMINAL_OUTCOME_DR09 = 'DR-09';

@Injectable()
export class AssessmentsService {
  constructor(
    @InjectRepository(Assessment)
    private readonly assessmentRepo: Repository<Assessment>,
    @InjectRepository(AssessmentAuditLog)
    private readonly auditRepo: Repository<AssessmentAuditLog>,
    private readonly prisma: PrismaService,
  ) {}

  async findAll() {
    return this.assessmentRepo.find();
  }

  async findOne(id: string) {
    const assessment = await this.assessmentRepo.findOne({ where: { id } });
    if (!assessment) throw new NotFoundException('Assessment not found');
    return assessment;
  }

  async create(data: any) {
    try {
      if (data.candidate_id) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.candidate_id);
      if (!isUuid) {
        const applicant = await this.prisma.staffApplicant.findFirst({
          where: {
            OR: [
              { staffCode: { contains: data.candidate_id, mode: 'insensitive' } },
              { fullName: { contains: data.candidate_id, mode: 'insensitive' } }
            ]
          }
        });
        if (!applicant) {
          throw new BadRequestException(`Candidate not found matching ID/Name: ${data.candidate_id}`);
        }
        data.candidate_id = applicant.id;
      }
    }

    let attemptCount = 0;
    if (data.candidate_id && data.assessment_type) {
      attemptCount = await this.assessmentRepo.count({
        where: {
          candidate_id: data.candidate_id,
          assessment_type: data.assessment_type,
        },
      });
      
      // Enforce 3-attempt limit before creating a new attempt for DRIVER
      if (data.assessment_type === DRIVER_SERIES_TYPE && attemptCount >= MAX_PRACTICAL_ATTEMPTS) {
        throw new BadRequestException(
          `DR series practical test limit of ${MAX_PRACTICAL_ATTEMPTS} attempts reached. Candidate must be terminated (${TERMINAL_OUTCOME_DR09}).`,
        );
      }
    }

    data.attempt_number = attemptCount + 1;

    if (!data.assessor_id || data.assessor_id === 'system') {
      data.assessor_id = null;
    }

    const assessment = this.assessmentRepo.create(data as Partial<Assessment>);
    const saved = await this.assessmentRepo.save(assessment);
    await this.auditRepo.save({
      assessment_id: saved.id,
      actor_id: data.assessor_id,
      action: 'CREATED',
      payload: data,
    });
    return saved;
    } catch (err) {
      console.error('Error creating assessment:', err);
      throw new BadRequestException(err instanceof Error ? err.message : String(err));
    }
  }

  async update(id: string, data: any) {
    await this.assessmentRepo.update(id, data);
    const updated = await this.findOne(id);
    await this.auditRepo.save({
      assessment_id: id,
      actor_id: data.assessor_id || 'system',
      action: 'UPDATED',
      payload: data,
    });
    return updated;
  }

  async submit(data: any) {
    const { id, score, result, remarks, scenario_code } = data;
    const assessment = await this.findOne(id);

    assessment.score = score;
    assessment.result = result;
    assessment.remarks = remarks;
    if (scenario_code) assessment.scenario_code = scenario_code;
    assessment.status = 'COMPLETED';

    const saved = await this.assessmentRepo.save(assessment);

    await this.auditRepo.save({
      assessment_id: id,
      actor_id: assessment.assessor_id,
      action: 'SUBMITTED',
      payload: { score, result, remarks, scenario_code },
    });

    // ── Pillar 2: 3-attempt hard limit for DR series ────────────────────────
    if (assessment.assessment_type === DRIVER_SERIES_TYPE && result === 'FAIL' && assessment.candidate_id) {
      const totalFails = await this.assessmentRepo.count({
        where: {
          candidate_id: assessment.candidate_id,
          assessment_type: DRIVER_SERIES_TYPE,
          result: 'FAIL',
        },
      });

      if (totalFails >= MAX_PRACTICAL_ATTEMPTS) {
        // Auto-terminate: move staff to TERMINAL with DR-09 scenario code
        await this.prisma.staffApplicant.update({
          where: { id: assessment.candidate_id },
          data: {
            pipelineStage: 'TERMINAL',
            terminalOutcome: 'DENIED',
            currentScenarioCode: TERMINAL_OUTCOME_DR09,
          },
        });

        await this.prisma.pipelineEvent.create({
          data: {
            staffId: assessment.candidate_id,
            eventType: 'AUTO_TERMINAL',
            fromStage: 'S2_5_ASSESS',
            toStage: 'TERMINAL',
            actorId: assessment.assessor_id,
            reasonCode: TERMINAL_OUTCOME_DR09,
            payload: {
              reason: 'Exceeded maximum 3 practical test attempts',
              fail_count: totalFails,
              assessment_id: id,
            },
          },
        });

        return {
          ...saved,
          autoTerminated: true,
          terminalOutcome: 'DENIED',
          message: `Staff auto-terminated after ${MAX_PRACTICAL_ATTEMPTS} failed DR practical tests.`,
        };
      }
    }

    return saved;
  }
}
