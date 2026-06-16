import { Injectable } from '@nestjs/common';
import { Series } from '../staff/staff.entity';
import { RoutingFlags } from '../pipeline/pipeline.service';

export interface ScenarioEffect {
  code: string;
  locksActions: string[];
  unlocksActions: string[];
  notifyRoles: string[];
  requiresBm: boolean;
  uiState: Record<string, unknown>;
  escalated: boolean;
}

const SCENARIO_EFFECTS: Record<string, Partial<ScenarioEffect>> = {
  'SC-01': { uiState: { banner: 'standard', risk: 'low' } },
  'SC-12': { requiresBm: true, locksActions: ['advance_stage'], notifyRoles: ['BM'], uiState: { banner: 'critical', risk: 'high' } },
  'UC-12': { requiresBm: true, locksActions: ['advance_stage'], notifyRoles: ['BM'] },
  'DR-12': { requiresBm: true, locksActions: ['advance_stage', 'deploy'], notifyRoles: ['BM', 'ADMIN'] },
  'DR-07': { unlocksActions: ['retrain'], uiState: { banner: 'warning' } },
};

@Injectable()
export class ScenarioEngine {
  route(series: Series, flags: RoutingFlags): string {
    switch (series) {
      case Series.DRIVER: return this.routeDriver(flags);
      case Series.SKILLED_CARE: return this.routeSkilledCare(flags);
      case Series.UNSKILLED_CARE: return this.routeUnskilledCare(flags);
      case Series.MAID: return this.routeMaid(flags);
      default: return 'SC-01';
    }
  }

  getEffect(code: string): ScenarioEffect {
    const base = SCENARIO_EFFECTS[code] ?? {};
    return {
      code,
      locksActions: base.locksActions ?? [],
      unlocksActions: base.unlocksActions ?? [],
      notifyRoles: base.notifyRoles ?? [],
      requiresBm: base.requiresBm ?? false,
      uiState: base.uiState ?? { banner: 'info' },
      escalated: base.requiresBm ?? false,
    };
  }

  private routeDriver(f: RoutingFlags): string {
    if (f.licenceFraud || f.identityFraud) return 'DR-12';
    if (f.duiConviction || f.hitAndRun) return 'DR-13';
    if (f.ruleRefusal && f.confirmed2x) return 'DR-15';
    if (f.epilepsy || f.colourBlind) return 'DR-14';
    if ((f.violations ?? 0) >= 4) return 'DR-14';
    if ((f.violations ?? 0) >= 1) return 'DR-07';
    if (f.licenceNearExpiry) return 'DR-09';
    if (f.medicalConcern) return 'DR-10';
    if (f.documentGap) return 'DR-11';
    if (f.vehicleTypeRestriction) return 'DR-05';
    if (f.firstSchoolRun) return 'DR-08';
    if (f.languageTier === 'T3' || f.languageTier === 'T4') return 'DR-02';
    if (f.noPriorProfessional) return 'DR-03';
    if (f.returning && f.cleanExit) return 'DR-04';
    return 'DR-01';
  }

  private routeSkilledCare(f: RoutingFlags): string {
    if (f.scopeViolation && f.confirmed2x) return 'SC-12';
    if (f.credentialFraud) return 'SC-10';
    if (f.adversePV && f.vulnerablePersonOffence) return 'SC-11';
    if (f.activeHealthCondition) return 'SC-07';
    if (f.skillsGap && f.trainable) return 'SC-08';
    if (f.credentialGap) return 'SC-09';
    if (f.careTypeRestriction) return 'SC-04';
    if (f.caregiverHealth) return 'SC-05';
    if (f.firstHighAcuity) return 'SC-06';
    if (f.returning) return 'SC-03';
    if (f.noPriorExperience) return 'SC-02';
    return 'SC-01';
  }

  private routeUnskilledCare(f: RoutingFlags): string {
    if (f.scopeBoundaryRefusal && f.confirmed2x) return 'UC-12';
    if (f.documentFraud) return 'UC-10';
    if (f.adversePV || f.temperamentDenial2D) return 'UC-11';
    if (f.temperamentConcern1D) return 'UC-08';
    if (f.firstNsOrBp) return 'UC-06';
    if (f.activeHealthCondition) return 'UC-07';
    if (f.documentGap) return 'UC-09';
    if (f.roleTypeRestriction) return 'UC-04';
    if (f.returning) return 'UC-03';
    if (f.noPriorExperience) return 'UC-02';
    return 'UC-01';
  }

  private routeMaid(f: RoutingFlags): string {
    if (f.documentFraud) return 'M3X-09';
    if (f.adversePV) return 'M3X-10';
    if (f.healthActive) return 'M3X-07';
    if (f.documentGap) return 'M3X-08';
    if (f.pendingPV) return 'M3X-05';
    if (f.returning) return 'M3X-03';
    if (f.noPriorExp) return 'M3X-02';
    return 'M3X-01';
  }
}
