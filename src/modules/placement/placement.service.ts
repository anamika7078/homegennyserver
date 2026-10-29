import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PlacementStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { computeWageBreakup, WageConfigInput } from './wage-calculator.util';
import { StaffRequestsService } from '../staff-requests/staff-requests.service';
import { effectiveRateBasis } from '../../common/finance/duty-billing.util';
import { InvoiceCorrectionService } from '../finance/invoice/invoice-correction.service';
import {
  activeChanges, changedFields, currentRates, firstUnbilledDay, rateOn,
} from '../../common/finance/rate-history';
import { isoDate } from '../../common/finance/period.util';

// Spec (HomeGenny_StageDescriptions, S5 Trial Period): Maid/UC/DR = 7-day
// trial, SC = 14-day trial. create() used to default every series to 14 days
// flat — a Maid or Driver placement's trial ran twice as long as it should
// unless the caller explicitly overrode trial_end_date every single time.
const TRIAL_DAYS_BY_SERIES: Record<string, number> = {
  MAID: 7,
  UNSKILLED_CARE: 7,
  DRIVER: 7,
  SKILLED_CARE: 14,
  COOK: 7,
};
const DEFAULT_TRIAL_DAYS = 7;

const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
/**
 * The placement's weekly off: 0–6 (0 = Sunday) or a day name. The muster roll
 * marks that day WO instead of absent. '' or null = none fixed.
 */
function parseWeeklyOff(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toUpperCase();
  const byName = WEEKDAYS.findIndex((d) => d === s || d.slice(0, 3) === s);
  const n = /^\d$/.test(s) ? Number(s) : byName;
  if (!(n >= 0 && n <= 6)) {
    throw new BadRequestException('weekly_off_day must be 0–6 (0 = Sunday) or a day name, e.g. SUNDAY.');
  }
  return n;
}

/** HH:MM, 24 h (IST). Blank → undefined (not given). */
export function parseShiftStart(v: unknown): string | undefined {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new BadRequestException(`shift_start must be HH:MM (24 h), not "${s}".`);
  }
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

export interface PlacementList {
  items: PlacementRow[];
  total: number;
}

export interface PlacementRow {
  id: string;
  staff_id: string;
  client_id: string;
  status: string;
  staff_salary: string | number | null;
  management_fee: string | number | null;
  placement_type?: 'PERMANENT' | 'TEMPORARY';
  shift_hours?: number | null;
  /** HH:MM (IST) the shift starts; null = not known (never shown as late). */
  shift_start?: string | null;
  /** 0 = Sunday … 6 = Saturday; the muster roll marks it WO. Null = none fixed. */
  weekly_off_day?: number | null;
  hourly_rate?: number | null;
  hourly_fee?: number | null;
  /** MONTHLY | HOURLY | PER_DUTY — how this placement is priced. */
  rate_basis?: 'MONTHLY' | 'HOURLY' | 'PER_DUTY';
  duty_rate?: number | null;
  duty_billing_rate?: number | null;
  esic_applicable?: boolean;
  pf_applicable?: boolean;
  covers_placement_id?: string | null;
  /** Set after Finance rejects an invoice built on this placement; the client is not invoiced until cleared. */
  rate_review?: { status: 'REVIEW_NEEDED'; reason: string | null; at: Date | null; invoice_id: string | null } | null;
  trial_start_date: Date | string | null;
  trial_end_date: Date | string | null;
  staff_code?: string;
  series?: string;
  staff_name?: string;
  client_name?: string;
  [key: string]: unknown;
}

@Injectable()
export class PlacementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
    private readonly staffRequests: StaffRequestsService,
    private readonly correction: InvoiceCorrectionService,
  ) {}

  /** Prisma as a positional-parameter SQL runner, for the shared finance helpers. */
  private get sql() {
    return { query: (q: string, params: unknown[] = []) => this.prisma.$queryRawUnsafe(q, ...params) };
  }

  /**
   * Things worth a second look before money is billed on this placement —
   * not refusals, the RM decides:
   *  - no margin (the client pays exactly what the staff is paid);
   *  - a rate far from what comparable placements carry (an extra zero);
   *  - a placement that does not match the client's request (24×7 asked,
   *    monthly placed; different hours; permanent vs temporary).
   */
  async rateWarnings(placementId: string): Promise<string[]> {
    const p = await this.prisma.placement.findUnique({ where: { id: placementId } });
    if (!p) return [];
    const warnings: string[] = [];
    const basis = effectiveRateBasis(p.placementType, p.rateBasis);
    const num = (v: unknown) => (v == null ? null : Number(v));
    const inr = (v: number) => `₹${v.toLocaleString('en-IN')}`;

    if (basis === 'PER_DUTY' && num(p.dutyRate) != null && num(p.dutyRate) === num(p.dutyBillingRate)) {
      warnings.push('Client billing equals staff pay — nothing is left for ESIC/PF or the fee.');
    }
    if (basis === 'HOURLY' && !((num(p.hourlyFee) ?? 0) > 0)) {
      warnings.push('No hourly fee — HomeGenny earns nothing on these hours.');
    }
    if (basis === 'MONTHLY' && !((num(p.managementFee) ?? 0) > 0)) {
      warnings.push('No management fee — HomeGenny earns nothing on this placement.');
    }

    // Compared with other live placements priced the same way (needs a few to compare with).
    const field = basis === 'PER_DUTY' ? 'duty_rate' : basis === 'HOURLY' ? 'hourly_rate' : 'staff_salary';
    const value = basis === 'PER_DUTY' ? num(p.dutyRate) : basis === 'HOURLY' ? num(p.hourlyRate) : num(p.staffSalary);
    if (value && value > 0) {
      const [m] = await this.prisma.$queryRawUnsafe<{ n: number; median: number | null }[]>(
        `SELECT COUNT(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY ${field})::float AS median
           FROM placements
          WHERE id <> $1::uuid AND status IN ('TRIAL','CONFIRMED') AND placement_type = $2 AND ${field} > 0
            AND COALESCE(rate_basis, CASE WHEN placement_type = 'TEMPORARY' THEN 'HOURLY' ELSE 'MONTHLY' END) = $3`,
        p.id, p.placementType, basis,
      );
      if (m && m.n >= 5 && m.median) {
        const ratio = value / m.median;
        if (ratio >= 3 || ratio <= 1 / 3) {
          const unit = basis === 'PER_DUTY' ? '/duty' : basis === 'HOURLY' ? '/hour' : '/month';
          const how = ratio >= 1 ? `${Math.round(ratio)}× more than` : `${Math.round(1 / ratio)}× less than`;
          warnings.push(`${inr(value)}${unit} is ${how} the usual ${inr(Math.round(m.median))}${unit} — check for a typo.`);
        }
      }
    }

    const requestId = ((p.metadata as Record<string, unknown> | null) ?? {}).staff_request_id as string | undefined;
    if (requestId) {
      const req = await this.prisma.staffRequest.findUnique({ where: { id: requestId } });
      if (req) {
        const asked = Number(req.shiftHours ?? 0);
        const placedHours = Number(p.shiftHours ?? 0);
        if (asked >= 24 && basis !== 'PER_DUTY') {
          warnings.push(`The client asked for 24×7 live-in (${req.requestNo}), but this placement is ${basis.toLowerCase()}.`);
        } else if (asked > 0 && asked < 24 && placedHours >= 24) {
          warnings.push(`The client asked for ${asked} hours a day (${req.requestNo}), but this placement is a 24-hour duty.`);
        } else if (asked > 0 && placedHours > 0 && asked !== placedHours) {
          warnings.push(`The client asked for ${asked} hours a day (${req.requestNo}); this placement is ${placedHours}.`);
        }
        if (req.placementType && req.placementType !== p.placementType) {
          warnings.push(
            `The client asked for a ${req.placementType.toLowerCase()} placement (${req.requestNo}); ` +
              `this one is ${p.placementType.toLowerCase()}.`,
          );
        }
      }
    }
    return warnings;
  }

  /** Every rate change on the placement, and the day a new change would apply from by default. */
  async rateHistory(placementId: string) {
    const p = await this.prisma.placement.findUnique({ where: { id: placementId }, select: { id: true } });
    if (!p) throw new NotFoundException('Placement not found');
    const changes = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT c.id, c.effective_from::text AS effective_from, c.before, c.after, c.reason, c.source,
              c.changed_at, u.full_name AS changed_by_name, c.superseded_at
         FROM placement_rate_changes c LEFT JOIN users u ON u.id = c.changed_by
        WHERE c.placement_id = $1::uuid
        ORDER BY c.changed_at DESC`,
      placementId,
    );
    return { next_unbilled_day: await firstUnbilledDay(this.sql, placementId), changes };
  }

  private mapRow(p: {
    id: string;
    staffId: string;
    clientId: string;
    status: PlacementStatus;
    staffSalary: unknown;
    managementFee: unknown;
    placementType?: string | null;
    shiftHours?: unknown;
    shiftStart?: string | null;
    weeklyOffDay?: number | null;
    hourlyRate?: unknown;
    hourlyFee?: unknown;
    rateBasis?: string | null;
    dutyRate?: unknown;
    dutyBillingRate?: unknown;
    esicApplicable?: boolean | null;
    pfApplicable?: boolean | null;
    coversPlacementId?: string | null;
    rateReviewStatus?: string | null;
    rateReviewReason?: string | null;
    rateReviewAt?: Date | null;
    rateReviewInvoiceId?: string | null;
    trialStartDate: Date | null;
    trialEndDate: Date | null;
    metadata?: unknown;
    createdAt: Date;
    updatedAt: Date;
  }, staff?: { staffCode: string; series: string | null; fullName?: string | null } | null, client?: { customerName: string } | null): PlacementRow {
    const metadata = (p.metadata as Record<string, unknown> | null) ?? {};
    return {
      id: p.id,
      staff_id: p.staffId,
      client_id: p.clientId,
      status: p.status,
      staff_salary: p.staffSalary != null ? Number(p.staffSalary) : null,
      management_fee: p.managementFee != null ? Number(p.managementFee) : null,
      // Whether this placement is billed monthly or by the hour, and at what
      // rate. Callers marking attendance need it to know whether to ask for
      // hours; the placement list needs it to say what kind of placement it is.
      placement_type: (p.placementType as 'PERMANENT' | 'TEMPORARY' | null) ?? 'PERMANENT',
      shift_hours: p.shiftHours != null ? Number(p.shiftHours) : null,
      shift_start: p.shiftStart ?? null,
      weekly_off_day: p.weeklyOffDay ?? null,
      hourly_rate: p.hourlyRate != null ? Number(p.hourlyRate) : null,
      hourly_fee: p.hourlyFee != null ? Number(p.hourlyFee) : null,
      rate_basis: effectiveRateBasis(p.placementType, p.rateBasis),
      duty_rate: p.dutyRate != null ? Number(p.dutyRate) : null,
      duty_billing_rate: p.dutyBillingRate != null ? Number(p.dutyBillingRate) : null,
      esic_applicable: p.esicApplicable !== false,
      pf_applicable: p.pfApplicable !== false,
      covers_placement_id: p.coversPlacementId ?? null,
      rate_review: p.rateReviewStatus === 'REVIEW_NEEDED'
        ? {
            status: 'REVIEW_NEEDED',
            reason: p.rateReviewReason ?? null,
            at: p.rateReviewAt ?? null,
            invoice_id: p.rateReviewInvoiceId ?? null,
          }
        : null,
      trial_start_date: p.trialStartDate,
      trial_end_date: p.trialEndDate,
      wage_config: metadata.wage_config ?? null,
      wage_breakup: metadata.wage_breakup ?? null,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      staff_code: staff?.staffCode,
      series: staff?.series ?? undefined,
      staff_name: staff?.fullName ?? undefined,
      client_name: client?.customerName,
    };
  }

  private async getStaffMeta(staffId: string) {
    return this.prisma.staffApplicant.findUnique({
      where: { id: staffId },
      select: { staffCode: true, series: true, fullName: true },
    });
  }

  private async getClientMeta(clientId: string) {
    return this.prisma.financeCustomer.findUnique({
      where: { id: clientId },
      select: { customerName: true },
    });
  }

  /**
   * RM fills the full wage-breakup form at placement time (same fields/formula
   * as Finance's Commercial Calculator) rather than typing a flat salary/fee —
   * this derives staff_salary and management_fee from it, and keeps the raw
   * inputs + full computed breakdown (PF/ESIC/bonus/GST/CTC) in `metadata` for
   * audit — no schema change needed, `metadata` already existed and was unused.
   * Falls back to flat staff_salary/management_fee when wage_config is omitted
   * (existing callers, e.g. direct-CONFIRMED quick placements, keep working).
   */
  /**
   * Per-duty pricing, the ESIC/PF switches and the post a relief placement
   * covers — read from a create/terms body. Only fields present in the body
   * come back, so a terms update leaves the rest alone.
   *
   * A 24×7 live-in duty is priced per duty (rate_basis PER_DUTY, with
   * duty_rate and duty_billing_rate). See common/finance/duty-billing.util.ts.
   */
  private async resolveDutyTerms(
    data: Record<string, unknown>,
    ctx: { clientId: string; placementType: string; selfId?: string },
  ): Promise<{
    rateBasis?: string | null; dutyRate?: number | null; dutyBillingRate?: number | null;
    esicApplicable?: boolean; pfApplicable?: boolean; coversPlacementId?: string | null;
  }> {
    const out: Awaited<ReturnType<PlacementService['resolveDutyTerms']>> = {};
    const num = (v: unknown, field: string) => {
      if (v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new BadRequestException(`${field} must be a positive number.`);
      return Math.round(n * 100) / 100;
    };
    const bool = (v: unknown, field: string) => {
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      throw new BadRequestException(`${field} must be true or false.`);
    };

    if (data.rate_basis !== undefined) {
      const rb = data.rate_basis == null || data.rate_basis === '' ? null : String(data.rate_basis).toUpperCase();
      if (rb != null && !['MONTHLY', 'HOURLY', 'PER_DUTY'].includes(rb)) {
        throw new BadRequestException(`rate_basis must be MONTHLY, HOURLY or PER_DUTY, not "${rb}".`);
      }
      if (rb === 'HOURLY' && ctx.placementType !== 'TEMPORARY') {
        throw new BadRequestException('An hourly rate basis is only for a TEMPORARY placement.');
      }
      if (rb === 'MONTHLY' && ctx.placementType === 'TEMPORARY') {
        throw new BadRequestException('A monthly rate basis is only for a PERMANENT placement.');
      }
      out.rateBasis = rb;
    }
    if (data.duty_rate !== undefined) out.dutyRate = num(data.duty_rate, 'duty_rate');
    if (data.duty_billing_rate !== undefined) out.dutyBillingRate = num(data.duty_billing_rate, 'duty_billing_rate');
    if (data.esic_applicable !== undefined) out.esicApplicable = bool(data.esic_applicable, 'esic_applicable');
    if (data.pf_applicable !== undefined) out.pfApplicable = bool(data.pf_applicable, 'pf_applicable');

    if (data.covers_placement_id !== undefined) {
      const coverId = data.covers_placement_id ? String(data.covers_placement_id) : null;
      if (coverId) {
        if (coverId === ctx.selfId) throw new BadRequestException('A placement cannot cover itself.');
        const covered = await this.prisma.placement.findUnique({
          where: { id: coverId }, select: { clientId: true },
        });
        if (!covered) throw new BadRequestException(`covers_placement_id ${coverId} does not exist.`);
        if (covered.clientId !== ctx.clientId) {
          throw new BadRequestException('A relief placement can only cover a post at the same client.');
        }
      }
      out.coversPlacementId = coverId;
    }
    return out;
  }

  /** Throws unless a per-duty placement has both rates, and bills at least what it pays. */
  private assertDutyRates(dutyRate: unknown, dutyBillingRate: unknown) {
    const rate = dutyRate != null ? Number(dutyRate) : NaN;
    const bill = dutyBillingRate != null ? Number(dutyBillingRate) : NaN;
    if (!(rate > 0) || !(bill > 0)) {
      throw new BadRequestException(
        'A per-duty placement needs duty_rate (what the staff earns per duty) and ' +
          'duty_billing_rate (what the client is billed per duty).',
      );
    }
    if (bill < rate) {
      throw new BadRequestException(
        `duty_billing_rate ₹${bill} is below duty_rate ₹${rate} — the client would be billed less than the staff is paid.`,
      );
    }
  }

  private resolveWageTerms(data: Record<string, unknown>): {
    staffSalary?: number;
    managementFee?: number;
    metadataPatch: Record<string, unknown>;
  } {
    const wageConfig = data.wage_config;
    if (wageConfig && typeof wageConfig === 'object') {
      const breakup = computeWageBreakup(wageConfig as WageConfigInput);
      return {
        staffSalary: Math.round(breakup.netSalary * 100) / 100,
        managementFee: Math.round(breakup.managementFee * 100) / 100,
        metadataPatch: { wage_config: wageConfig, wage_breakup: breakup },
      };
    }
    return {
      staffSalary: data.staff_salary != null ? Number(data.staff_salary) : undefined,
      managementFee: data.management_fee != null ? Number(data.management_fee) : undefined,
      metadataPatch: {},
    };
  }

  /** Pure calculation, no persistence — for a live preview before submitting create()/updateTerms(). */
  calculateWage(wageConfig: WageConfigInput) {
    return computeWageBreakup(wageConfig);
  }

  async create(data: Record<string, unknown>, actorId?: string) {
    const staffId = String(data.staff_id);
    const staff = await this.prisma.staffApplicant.findUnique({
      where: { id: staffId },
      select: { series: true, pipelineStage: true, assignedRmId: true, branchId: true },
    });
    if (!staff) throw new NotFoundException(`Staff ${staffId} not found`);

    // Placement (trial or direct-confirm) is a deployment action — it only makes
    // sense once the candidate has actually cleared the pipeline to S5_DEPLOY.
    // Previously this endpoint had no stage check at all, so the mobile app's S4
    // hub screen used it to mint a throwaway TRIAL placement mid-agreements just
    // to get a placement_id for SOW/Indemnity — before deployment eligibility
    // (PV/video-cert/medical/agreement gates in PipelineFsmService) had even run.
    if (staff.pipelineStage !== 'S5_DEPLOY') {
      throw new BadRequestException(
        `Placement can only be created once the staff has reached S5_DEPLOY (current stage: ${staff.pipelineStage}).`,
      );
    }

    // A held stage let the staff move on with its work still pending; that
    // work has to be finished (the hold released) before they go to a client.
    // A COMPLETE override doesn't block — it says the work already happened,
    // it isn't deferred.
    const openHolds = await this.prisma.stageHold.findMany({
      where: { staffId, releasedAt: null, kind: 'HOLD' },
      select: { stage: true, reason: true },
    });
    if (openHolds.length) {
      throw new BadRequestException(
        `Placement blocked — release the open hold(s) first: ` +
          openHolds.map((h) => `${h.stage} (${h.reason})`).join(', '),
      );
    }

    // The bug this was written for was a *duplicate*: re-opening the "New
    // Placement" flow for someone already placed silently minted a second
    // active row for the same staff and client (seen in prod). It was written
    // as "one active placement, full stop", which also blocks the thing the
    // business actually does — a maid works several houses in a day, and a
    // client may book her permanently while another books her by the hour.
    //
    // So the guard narrows to what it was guarding: the same client twice.
    // See docs/HOURLY_MULTI_CLIENT_PLAN.md §B1.
    const clientId = String(data.client_id ?? '');

    // Filling a client's staff request: checked before anything is written, and
    // the request's terms are the defaults for what the caller left out.
    const staffRequestId = data.staff_request_id ? String(data.staff_request_id) : null;
    let visitMeta: Record<string, unknown> = {};
    if (staffRequestId) {
      const sr = await this.staffRequests.assertPlacementFits(staffRequestId, staffId, clientId);
      const visitDate = sr.startDate ? sr.startDate.toISOString().slice(0, 10) : undefined;
      data = {
        placement_type: sr.placementType,
        shift_hours: Number(sr.shiftHours),
        // The booking's start time is when the shift starts — what "late" is measured from.
        ...(sr.startTime ? { shift_start: sr.startTime } : {}),
        // A one-time visit is that one day.
        ...(sr.visitType === 'ONE_TIME' && visitDate ? { trial_start_date: visitDate, trial_end_date: visitDate } : {}),
        ...data,
      };
      if (sr.visitType === 'ONE_TIME') visitMeta = { visit_type: 'ONE_TIME', visit_date: visitDate, duration_min: sr.durationMin };
    }

    const duplicate = await this.prisma.placement.findFirst({
      where: {
        staffId,
        clientId,
        status: { in: [PlacementStatus.TRIAL, PlacementStatus.CONFIRMED] },
      },
      select: { id: true, status: true },
    });
    if (duplicate) {
      throw new BadRequestException(
        `This staff member is already placed with this client (${duplicate.status}, ` +
          `id: ${duplicate.id}). Exit that placement before creating another for the ` +
          `same client.`,
      );
    }

    // The placement belongs to the staff's branch and RM unless the caller says
    // otherwise. Neither UI sends them, so every placement used to land on the
    // main branch with no RM — and an RM's trial list, scoped by rm_id, was empty.
    const branchId = String(data.branch_id ?? staff.branchId ?? '00000000-0000-0000-0000-000000000001');
    const rmId = data.rm_id ? String(data.rm_id) : (staff.assignedRmId ?? actorId);

    // Deploy-time choice: start a TRIAL (default) or go straight to CONFIRMED —
    // e.g. a repeat/trusted client the RM doesn't need a trial period for.
    // CONFIRMED normally requires salary+fee to already be set (see confirm()
    // below) — enforced here too since there's no separate confirm step to catch it.
    const wageTerms = this.resolveWageTerms(data);

    // PERMANENT takes the client's whole shift and is billed monthly.
    // TEMPORARY is booked by the hour — the same maid can hold one of each,
    // with a different rate at each house. See §S2.
    const placementType = String(data.placement_type ?? 'PERMANENT').toUpperCase();
    if (!['PERMANENT', 'TEMPORARY'].includes(placementType)) {
      throw new BadRequestException(
        `placement_type must be PERMANENT or TEMPORARY, not "${placementType}".`,
      );
    }
    const isHourly = placementType === 'TEMPORARY';

    // A permanent placement is the staff's only placement. While one is active
    // (on trial or confirmed) they can't be placed anywhere else, hourly or
    // permanent; and a permanent one can't start while they hold any other.
    // Several hourly placements at once is still the multi-client model
    // (docs/HOURLY_MULTI_CLIENT_PLAN.md). The business decided this on 2026-09-21.
    const active = await this.prisma.placement.findMany({
      where: { staffId, status: { in: [PlacementStatus.TRIAL, PlacementStatus.CONFIRMED] } },
      select: { id: true, status: true, clientId: true, placementType: true },
    });
    const blocking = active.find((p) => p.placementType === 'PERMANENT') ?? (isHourly ? undefined : active[0]);
    if (blocking) {
      const client = await this.getClientMeta(blocking.clientId);
      const where = client?.customerName ?? 'another client';
      throw new BadRequestException(
        blocking.placementType === 'PERMANENT'
          ? `This staff member is permanently placed with ${where} (${blocking.status}, id: ${blocking.id}). ` +
              'A permanent placement is their only one — exit it before placing them anywhere else.'
          : `A permanent placement must be the staff's only one, and they are placed hourly with ${where} ` +
              `(${blocking.status}, id: ${blocking.id}). Exit their hourly placements first.`,
      );
    }
    const hourlyRate = data.hourly_rate != null ? Number(data.hourly_rate) : null;
    const hourlyFee = data.hourly_fee != null ? Number(data.hourly_fee) : null;
    const shiftHours = data.shift_hours != null ? Number(data.shift_hours) : 8;
    // 24 is a live-in (24×7) duty.
    if (!(shiftHours > 0 && shiftHours <= 24)) {
      throw new BadRequestException(`shift_hours must be between 1 and 24, not ${data.shift_hours}.`);
    }
    const shiftStart = parseShiftStart(data.shift_start);
    const weeklyOffDay = parseWeeklyOff(data.weekly_off_day);

    const dutyTerms = await this.resolveDutyTerms(data, { clientId, placementType });
    const isPerDuty = dutyTerms.rateBasis === 'PER_DUTY';
    if (isPerDuty) this.assertDutyRates(dutyTerms.dutyRate, dutyTerms.dutyBillingRate);

    if (isHourly && !isPerDuty && !(hourlyRate != null && hourlyRate > 0)) {
      throw new BadRequestException(
        'hourly_rate is required for a TEMPORARY placement — an hour with no price cannot be billed.',
      );
    }

    const directConfirm = String(data.status ?? '').toUpperCase() === 'CONFIRMED';
    // An hourly or per-duty placement prices itself by its own rate, so the
    // monthly pair is not what makes it billable.
    if (directConfirm && !isHourly && !isPerDuty && (wageTerms.staffSalary == null || wageTerms.managementFee == null)) {
      throw new BadRequestException(
        'staff_salary and management_fee (directly, or computed via wage_config) are required to create a placement directly as CONFIRMED.',
      );
    }
    const status = directConfirm ? PlacementStatus.CONFIRMED : PlacementStatus.TRIAL;

    const trialDays = (staff.series && TRIAL_DAYS_BY_SERIES[staff.series]) || DEFAULT_TRIAL_DAYS;

    const row = await this.prisma.placement.create({
      data: {
        staffId,
        clientId: String(data.client_id),
        branchId,
        rmId,
        status,
        confirmedAt: directConfirm ? new Date() : undefined,
        placementType,
        shiftHours,
        shiftStart: shiftStart ?? null,
        weeklyOffDay: weeklyOffDay ?? null,
        staffSalary: wageTerms.staffSalary,
        managementFee: wageTerms.managementFee,
        hourlyRate: isHourly && !isPerDuty ? hourlyRate : null,
        hourlyFee: isHourly && !isPerDuty ? hourlyFee : null,
        ...dutyTerms,
        metadata: (staffRequestId
          ? { ...(wageTerms.metadataPatch as object), staff_request_id: staffRequestId, ...visitMeta }
          : wageTerms.metadataPatch) as Prisma.InputJsonValue,
        trialStartDate: data.trial_start_date ? new Date(String(data.trial_start_date)) : new Date(),
        trialEndDate: data.trial_end_date
          ? new Date(String(data.trial_end_date))
          : new Date(Date.now() + trialDays * 86400000),
      },
    });

    await this.prisma.deployment.create({
      data: {
        staffId: row.staffId,
        clientId: row.clientId,
        placementId: row.id,
        status,
        trialStartDate: row.trialStartDate,
        trialEndDate: row.trialEndDate,
      },
    }).catch(() => undefined);

    await this.audit.log({
      actorId,
      action: AuditAction.DEPLOYMENT_ACTION,
      entityType: 'placement',
      entityId: row.id,
      metadata: { action: directConfirm ? 'placement_confirmed_direct' : 'trial_started' },
    });

    if (staffRequestId) {
      await this.staffRequests.recordPlacement(staffRequestId, row.staffId, row.id, actorId);
    }

    this.events.emit('realtime.broadcast', {
      channel: 'deployments',
      event: directConfirm ? 'placement.confirmed' : 'placement.created',
      data: { placementId: row.id, staffId: row.staffId },
    });

    const [staffMeta, client] = await Promise.all([this.getStaffMeta(row.staffId), this.getClientMeta(row.clientId)]);
    return { ...this.mapRow(row, staffMeta, client), warnings: await this.rateWarnings(row.id) };
  }

  /**
   * Sets/updates staff_salary and management_fee on an existing placement —
   * there was no way to do this at all before (create() is the only place
   * that ever wrote them, and only if the caller happened to pass them).
   * Needed as an escape hatch now that confirm() requires both to be set:
   * a placement created without them (API called directly, bypassing the
   * RM UI's create form) would otherwise be permanently stuck at TRIAL.
   */
  async updateTerms(
    id: string,
    data: {
      staff_salary?: unknown; management_fee?: unknown; wage_config?: unknown; shift_start?: unknown;
      shift_hours?: unknown; rate_basis?: unknown; duty_rate?: unknown; duty_billing_rate?: unknown;
      esic_applicable?: unknown; pf_applicable?: unknown; covers_placement_id?: unknown;
      hourly_rate?: unknown; hourly_fee?: unknown; effective_from?: unknown; reason?: unknown;
    },
    actorId?: string,
  ) {
    const existing = await this.prisma.placement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Placement not found');

    // Hourly price, editable now (it could only be set at creation).
    let hourlyRate: number | undefined;
    let hourlyFee: number | undefined;
    if (data.hourly_rate !== undefined && data.hourly_rate !== null && data.hourly_rate !== '') {
      hourlyRate = Number(data.hourly_rate);
      if (!(hourlyRate > 0)) throw new BadRequestException('hourly_rate must be more than 0.');
    }
    if (data.hourly_fee !== undefined && data.hourly_fee !== null && data.hourly_fee !== '') {
      hourlyFee = Number(data.hourly_fee);
      if (!(hourlyFee >= 0)) throw new BadRequestException('hourly_fee cannot be negative.');
    }

    // A change to what is paid or billed is a dated change: it applies from
    // effective_from (default: the first day no payroll covers yet). Reaching
    // back over payroll already run re-runs it — refused if that payroll is
    // already past Finance. Checked before anything is written.
    const rateKeys = ['staff_salary', 'management_fee', 'wage_config', 'rate_basis', 'duty_rate', 'duty_billing_rate',
      'hourly_rate', 'hourly_fee', 'esic_applicable', 'pf_applicable'];
    const touchesRates = rateKeys.some((k) => (data as Record<string, unknown>)[k] !== undefined);
    let effectiveFrom: string | null = null;
    let impact: Awaited<ReturnType<InvoiceCorrectionService['rateChangeImpact']>> = Object.assign([], { invoicesToCorrect: [] as string[] });
    const rateBefore = touchesRates ? await currentRates(this.sql, id) : null;
    if (touchesRates) {
      if (data.effective_from !== undefined && data.effective_from !== null && data.effective_from !== '') {
        const d = String(data.effective_from);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(`${d}T00:00:00Z`))) {
          throw new BadRequestException('effective_from must be a date (YYYY-MM-DD).');
        }
        effectiveFrom = d;
      } else {
        effectiveFrom = await firstUnbilledDay(this.sql, id);
      }
      impact = await this.correction.rateChangeImpact(id, effectiveFrom);
    }

    const wageTerms = this.resolveWageTerms(data);
    const dutyTerms = await this.resolveDutyTerms(data as Record<string, unknown>, {
      clientId: existing.clientId, placementType: existing.placementType, selfId: existing.id,
    });
    // Validate the rates the placement will end up with, not just the ones sent.
    const finalBasis = dutyTerms.rateBasis !== undefined ? dutyTerms.rateBasis : existing.rateBasis;
    if (finalBasis === 'PER_DUTY') {
      this.assertDutyRates(
        dutyTerms.dutyRate !== undefined ? dutyTerms.dutyRate : existing.dutyRate,
        dutyTerms.dutyBillingRate !== undefined ? dutyTerms.dutyBillingRate : existing.dutyBillingRate,
      );
    } else if (dutyTerms.rateBasis !== undefined) {
      // Moving off per-duty: the basis being moved to has to have its own price,
      // or payroll has nothing to run on (and a temporary placement without an
      // hourly rate is refused by the database outright).
      if (existing.placementType === 'TEMPORARY' && existing.hourlyRate == null) {
        throw new BadRequestException(
          'This relief placement has no hourly rate to fall back to — keep it per duty, or exit it and place them hourly.',
        );
      }
      if (existing.placementType !== 'TEMPORARY'
          && (wageTerms.staffSalary ?? existing.staffSalary) == null) {
        throw new BadRequestException(
          'Switching to a monthly salary needs staff_salary and management_fee (or a wage_config) in the same request.',
        );
      }
    }
    let shiftHours: number | undefined;
    if (data.shift_hours !== undefined && data.shift_hours !== null && data.shift_hours !== '') {
      shiftHours = Number(data.shift_hours);
      if (!(shiftHours > 0 && shiftHours <= 24)) {
        throw new BadRequestException(`shift_hours must be between 1 and 24, not ${String(data.shift_hours)}.`);
      }
    }
    // '' or null clears it (no start time → never late); absent leaves it alone.
    const shiftStart = data.shift_start === undefined ? undefined : parseShiftStart(data.shift_start) ?? null;
    // '' or null clears it; absent leaves it alone.
    const weeklyOffDay = (data as Record<string, unknown>).weekly_off_day === undefined
      ? undefined
      : parseWeeklyOff((data as Record<string, unknown>).weekly_off_day) ?? null;
    const existingMetadata = (existing.metadata as Record<string, unknown> | null) ?? {};
    // A rate sent after Finance rejected an invoice is the RM's answer to the
    // review: the client can be invoiced again (at the new rate).
    const ratesSent = ['staff_salary', 'management_fee', 'wage_config', 'rate_basis', 'duty_rate', 'duty_billing_rate']
      .some((k) => (data as Record<string, unknown>)[k] !== undefined);
    const clearsReview = ratesSent && existing.rateReviewStatus === 'REVIEW_NEEDED';

    const row = await this.prisma.placement.update({
      where: { id },
      data: {
        ...(clearsReview
          ? { rateReviewStatus: null, rateReviewReason: null, rateReviewAt: null, rateReviewInvoiceId: null, rateReviewBy: null }
          : {}),
        ...(hourlyRate !== undefined ? { hourlyRate } : {}),
        ...(hourlyFee !== undefined ? { hourlyFee } : {}),
        ...(wageTerms.staffSalary != null ? { staffSalary: wageTerms.staffSalary } : {}),
        ...(wageTerms.managementFee != null ? { managementFee: wageTerms.managementFee } : {}),
        ...(shiftStart !== undefined ? { shiftStart } : {}),
        ...(weeklyOffDay !== undefined ? { weeklyOffDay } : {}),
        ...(shiftHours !== undefined ? { shiftHours } : {}),
        ...dutyTerms,
        ...(Object.keys(wageTerms.metadataPatch).length
          ? { metadata: { ...existingMetadata, ...wageTerms.metadataPatch } as Prisma.InputJsonValue }
          : {}),
      },
    });

    await this.audit.log({
      actorId,
      action: AuditAction.DEPLOYMENT_ACTION,
      entityType: 'placement',
      entityId: row.id,
      metadata: {
        action: 'terms_updated', staff_salary: wageTerms.staffSalary, management_fee: wageTerms.managementFee,
        ...(clearsReview ? { rate_review_cleared: true, rejected_for: existing.rateReviewReason } : {}),
        before: {
          staff_salary: existing.staffSalary != null ? Number(existing.staffSalary) : null,
          management_fee: existing.managementFee != null ? Number(existing.managementFee) : null,
          duty_rate: existing.dutyRate != null ? Number(existing.dutyRate) : null,
          duty_billing_rate: existing.dutyBillingRate != null ? Number(existing.dutyBillingRate) : null,
          rate_basis: existing.rateBasis,
        },
        via_wage_config: !!data.wage_config,
        ...(shiftStart !== undefined ? { shift_start: shiftStart } : {}),
        ...(weeklyOffDay !== undefined ? { weekly_off_day: weeklyOffDay } : {}),
        ...(shiftHours !== undefined ? { shift_hours: shiftHours } : {}),
        ...dutyTerms,
      },
    });
    if (clearsReview) await this.tellFinanceRateAnswered(existing, 'corrected the rate');

    // Record the change on the timeline, and re-run what it reaches back over.
    let rateChange: {
      effective_from: string; fields: string[]; rebuilt: { invoice_number: string | null; period: string; error?: string }[];
      /** Sent invoices covering days the change reaches: Finance corrects them (credit note / supplementary / arrears). */
      invoices_to_correct: string[];
    } | null = null;
    if (touchesRates && rateBefore && effectiveFrom) {
      const rateAfter = await currentRates(this.sql, id);
      const fields = rateAfter ? changedFields(rateBefore, rateAfter) : [];
      if (rateAfter && fields.length) {
        // "Before" is what applied on the day before the change — the original
        // rate when there is no history yet.
        const timeline = await activeChanges(this.sql, id);
        const dayBefore = isoDate(new Date(Date.parse(`${effectiveFrom}T00:00:00Z`) - 86_400_000))!;
        const before = rateOn(timeline, dayBefore) ?? rateBefore;
        const reason = data.reason ? String(data.reason).trim() || null : null;
        const from = effectiveFrom;
        await this.prisma.$transaction(async (tx) => {
          const [created] = await tx.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO placement_rate_changes (placement_id, effective_from, before, after, reason, source, changed_by)
             VALUES ($1::uuid, $2::date, $3::jsonb, $4::jsonb, $5, $6, $7::uuid) RETURNING id`,
            id, from, JSON.stringify(before), JSON.stringify(rateAfter), reason,
            clearsReview ? 'REVIEW_FIX' : 'TERMS_EDIT', actorId ?? null,
          );
          // A later edit reaching back supersedes the changes it overlaps, so
          // the active rows stay one timeline.
          await tx.$executeRawUnsafe(
            `UPDATE placement_rate_changes SET superseded_at = NOW(), superseded_by = $3::uuid
              WHERE placement_id = $1::uuid AND superseded_at IS NULL AND effective_from >= $2::date AND id <> $3::uuid`,
            id, from, created.id,
          );
          // rate_verified_at is left as it is: it says when Finance last
          // approved an invoice on this placement, and every change made after
          // it is what the next invoice shows Finance as new.
        });
        const rebuilt = await this.correction.reapplyAfterRateChange(
          id, impact, `rate change from ${from}${reason ? `: ${reason}` : ''}`, actorId,
        );
        rateChange = { effective_from: from, fields, rebuilt, invoices_to_correct: impact.invoicesToCorrect };
      }
    }

    const [staff, client] = await Promise.all([this.getStaffMeta(row.staffId), this.getClientMeta(row.clientId)]);
    const fresh = await this.prisma.placement.findUnique({ where: { id } });
    return {
      ...this.mapRow(fresh ?? row, staff, client),
      rate_change: rateChange,
      warnings: await this.rateWarnings(id),
    };
  }

  /**
   * The RM's answer to a rejected invoice when the rate was right after all
   * (the rejection was about something else, or the figure was checked and
   * stands). Clears the review so the client can be invoiced again, and keeps
   * the RM's note on the audit trail.
   */
  async confirmRateReview(id: string, note: unknown, actorId?: string) {
    const existing = await this.prisma.placement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Placement not found');
    if (existing.rateReviewStatus !== 'REVIEW_NEEDED') {
      throw new BadRequestException('This placement is not waiting for a rate review.');
    }
    const text = String(note ?? '').trim();
    if (text.length < 10) {
      throw new BadRequestException('Say why the rate stands (at least 10 characters) — Finance rejected the last invoice.');
    }
    const row = await this.prisma.placement.update({
      where: { id },
      data: { rateReviewStatus: null, rateReviewReason: null, rateReviewAt: null, rateReviewInvoiceId: null, rateReviewBy: null },
    });
    await this.audit.log({
      actorId,
      action: AuditAction.DEPLOYMENT_ACTION,
      entityType: 'placement',
      entityId: id,
      metadata: {
        action: 'rate_review_confirmed', note: text, rejected_for: existing.rateReviewReason,
        invoice_id: existing.rateReviewInvoiceId,
      },
    });
    await this.tellFinanceRateAnswered(existing, `confirmed the rate stands: "${text}"`);
    const [staff, client] = await Promise.all([this.getStaffMeta(row.staffId), this.getClientMeta(row.clientId)]);
    return this.mapRow(row, staff, client);
  }

  /**
   * The RM has answered a rejection — corrected the rate or confirmed it. The
   * Finance user who rejected the invoice is told, and once no placement of
   * that client is still under review, that the invoice can be raised again
   * (it shows under "Ready to re-invoice").
   */
  private async tellFinanceRateAnswered(
    placement: { id: string; clientId: string; staffId: string; rateReviewInvoiceId: string | null },
    what: string,
  ) {
    if (!placement.rateReviewInvoiceId) return;
    const [inv] = await this.prisma.$queryRawUnsafe<{ invoice_number: string; rejected_by: string | null; customer_name: string | null }[]>(
      `SELECT ci.invoice_number, ci.rejected_by, fc.customer_name
         FROM client_invoices ci LEFT JOIN finance_customers fc ON fc.id = ci.client_id
        WHERE ci.id = $1::uuid`,
      placement.rateReviewInvoiceId,
    );
    if (!inv?.rejected_by) return;
    const [staff, open] = await Promise.all([
      this.prisma.staffApplicant.findUnique({ where: { id: placement.staffId }, select: { fullName: true } }),
      this.prisma.placement.count({ where: { clientId: placement.clientId, rateReviewStatus: 'REVIEW_NEEDED' } }),
    ]);
    await this.prisma.notification.create({
      data: {
        userId: inv.rejected_by,
        title: open ? 'RM answered a rejected invoice' : 'Ready to re-invoice',
        body:
          `The RM ${what} for ${staff?.fullName ?? 'a staff member'} (invoice ${inv.invoice_number}, ` +
          `${inv.customer_name ?? 'client'}). ` +
          (open
            ? `${open} more placement(s) of this client are still waiting for the RM.`
            : `Nothing is waiting any more — raise the invoice again from Finance → Invoices → Ready to re-invoice.`),
        channel: 'IN_APP',
        status: 'SENT',
        sentAt: new Date(),
      },
    }).catch(() => undefined);
  }

  /**
   * TRIAL → CONFIRMED. Previously there was no endpoint at all for this — placements
   * were created as TRIAL by create() above and nothing ever moved them to CONFIRMED,
   * which is the status staff check-in / RM attendance / invoicing all require. Demo
   * data only worked because it was seeded directly as CONFIRMED, bypassing the API.
   */
  async confirm(id: string, actorId?: string) {
    const existing = await this.prisma.placement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Placement not found');
    if (existing.status !== PlacementStatus.TRIAL) {
      throw new BadRequestException(`Only a TRIAL placement can be confirmed (current status: ${existing.status})`);
    }
    // Neither create() nor confirm() used to require these — a placement could
    // reach CONFIRMED with both NULL, and PayrollService's parseFloat(null) =
    // NaN silently persisted into payroll_records/client_invoices as the
    // literal string 'NaN' (Postgres NUMERIC accepts it) instead of failing.
    // Confirmed live: 3 CONFIRMED placements in prod/local had this. Gating
    // here — not create() — matches how RM actually works: salary/fee are
    // real commercial terms that should be locked in before confirming a
    // trial, not necessarily known on day one of the trial.
    // What makes a placement billable depends on how it is priced: a monthly
    // pair for a permanent one, an hourly rate for a temporary one. Demanding
    // the monthly figures from an hourly placement would leave it permanently
    // stuck at TRIAL.
    if (existing.rateBasis === 'PER_DUTY') {
      this.assertDutyRates(existing.dutyRate, existing.dutyBillingRate);
    } else if (existing.placementType === 'TEMPORARY') {
      if (existing.hourlyRate == null) {
        throw new BadRequestException(
          'Cannot confirm — this is an hourly placement and has no hourly_rate. ' +
            'Set the rate before confirming.',
        );
      }
    } else if (existing.staffSalary == null || existing.managementFee == null) {
      throw new BadRequestException(
        'Cannot confirm — staff_salary and management_fee must be set first. ' +
        'Update the placement with these values before confirming.',
      );
    }

    // A2 (SOW) and A3 (Indemnity) are placement-scoped and can only be created
    // once this placement exists — so unlike the old S4-gate (which required
    // them before advancing the pipeline stage), they're gated here instead,
    // on the TRIAL→CONFIRMED transition. Deliberately NOT checked when create()
    // sets status:'CONFIRMED' directly (deploy-time "confirm now") — at that
    // instant the placement doesn't exist yet either, so neither could possibly
    // exist; that fast path is a trusted RM judgment call, not a hole to close.
    const [sowSent, indemnitySent] = await Promise.all([
      this.prisma.scopeOfWork.count({ where: { placementId: id, status: { not: 'DRAFT' } } }),
      this.prisma.clientIndemnity.count({ where: { placementId: id } }),
    ]);
    if (sowSent === 0 || indemnitySent === 0) {
      const missing = [sowSent === 0 && 'A2 (Scope of Work) sent', indemnitySent === 0 && 'A3 (Client Indemnity) sent']
        .filter(Boolean)
        .join(' and ');
      throw new BadRequestException(`Cannot confirm — ${missing} required first.`);
    }

    const row = await this.prisma.placement.update({
      where: { id },
      // confirmed_at dates the late-exit fee band (exit-settlement.service.ts);
      // nothing wrote it before, so every exit after a confirm priced as undated.
      data: { status: PlacementStatus.CONFIRMED, confirmedAt: new Date() },
    });

    await this.prisma.deployment.updateMany({
      where: { placementId: id },
      data: { status: PlacementStatus.CONFIRMED },
    }).catch(() => undefined);

    await this.audit.log({
      actorId,
      action: AuditAction.DEPLOYMENT_ACTION,
      entityType: 'placement',
      entityId: row.id,
      metadata: { action: 'trial_confirmed' },
    });

    this.events.emit('realtime.broadcast', {
      channel: 'deployments',
      event: 'placement.confirmed',
      data: { placementId: row.id, staffId: row.staffId },
    });

    const [staff, client] = await Promise.all([this.getStaffMeta(row.staffId), this.getClientMeta(row.clientId)]);
    return this.mapRow(row, staff, client);
  }

  async findAll(params: {
    limit: number;
    offset: number;
    staffId?: string;
    clientId?: string;
    status?: PlacementStatus;
    /** An RM sees their own placements, a BM their branch's; unset for admin. */
    scope?: { rmId?: string; branchId?: string };
  }) {
    const where: Prisma.PlacementWhereInput = {
      ...(params.staffId ? { staffId: params.staffId } : {}),
      ...(params.clientId ? { clientId: params.clientId } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.scope?.rmId ? { rmId: params.scope.rmId } : {}),
      ...(params.scope?.branchId ? { branchId: params.scope.branchId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.placement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: params.limit,
        skip: params.offset,
        include: {
          branch: false,
        },
      }),
      this.prisma.placement.count({ where }),
    ]);

    const staffIds = [...new Set(rows.map((r) => r.staffId))];
    const clientIds = [...new Set(rows.map((r) => r.clientId))];
    const [staffRows, clientRows] = await Promise.all([
      this.prisma.staffApplicant.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, staffCode: true, series: true, fullName: true },
      }),
      this.prisma.financeCustomer.findMany({
        where: { id: { in: clientIds } },
        select: { id: true, customerName: true },
      }),
    ]);
    const staffMap = new Map(staffRows.map((s) => [s.id, s]));
    const clientMap = new Map(clientRows.map((c) => [c.id, c]));

    return {
      items: rows.map((r) => this.mapRow(r, staffMap.get(r.staffId) ?? null, clientMap.get(r.clientId) ?? null)),
      total,
    };
  }

  async exit(
    id: string,
    data: { exit_date: string; exit_scenario_code: string },
    actorId?: string,
  ) {
    await this.prisma.$executeRaw`
      UPDATE placements SET status = 'EXITED', exit_date = ${data.exit_date}::date,
        exit_scenario_code = ${data.exit_scenario_code}, updated_at = NOW()
      WHERE id = ${id}::uuid
    `.catch(async () => {
      await this.prisma.placement.update({
        where: { id },
        data: { status: PlacementStatus.EXITED },
      });
    });
    await this.audit.log({
      actorId,
      action: AuditAction.DEPLOYMENT_ACTION,
      entityType: 'placement',
      entityId: id,
      metadata: data,
    });
    return { success: true };
  }
}
