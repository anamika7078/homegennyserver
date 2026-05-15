import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

// Pipeline Stages
export enum PipelineStage {
  S1_INTAKE = 'S1_INTAKE',
  S2_VERIFY = 'S2_VERIFY',
  S2_5_ASSESS = 'S2_5_ASSESS',
  S3_TRAIN = 'S3_TRAIN',
  S4_AGREEMENTS = 'S4_AGREEMENTS',
  S5_DEPLOY = 'S5_DEPLOY',
  DEFERRED = 'DEFERRED',
  TERMINAL = 'TERMINAL',
}

export enum StaffSeries {
  MAID = 'MAID',
  SC = 'SC',
  UC = 'UC',
  DR = 'DR',
}

export enum TerminalOutcome {
  PLACED = 'PLACED',
  REJECTED = 'REJECTED',
  ABANDONED = 'ABANDONED',
  RESTRICTED = 'RESTRICTED',
  DEFERRED = 'DEFERRED',
  CANCELLED = 'CANCELLED',
  LATE_EXIT = 'LATE_EXIT',
}

// Valid FSM transitions
const VALID_TRANSITIONS: Record<PipelineStage, PipelineStage[]> = {
  [PipelineStage.S1_INTAKE]: [PipelineStage.S2_VERIFY, PipelineStage.TERMINAL],
  [PipelineStage.S2_VERIFY]: [PipelineStage.S2_5_ASSESS, PipelineStage.S3_TRAIN, PipelineStage.TERMINAL, PipelineStage.DEFERRED],
  [PipelineStage.S2_5_ASSESS]: [PipelineStage.S3_TRAIN, PipelineStage.TERMINAL, PipelineStage.DEFERRED],
  [PipelineStage.S3_TRAIN]: [PipelineStage.S4_AGREEMENTS, PipelineStage.TERMINAL, PipelineStage.DEFERRED],
  [PipelineStage.S4_AGREEMENTS]: [PipelineStage.S5_DEPLOY, PipelineStage.TERMINAL],
  [PipelineStage.S5_DEPLOY]: [PipelineStage.TERMINAL],
  [PipelineStage.DEFERRED]: [PipelineStage.S2_VERIFY, PipelineStage.S3_TRAIN, PipelineStage.TERMINAL],
  [PipelineStage.TERMINAL]: [],
};

export interface StageTransitionInput {
  staffId: string;
  toStage: PipelineStage;
  actorId: string;
  reasonCode?: string;
  payload?: Record<string, any>;
}

@Injectable()
export class PipelineFsmService {
  private readonly logger = new Logger(PipelineFsmService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Scenario Router — pure function of flags → scenario code
   * Evaluates flags in strict priority order per series
   */
  routeScenario(series: StaffSeries, flags: Record<string, any>): string {
    switch (series) {
      case StaffSeries.DR:
        return this.routeDriverScenario(flags);
      case StaffSeries.SC:
        return this.routeSkillledCaretakerScenario(flags);
      case StaffSeries.UC:
        return this.routeUnskilledCaretakerScenario(flags);
      case StaffSeries.MAID:
        return this.routeMaidScenario(flags);
      default:
        throw new BadRequestException(`Unknown series: ${series}`);
    }
  }

  private routeDriverScenario(f: Record<string, any>): string {
    if (f.restricted_list) return 'DR-04';
    if (!f.aadhaar_verified) return 'DR-03';
    if (f.dl_expired) return 'DR-05';
    if (f.dl_suspended || f.dl_revoked) return 'DR-06';
    if (f.challan_count >= 3) return 'DR-07';
    if (f.challan_count >= 1 && f.challan_count < 3) return 'DR-08';
    if (f.practical_test_attempts >= 3 && !f.practical_passed) return 'DR-09';
    if (f.practical_test_attempts >= 2 && !f.practical_passed) return 'DR-10';
    if (f.pv_failed) return 'DR-11';
    if (f.medical_failed) return 'DR-12';
    if (f.abandoned) return this.routeAbandonmentDR(f);
    if (f.pv_pending && f.series === 'DR') return 'DR-13'; // DR requires clear PV
    if (!f.video_cert_complete) return 'DR-14';
    if (f.agreement_rejected) return 'DR-15';
    if (f.trial_client_reject) return 'DR-16';
    if (f.trial_staff_exit) return 'DR-17';
    if (f.placed_extended_trial) return 'DR-18';
    if (f.trial_mutual_exit) return 'DR-20';
    if (f.placed_confirmed) return 'DR-01'; // Successful placement
    if (f.placed_trial) return 'DR-02';
    return 'DR-19'; // Deferred pending re-assessment
  }

  private routeSkillledCaretakerScenario(f: Record<string, any>): string {
    if (f.restricted_list) return 'SC-04';
    if (!f.aadhaar_verified) return 'SC-03';
    if (f.medical_failed) return 'SC-05';
    if (f.pv_failed) return 'SC-06';
    if (f.competency_failed_3x) return 'SC-07';
    if (f.competency_failed_2x) return 'SC-08';
    if (f.abandoned) return this.routeAbandonmentSC(f);
    if (f.pv_pending && !f.pv_exempt) return 'SC-09';
    if (!f.video_cert_complete) return 'SC-10';
    if (f.agreement_rejected) return 'SC-11';
    if (f.trial_client_reject) return 'SC-12';
    if (f.trial_staff_exit) return 'SC-13';
    if (f.placed_extended_trial) return 'SC-14';
    if (f.trial_mutual_exit) return 'SC-17';
    if (f.upgrade_eligible) return 'SC-15';
    if (f.placed_confirmed) return 'SC-01';
    return 'SC-16';
  }

  private routeUnskilledCaretakerScenario(f: Record<string, any>): string {
    if (f.restricted_list) return 'UC-04';
    if (!f.aadhaar_verified) return 'UC-03';
    if (f.pv_failed) return 'UC-05';
    if (f.abandoned) return this.routeAbandonmentUC(f);
    if (f.pv_pending && !f.pv_exempt) return 'UC-06';
    if (!f.video_cert_complete) return 'UC-07';
    if (f.agreement_rejected) return 'UC-08';
    if (f.trial_client_reject) return 'UC-09';
    if (f.trial_staff_exit) return 'UC-10';
    if (f.placed_extended_trial) return 'UC-11';
    if (f.trial_mutual_exit) return 'UC-17';
    if (f.upgrade_eligible) return 'UC-12';
    if (f.placed_confirmed) return 'UC-01';
    return 'UC-16';
  }

  private routeMaidScenario(f: Record<string, any>): string {
    if (f.restricted_list) return 'M3X-04';
    if (!f.aadhaar_verified) return 'M3X-03';
    if (f.pv_failed) return 'M3X-05';
    if (f.abandoned) return this.routeAbandonmentMaid(f);
    if (f.pv_pending) return 'M3X-06'; // Maid — deploy allowed with pending PV
    if (!f.video_cert_complete) return 'M3X-07';
    if (f.agreement_rejected) return 'M3X-08';
    if (f.trial_client_reject) return 'M3X-09';
    if (f.trial_staff_exit) return 'M3X-10';
    if (f.placed_extended_trial) return 'M3X-11';
    if (f.trial_mutual_exit) return 'M3X-14';
    if (f.placed_confirmed) return 'M3X-01';
    return 'M3X-13';
  }

  private routeAbandonmentDR(f: Record<string, any>): string {
    if (f.abandoned_pre_deposit) return 'DR-03A';
    if (f.abandoned_mid_training) return 'DR-03B';
    return 'DR-03C';
  }
  private routeAbandonmentSC(f: Record<string, any>): string { return f.abandoned_pre_deposit ? 'SC-09A' : 'SC-09B'; }
  private routeAbandonmentUC(f: Record<string, any>): string { return f.abandoned_pre_deposit ? 'UC-06A' : 'UC-06B'; }
  private routeAbandonmentMaid(f: Record<string, any>): string { return f.abandoned_pre_deposit ? 'M3X-06A' : 'M3X-06B'; }

  /**
   * Advance pipeline stage with full audit trail
   */
  async advanceStage(input: StageTransitionInput): Promise<void> {
    const { staffId, toStage, actorId, reasonCode, payload } = input;

    await this.dataSource.transaction(async (manager) => {
      const staff = await manager.query(
        `SELECT id, pipeline_stage, series FROM staff_applicants WHERE id = $1 FOR UPDATE`,
        [staffId]
      );

      if (!staff.length) throw new BadRequestException(`Staff ${staffId} not found`);

      const current: PipelineStage = staff[0].pipeline_stage;
      const validNext = VALID_TRANSITIONS[current];

      if (!validNext.includes(toStage)) {
        throw new BadRequestException(
          `Invalid transition: ${current} → ${toStage}. Allowed: ${validNext.join(', ')}`
        );
      }

      // Update stage
      await manager.query(
        `UPDATE staff_applicants SET pipeline_stage = $1, updated_at = NOW() WHERE id = $2`,
        [toStage, staffId]
      );

      // Append event
      await manager.query(
        `INSERT INTO pipeline_events (staff_id, event_type, from_stage, to_stage, actor_id, reason_code, payload)
         VALUES ($1, 'STAGE_ADVANCE', $2, $3, $4, $5, $6)`,
        [staffId, current, toStage, actorId, reasonCode || null, JSON.stringify(payload || {})]
      );

      this.logger.log(`[FSM] ${staffId}: ${current} → ${toStage} by ${actorId}`);
    });
  }
}
