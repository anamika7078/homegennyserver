import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { TerminalOutcome } from '@prisma/client';
import * as crypto from 'crypto';
import { mapSeriesToShort, mapSeriesFromShort } from '../../common/mappers/staff.mapper';

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

// Local short-form vocabulary this file's routing functions switch on.
// The database enum (Prisma StaffSeries) uses MAID/SKILLED_CARE/
// UNSKILLED_CARE/DRIVER — callers may pass either form; routeScenario()
// normalizes via the canonical mapper in common/mappers/staff.mapper.ts
// before dispatching, which is the same mapping staff.service.ts already
// uses. This was the root cause of the audit's "0 video prompts for
// SC/UC/DR" finding (video-cert.service.ts had the identical gap).
export enum StaffSeries {
  MAID = 'MAID',
  SC = 'SC',
  UC = 'UC',
  DR = 'DR',
}

// NOTE: this file used to also declare its own local `TerminalOutcome` enum
// here (PLACED/REJECTED/ABANDONED/RESTRICTED/DEFERRED/CANCELLED/LATE_EXIT) —
// values that don't match the real database enum at all (Prisma's
// TerminalOutcome, imported above, is ENROLLED/CONDITIONAL/DEFERRED/DENIED/
// ABANDONED/LATE_EXIT). It was unused outside this file, so removed rather
// than reconciled — the Prisma import is now the only TerminalOutcome here,
// and it's the one that actually matches staff_applicants.terminal_outcome.

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
  /** Required when toStage === TERMINAL — see advanceStage(). */
  terminalOutcome?: TerminalOutcome;
}

const VALID_TERMINAL_OUTCOMES = new Set(Object.values(TerminalOutcome));

/** Video prompt counts per series — mirrors video-cert.service.ts's VIDEO_PROMPTS keys. */
const REQUIRED_VIDEO_PROMPTS: Record<string, number> = { MAID: 9, SC: 10, UC: 10, DR: 12 };

@Injectable()
export class PipelineFsmService {
  private readonly logger = new Logger(PipelineFsmService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Scenario Router — pure function of flags → scenario code
   * Evaluates flags in strict priority order per series
   */
  routeScenario(series: StaffSeries | string, flags: Record<string, any>): string {
    // Normalize whichever vocabulary the caller used (short 'SC'/'UC'/'DR' or
    // DB-form 'SKILLED_CARE'/'UNSKILLED_CARE'/'DRIVER') to the short form
    // this file's switch statements are written against.
    const shortSeries = mapSeriesToShort(mapSeriesFromShort(String(series)));
    switch (shortSeries) {
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
   * Deployment eligibility (S4_AGREEMENTS → S5_DEPLOY). Uses only what's
   * actually implemented (Pillars 1–5); Pillars 6–9 have no dedicated
   * workflow yet and are out of Phase 3 scope. Returns both the pass/fail
   * decision AND the flags, so the same evaluation can also feed
   * routeScenario() for a documented "why" — the gate itself never derives
   * its decision from a scenario-code string, only from these direct checks.
   */
  private async checkDeploymentEligibility(
    manager: { query: (sql: string, params?: any[]) => Promise<any[]> },
    staffId: string,
    seriesShort: string,
    pvStatus: string,
  ): Promise<{ eligible: boolean; blockers: string[]; flags: Record<string, any> }> {
    const blockers: string[] = [];
    const flags: Record<string, any> = {};

    // Aadhaar eKYC — required for every series (verification.service.ts's
    // REQUIRED_BY_SERIES). Was hardcoded `aadhaar_verified: true` here, so a
    // staff could reach S5_DEPLOY whether or not RM ever actually verified
    // Aadhaar — the VerificationTrack row was recorded but never read back.
    const aadhaarRows = await manager.query(
      `SELECT status FROM verification_tracks WHERE staff_id = $1 AND track_type = 'AADHAAR_EKYC'`,
      [staffId],
    );
    const aadhaarStatus = aadhaarRows[0]?.status;
    flags.aadhaar_verified = aadhaarStatus === 'CLEAR';
    if (aadhaarStatus !== 'CLEAR') {
      blockers.push(`Aadhaar eKYC not verified — status=${aadhaarStatus ?? 'NOT_STARTED'}`);
    }

    // Pillar 4 — Police Verification. Maid has a documented exception:
    // pending PV does not block deployment, only an adverse (failed) result does.
    if (seriesShort === 'MAID') {
      flags.pv_pending = pvStatus === 'NOT_INITIATED' || pvStatus === 'IN_PROGRESS';
      flags.pv_failed = pvStatus === 'ADVERSE';
      if (flags.pv_failed) blockers.push(`Police verification failed (Pillar 4) — pv_status=${pvStatus}`);
    } else {
      flags.pv_pending = pvStatus !== 'CLEAR';
      flags.pv_failed = pvStatus === 'ADVERSE';
      if (pvStatus !== 'CLEAR') {
        blockers.push(`Police verification not CLEAR (Pillar 4) — pv_status=${pvStatus}, ${seriesShort} requires CLEAR before deployment`);
      }
    }

    // Pillar 5 — Video Certification: every required prompt must have an
    // RM-approved submission (Pillar 5 doc: "RM: reviews and signs off").
    const requiredPrompts = REQUIRED_VIDEO_PROMPTS[seriesShort] ?? 0;
    const videoRows = await manager.query(
      `SELECT COUNT(DISTINCT prompt_key)::int AS cnt FROM video_certifications WHERE staff_id = $1 AND review_status = 'APPROVED'`,
      [staffId],
    );
    const approvedPrompts = videoRows[0]?.cnt ?? 0;
    flags.video_cert_complete = approvedPrompts >= requiredPrompts;
    if (!flags.video_cert_complete) {
      blockers.push(`Video certification incomplete (Pillar 5) — ${approvedPrompts}/${requiredPrompts} prompts RM-approved`);
    }

    // Agreement requirement (all series).
    const agreementRows = await manager.query(
      `SELECT COUNT(*)::int AS cnt FROM agreements WHERE staff_id = $1 AND status = 'SIGNED'`,
      [staffId],
    );
    const agreementSigned = (agreementRows[0]?.cnt ?? 0) > 0;
    flags.agreement_rejected = !agreementSigned;
    if (!agreementSigned) blockers.push('No signed agreement on file');

    // Pillar 3 — Medical/Sobriety, required for SC/UC/DR (not MAID).
    if (seriesShort === 'SC' || seriesShort === 'UC' || seriesShort === 'DR') {
      const medRows = await manager.query(
        `SELECT status FROM verification_tracks WHERE staff_id = $1 AND track_type = 'HEALTH_SCREENING'`,
        [staffId],
      );
      const medStatus = medRows[0]?.status;
      flags.medical_failed = medStatus === 'FAILED';
      if (medStatus !== 'CLEAR') {
        blockers.push(`Medical/sobriety not CLEAR (Pillar 3) — status=${medStatus ?? 'NOT_SUBMITTED'}`);
      }
    }

    // DR-specific: Pillar 1 (Licence), eChallan, Pillar 2 (practical test).
    if (seriesShort === 'DR') {
      const dlRows = await manager.query(
        `SELECT status FROM verification_tracks WHERE staff_id = $1 AND track_type = 'SARATHI_API'`,
        [staffId],
      );
      const dlStatus = dlRows[0]?.status;
      flags.dl_expired = dlStatus === 'EXPIRED';
      flags.dl_suspended = dlStatus === 'FAILED';
      if (dlStatus !== 'CLEAR') {
        blockers.push(`Driving licence not verified CLEAR (Pillar 1) — status=${dlStatus ?? 'NOT_CHECKED'}`);
      }

      const echallanRows = await manager.query(
        `SELECT status, result FROM verification_tracks WHERE staff_id = $1 AND track_type = 'ECHALLAN_API'`,
        [staffId],
      );
      if (!echallanRows.length) {
        blockers.push('eChallan not checked');
      } else {
        flags.challan_count = echallanRows[0].result?.count ?? null;
        if (echallanRows[0].status === 'FAILED') {
          blockers.push(`eChallan check shows severe violation count (>=3, DR-07) — count=${flags.challan_count}`);
        }
      }

      const practicalRows = await manager.query(
        `SELECT id FROM assessments WHERE staff_id = $1 AND skill_scores->>'assessmentType' = 'DRIVER_PRACTICAL' AND result = 'PASS' LIMIT 1`,
        [staffId],
      );
      flags.practical_passed = practicalRows.length > 0;
      if (!flags.practical_passed) blockers.push('Practical driving test not passed (Pillar 2)');
    }

    return { eligible: blockers.length === 0, blockers, flags };
  }

  /**
   * Identity/background verification tracks — Aadhaar eKYC, Police Verification,
   * Medical/Sobriety, and (DR-only) Driving Licence + eChallan. This is exactly
   * what S2_VERIFY exists for, and exactly what the mobile RM app's S2 hub
   * (rm_verification_dashboard_screen.dart's `allDone`) already shows and
   * requires before its "Advance" button enables — but until now that was a
   * client-side-only check with no server-side gate backing it, so a stale
   * app build or a raw API call could skip S2_VERIFY straight through with
   * nothing actually verified. Mirrors the same checks inside
   * checkDeploymentEligibility above (which re-checks defensively at the final
   * S5_DEPLOY gate too, since a lot can happen between S2 and S5) — kept as a
   * separate function rather than shared so this gate never also blocks on
   * S5-only concerns (video-cert, signed agreement, practical driving test).
   */
  private async checkIdentityVerification(
    manager: { query: (sql: string, params?: any[]) => Promise<any[]> },
    staffId: string,
    seriesShort: string,
    pvStatus: string,
  ): Promise<{ eligible: boolean; blockers: string[]; flags: Record<string, any> }> {
    const blockers: string[] = [];
    const flags: Record<string, any> = {};

    const aadhaarRows = await manager.query(
      `SELECT status FROM verification_tracks WHERE staff_id = $1 AND track_type = 'AADHAAR_EKYC'`,
      [staffId],
    );
    const aadhaarStatus = aadhaarRows[0]?.status;
    flags.aadhaar_verified = aadhaarStatus === 'CLEAR';
    if (aadhaarStatus !== 'CLEAR') {
      blockers.push(`Aadhaar eKYC not verified — status=${aadhaarStatus ?? 'NOT_STARTED'}`);
    }

    if (seriesShort === 'MAID') {
      flags.pv_pending = pvStatus === 'NOT_INITIATED' || pvStatus === 'IN_PROGRESS';
      flags.pv_failed = pvStatus === 'ADVERSE';
      if (flags.pv_failed) blockers.push(`Police verification failed (Pillar 4) — pv_status=${pvStatus}`);
    } else {
      flags.pv_pending = pvStatus !== 'CLEAR';
      flags.pv_failed = pvStatus === 'ADVERSE';
      if (pvStatus !== 'CLEAR') {
        blockers.push(`Police verification not CLEAR (Pillar 4) — pv_status=${pvStatus}, ${seriesShort} requires CLEAR`);
      }
    }

    if (seriesShort === 'SC' || seriesShort === 'UC' || seriesShort === 'DR') {
      const medRows = await manager.query(
        `SELECT status FROM verification_tracks WHERE staff_id = $1 AND track_type = 'HEALTH_SCREENING'`,
        [staffId],
      );
      const medStatus = medRows[0]?.status;
      flags.medical_failed = medStatus === 'FAILED';
      if (medStatus !== 'CLEAR') {
        blockers.push(`Medical/sobriety not CLEAR (Pillar 3) — status=${medStatus ?? 'NOT_SUBMITTED'}`);
      }
    }

    if (seriesShort === 'DR') {
      const dlRows = await manager.query(
        `SELECT status FROM verification_tracks WHERE staff_id = $1 AND track_type = 'SARATHI_API'`,
        [staffId],
      );
      const dlStatus = dlRows[0]?.status;
      flags.dl_expired = dlStatus === 'EXPIRED';
      flags.dl_suspended = dlStatus === 'FAILED';
      if (dlStatus !== 'CLEAR') {
        blockers.push(`Driving licence not verified CLEAR (Pillar 1) — status=${dlStatus ?? 'NOT_CHECKED'}`);
      }

      const echallanRows = await manager.query(
        `SELECT status, result FROM verification_tracks WHERE staff_id = $1 AND track_type = 'ECHALLAN_API'`,
        [staffId],
      );
      if (!echallanRows.length) {
        blockers.push('eChallan not checked');
      } else {
        flags.challan_count = echallanRows[0].result?.count ?? null;
        if (echallanRows[0].status === 'FAILED') {
          blockers.push(`eChallan check shows severe violation count (>=3, DR-07) — count=${flags.challan_count}`);
        }
      }
    }

    return { eligible: blockers.length === 0, blockers, flags };
  }

  /**
   * Advance pipeline stage with full audit trail.
   *
   * Phase 3 adds business validation on top of the FSM's existing transition-
   * validity check: restricted-list re-check (first, before anything else,
   * per spec), deployment eligibility gates at S5_DEPLOY, connected scenario
   * routing with persistence, and a required terminal outcome when moving to
   * TERMINAL. Everything stays inside the same transaction as before — if any
   * gate fails, the whole thing rolls back: no stage change, no event, no
   * scenario persisted.
   */
  async advanceStage(input: StageTransitionInput): Promise<{ scenarioCode?: string }> {
    const { staffId, toStage, actorId, reasonCode, payload } = input;

    return this.dataSource.transaction(async (manager) => {
      const staff = await manager.query(
        `SELECT id, pipeline_stage, series, mobile, pv_status, restricted_list AS restricted_list_flag
         FROM staff_applicants WHERE id = $1 FOR UPDATE`,
        [staffId]
      );

      if (!staff.length) throw new BadRequestException(`Staff ${staffId} not found`);
      const current: PipelineStage = staff[0].pipeline_stage;
      const seriesShort = mapSeriesToShort(mapSeriesFromShort(String(staff[0].series)));

      // ── Restricted list — "always first, before any other action" ─────────
      // Re-checked here (not just at intake) so a match added retroactively by
      // BM still blocks further progression. TERMINAL is exempted — a
      // restricted applicant must still be movable to a formal exit, or
      // they'd be permanently stuck mid-pipeline.
      if (toStage !== PipelineStage.TERMINAL) {
        const phoneHash = crypto.createHash('sha256').update(staff[0].mobile).digest('hex');
        const restrictedRows = await manager.query(
          `SELECT reason FROM restricted_list WHERE phone_hash = $1 LIMIT 1`,
          [phoneHash],
        );
        if (restrictedRows.length || staff[0].restricted_list_flag) {
          throw new BadRequestException(
            `Blocked — this staff applicant is on the restricted list${restrictedRows[0]?.reason ? ` (${restrictedRows[0].reason})` : ''}. Only a move to TERMINAL is permitted.`,
          );
        }
      }

      const validNext = VALID_TRANSITIONS[current];
      if (!validNext.includes(toStage)) {
        throw new BadRequestException(
          `Invalid transition: ${current} → ${toStage}. Allowed: ${validNext.join(', ')}`
        );
      }

      // ── TERMINAL requires an explicit, validated outcome ────────────────────
      if (toStage === PipelineStage.TERMINAL) {
        if (!input.terminalOutcome || !VALID_TERMINAL_OUTCOMES.has(input.terminalOutcome)) {
          throw new BadRequestException(
            `terminalOutcome is required when moving to TERMINAL — one of: ${Array.from(VALID_TERMINAL_OUTCOMES).join(', ')}`,
          );
        }
      }

      // ── S2_VERIFY exit gate — Aadhaar/PV/medical/DL/eChallan must actually
      // be CLEAR, not just attempted. The mobile RM app's S2 hub already shows
      // this exact requirement to the RM (button disabled until all clear),
      // but that was client-side only — nothing server-side backed it, so a
      // stale app build or a raw API call could skip straight through S2 with
      // nothing verified. ────────────────────────────────────────────────────
      if (
        current === PipelineStage.S2_VERIFY &&
        (toStage === PipelineStage.S2_5_ASSESS || toStage === PipelineStage.S3_TRAIN)
      ) {
        const { eligible, blockers } = await this.checkIdentityVerification(
          manager, staffId, seriesShort, staff[0].pv_status,
        );
        if (!eligible) {
          throw new BadRequestException(
            `Verification incomplete — ${blockers.length} prerequisite(s) not met: ${blockers.join('; ')}`,
          );
        }
      }

      // ── S5_DEPLOY business/liability gates (Phase 3 critical fix) ──────────
      let scenarioCode: string | undefined;
      if (toStage === PipelineStage.S5_DEPLOY) {
        const { eligible, blockers, flags } = await this.checkDeploymentEligibility(
          manager, staffId, seriesShort, staff[0].pv_status,
        );
        flags.placed_confirmed = eligible;

        try {
          scenarioCode = this.routeScenario(seriesShort, flags);
        } catch {
          scenarioCode = undefined;
        }

        if (!eligible) {
          throw new BadRequestException(
            `Deployment blocked — ${blockers.length} prerequisite(s) not met: ${blockers.join('; ')}`,
          );
        }

        await manager.query(
          `UPDATE staff_applicants SET current_scenario = $1 WHERE id = $2`,
          [scenarioCode ?? null, staffId],
        );
        if (scenarioCode) {
          await manager.query(
            `INSERT INTO scenario_logs (id, staff_id, scenario_code, triggered_by, flags, actions_taken, escalated_to_bm, pipeline_stage)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, '[]', false, $5)`,
            [staffId, scenarioCode, actorId, JSON.stringify(flags), toStage],
          );
        }
      }

      // Update stage (+ terminal_outcome when applicable)
      if (toStage === PipelineStage.TERMINAL) {
        await manager.query(
          `UPDATE staff_applicants SET pipeline_stage = $1, terminal_outcome = $2, updated_at = NOW() WHERE id = $3`,
          [toStage, input.terminalOutcome, staffId]
        );
      } else {
        await manager.query(
          `UPDATE staff_applicants SET pipeline_stage = $1, updated_at = NOW() WHERE id = $2`,
          [toStage, staffId]
        );
      }

      // Append event (id must be supplied explicitly — Prisma @default(uuid()) is ORM-only, not a DB-level default)
      await manager.query(
        `INSERT INTO pipeline_events (id, staff_id, event_type, from_stage, to_stage, actor_id, scenario_code, reason_code, payload)
         VALUES (gen_random_uuid(), $1, 'STAGE_ADVANCE', $2, $3, $4, $5, $6, $7)`,
        [staffId, current, toStage, actorId, scenarioCode ?? null, reasonCode || null, JSON.stringify(payload || {})]
      );

      this.logger.log(`[FSM] ${staffId}: ${current} → ${toStage} by ${actorId}${scenarioCode ? ` (scenario ${scenarioCode})` : ''}`);
      return { scenarioCode };
    });
  }
}
