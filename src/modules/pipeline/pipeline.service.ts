import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StaffApplicant, PipelineStage, TerminalOutcome, Series } from '../staff/staff.entity';
import { PipelineEvent, EventType } from './pipeline-event.entity';

// ── Flags fed into the scenario router ───────────────────────────────────────
export interface RoutingFlags {
  // DR flags
  licenceFraud?: boolean;
  identityFraud?: boolean;
  duiConviction?: boolean;
  hitAndRun?: boolean;
  ruleRefusal?: boolean;
  confirmed2x?: boolean;
  epilepsy?: boolean;
  colourBlind?: boolean;
  violations?: number;
  licenceNearExpiry?: boolean;
  medicalConcern?: boolean;
  documentGap?: boolean;
  vehicleTypeRestriction?: boolean;
  firstSchoolRun?: boolean;
  languageTier?: string;
  noPriorProfessional?: boolean;
  returning?: boolean;
  cleanExit?: boolean;
  // SC flags
  scopeViolation?: boolean;
  credentialFraud?: boolean;
  adversePV?: boolean;
  vulnerablePersonOffence?: boolean;
  activeHealthCondition?: boolean;
  skillsGap?: boolean;
  trainable?: boolean;
  credentialGap?: boolean;
  careTypeRestriction?: boolean;
  firstHighAcuity?: boolean;
  caregiverHealth?: boolean;
  noPriorExperience?: boolean;
  // UC flags
  scopeBoundaryRefusal?: boolean;
  documentFraud?: boolean;
  temperamentDenial2D?: boolean;
  temperamentConcern1D?: boolean;
  firstNsOrBp?: boolean;
  roleTypeRestriction?: boolean;
  // Maid flags
  healthActive?: boolean;
  pendingPV?: boolean;
  noPriorExp?: boolean;
}

// ── Valid stage transitions ───────────────────────────────────────────────────
const VALID_TRANSITIONS: Record<PipelineStage, PipelineStage[]> = {
  [PipelineStage.S1_INTAKE]: [PipelineStage.S2_VERIFY, PipelineStage.TERMINAL],
  [PipelineStage.S2_VERIFY]: [PipelineStage.S2_5_ASSESS, PipelineStage.S3_TRAIN, PipelineStage.TERMINAL],
  [PipelineStage.S2_5_ASSESS]: [PipelineStage.S3_TRAIN, PipelineStage.TERMINAL],
  [PipelineStage.S3_TRAIN]: [PipelineStage.S4_AGREEMENTS, PipelineStage.TERMINAL],
  [PipelineStage.S4_AGREEMENTS]: [PipelineStage.S5_DEPLOY, PipelineStage.TERMINAL],
  [PipelineStage.S5_DEPLOY]: [PipelineStage.TERMINAL],
  [PipelineStage.TERMINAL]: [],
  [PipelineStage.DEFERRED]: [PipelineStage.S2_VERIFY, PipelineStage.S3_TRAIN, PipelineStage.TERMINAL],
};

// ── Outcomes that require BM approval ────────────────────────────────────────
const BM_REQUIRED_OUTCOMES = [
  TerminalOutcome.DENIED,
];

@Injectable()
export class PipelineService {
  constructor(
    @InjectRepository(StaffApplicant)
    private staffRepo: Repository<StaffApplicant>,
    @InjectRepository(PipelineEvent)
    private eventRepo: Repository<PipelineEvent>,
    private dataSource: DataSource,
    private eventEmitter: EventEmitter2,
  ) {}

  // ── Route to correct scenario document ───────────────────────────────────
  routeScenario(series: Series, flags: RoutingFlags): string {
    switch (series) {
      case Series.DRIVER:
        return this.routeDriver(flags);
      case Series.SKILLED_CARE:
        return this.routeSkilledCare(flags);
      case Series.UNSKILLED_CARE:
        return this.routeUnskilledCare(flags);
      case Series.MAID:
        return this.routeMaid(flags);
      default:
        throw new BadRequestException(`Unknown series: ${series}`);
    }
  }

  private routeDriver(f: RoutingFlags): string {
    if (f.licenceFraud || f.identityFraud)         return 'DR-12';
    if (f.duiConviction || f.hitAndRun)             return 'DR-13';
    if (f.ruleRefusal && f.confirmed2x)             return 'DR-15';
    if (f.epilepsy || f.colourBlind)                return 'DR-14';
    if ((f.violations ?? 0) >= 4)                   return 'DR-14';
    if ((f.violations ?? 0) >= 1 && (f.violations ?? 0) <= 2) return 'DR-07';
    if (f.licenceNearExpiry)                        return 'DR-09';
    if (f.medicalConcern)                           return 'DR-10';
    if (f.documentGap)                              return 'DR-11';
    if (f.vehicleTypeRestriction)                   return 'DR-05';
    if (f.firstSchoolRun)                           return 'DR-08';
    if (f.languageTier === 'T3' || f.languageTier === 'T4') return 'DR-02';
    if (f.noPriorProfessional)                      return 'DR-03';
    if (f.returning && f.cleanExit)                 return 'DR-04';
    return 'DR-01';
  }

  private routeSkilledCare(f: RoutingFlags): string {
    if (f.scopeViolation && f.confirmed2x)          return 'SC-12';
    if (f.credentialFraud)                          return 'SC-10';
    if (f.adversePV && f.vulnerablePersonOffence)   return 'SC-11';
    if (f.activeHealthCondition)                    return 'SC-07';
    if (f.skillsGap && f.trainable)                 return 'SC-08';
    if (f.credentialGap)                            return 'SC-09';
    if (f.careTypeRestriction)                      return 'SC-04';
    if (f.caregiverHealth)                          return 'SC-05';
    if (f.firstHighAcuity)                          return 'SC-06';
    if (f.returning)                                return 'SC-03';
    if (f.noPriorExperience)                        return 'SC-02';
    return 'SC-01';
  }

  private routeUnskilledCare(f: RoutingFlags): string {
    if (f.scopeBoundaryRefusal && f.confirmed2x)    return 'UC-12';
    if (f.documentFraud)                            return 'UC-10';
    if (f.adversePV || f.temperamentDenial2D)       return 'UC-11';
    if (f.temperamentConcern1D)                     return 'UC-08';
    if (f.firstNsOrBp)                              return 'UC-06';
    if (f.activeHealthCondition)                    return 'UC-07';
    if (f.documentGap)                              return 'UC-09';
    if (f.roleTypeRestriction)                      return 'UC-04';
    if (f.returning)                                return 'UC-03';
    if (f.noPriorExperience)                        return 'UC-02';
    return 'UC-01';
  }

  private routeMaid(f: RoutingFlags): string {
    if (f.documentFraud)   return 'M3X-09';
    if (f.adversePV)       return 'M3X-10';
    if (f.healthActive)    return 'M3X-07';
    if (f.documentGap)     return 'M3X-08';
    if (f.pendingPV)       return 'M3X-06';
    if (f.returning)       return 'M3X-03';
    if (f.noPriorExp)      return 'M3X-02';
    return 'M3X-01';
  }

  // ── Advance pipeline stage ────────────────────────────────────────────────
  async advanceStage(
    staffId: string,
    toStage: PipelineStage,
    actorId: string,
    flags: RoutingFlags,
    completedItems: string[],
    notes?: string,
  ): Promise<StaffApplicant> {
    return this.dataSource.transaction(async (manager) => {
      const staff = await manager.findOneOrFail(StaffApplicant, {
        where: { id: staffId },
      });

      // Validate transition
      const validNext = VALID_TRANSITIONS[staff.pipeline_stage];
      if (!validNext.includes(toStage)) {
        throw new BadRequestException(
          `Invalid transition: ${staff.pipeline_stage} → ${toStage}`
        );
      }

      // Route scenario
      const newScenario = this.routeScenario(staff.series, flags);
      const fromStage = staff.pipeline_stage;

      // Update staff record
      staff.pipeline_stage = toStage;
      staff.current_scenario_code = newScenario;
      await manager.save(staff);

      // Append-only event log
      const event = manager.create(PipelineEvent, {
        staff_id: staffId,
        event_type: EventType.STAGE_ADVANCE,
        from_stage: fromStage,
        to_stage: toStage,
        actor_id: actorId,
        reason_code: `${newScenario}-ADVANCE`,
        payload: { completedItems, flags },
        notes,
      });
      await manager.save(event);

      // Emit for notifications
      this.eventEmitter.emit('pipeline.advanced', {
        staffId,
        fromStage,
        toStage,
        scenario: newScenario,
        actorId,
      });

      return staff;
    });
  }

  // ── Set terminal outcome ──────────────────────────────────────────────────
  async setOutcome(
    staffId: string,
    outcome: TerminalOutcome,
    scenarioCode: string,
    reason: string,
    actorId: string,
    bmApprovalId?: string,
  ): Promise<StaffApplicant> {
    // BM approval required for DENIED outcomes
    if (BM_REQUIRED_OUTCOMES.includes(outcome) && !bmApprovalId) {
      throw new ForbiddenException('BM approval required for DENIED outcome');
    }

    return this.dataSource.transaction(async (manager) => {
      const staff = await manager.findOneOrFail(StaffApplicant, {
        where: { id: staffId },
      });

      const fromStage = staff.pipeline_stage;
      staff.pipeline_stage = PipelineStage.TERMINAL;
      staff.terminal_outcome = outcome;
      staff.current_scenario_code = scenarioCode;

      // Auto-blacklist on fraud/NEVER categories
      if (['DR-12', 'DR-13', 'SC-10', 'SC-11', 'SC-12', 'UC-10', 'UC-11', 'UC-12', 'M3X-09', 'M3X-10'].includes(scenarioCode)) {
        staff.restricted_list_flag = true;
        staff.metadata = {
          ...staff.metadata,
          blacklist_reason: `${scenarioCode}: ${reason}`,
        };
      }

      await manager.save(staff);

      // Log event
      await manager.save(manager.create(PipelineEvent, {
        staff_id: staffId,
        event_type: EventType.OUTCOME_SET,
        from_stage: fromStage,
        to_stage: PipelineStage.TERMINAL,
        actor_id: actorId,
        reason_code: `${scenarioCode}-${outcome}`,
        payload: { outcome, scenarioCode, reason, bmApprovalId },
      }));

      // Emit for downstream: settlement, re-pool, notifications
      this.eventEmitter.emit('pipeline.outcome', {
        staffId,
        outcome,
        scenarioCode,
        reason,
      });

      return staff;
    });
  }

  // ── Get pipeline status for an applicant ─────────────────────────────────
  async getPipelineStatus(staffId: string) {
    const staff = await this.staffRepo.findOneOrFail({ where: { id: staffId } });
    const events = await this.eventRepo.find({
      where: { staff_id: staffId },
      order: { occurred_at: 'ASC' },
    });
    return { staff, events };
  }
}
