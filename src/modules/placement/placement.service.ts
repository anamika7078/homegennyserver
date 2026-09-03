import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PlacementStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { computeWageBreakup, WageConfigInput } from './wage-calculator.util';

// Spec (HomeGenny_StageDescriptions, S5 Trial Period): Maid/UC/DR = 7-day
// trial, SC = 14-day trial. create() used to default every series to 14 days
// flat — a Maid or Driver placement's trial ran twice as long as it should
// unless the caller explicitly overrode trial_end_date every single time.
const TRIAL_DAYS_BY_SERIES: Record<string, number> = {
  MAID: 7,
  UNSKILLED_CARE: 7,
  DRIVER: 7,
  SKILLED_CARE: 14,
};
const DEFAULT_TRIAL_DAYS = 7;

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
  ) {}

  private mapRow(p: {
    id: string;
    staffId: string;
    clientId: string;
    status: PlacementStatus;
    staffSalary: unknown;
    managementFee: unknown;
    trialStartDate: Date | null;
    trialEndDate: Date | null;
    metadata?: unknown;
    createdAt: Date;
    updatedAt: Date;
  }, staff?: { staffCode: string; series: string; fullName?: string } | null, client?: { customerName: string } | null): PlacementRow {
    const metadata = (p.metadata as Record<string, unknown> | null) ?? {};
    return {
      id: p.id,
      staff_id: p.staffId,
      client_id: p.clientId,
      status: p.status,
      staff_salary: p.staffSalary != null ? Number(p.staffSalary) : null,
      management_fee: p.managementFee != null ? Number(p.managementFee) : null,
      trial_start_date: p.trialStartDate,
      trial_end_date: p.trialEndDate,
      wage_config: metadata.wage_config ?? null,
      wage_breakup: metadata.wage_breakup ?? null,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      staff_code: staff?.staffCode,
      series: staff?.series,
      staff_name: staff?.fullName,
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
      select: { series: true, pipelineStage: true },
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

    const branchId = String(data.branch_id ?? '00000000-0000-0000-0000-000000000001');

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
    const hourlyRate = data.hourly_rate != null ? Number(data.hourly_rate) : null;
    const hourlyFee = data.hourly_fee != null ? Number(data.hourly_fee) : null;
    const shiftHours = data.shift_hours != null ? Number(data.shift_hours) : 8;

    if (isHourly && !(hourlyRate != null && hourlyRate > 0)) {
      throw new BadRequestException(
        'hourly_rate is required for a TEMPORARY placement — an hour with no price cannot be billed.',
      );
    }

    const directConfirm = String(data.status ?? '').toUpperCase() === 'CONFIRMED';
    // An hourly placement prices itself by the hour, so the monthly pair is not
    // what makes it billable.
    if (directConfirm && !isHourly && (wageTerms.staffSalary == null || wageTerms.managementFee == null)) {
      throw new BadRequestException(
        'staff_salary and management_fee (directly, or computed via wage_config) are required to create a placement directly as CONFIRMED.',
      );
    }
    const status = directConfirm ? PlacementStatus.CONFIRMED : PlacementStatus.TRIAL;

    const trialDays = TRIAL_DAYS_BY_SERIES[staff.series] ?? DEFAULT_TRIAL_DAYS;

    const row = await this.prisma.placement.create({
      data: {
        staffId,
        clientId: String(data.client_id),
        branchId,
        rmId: data.rm_id ? String(data.rm_id) : undefined,
        status,
        placementType,
        shiftHours,
        staffSalary: wageTerms.staffSalary,
        managementFee: wageTerms.managementFee,
        hourlyRate: isHourly ? hourlyRate : null,
        hourlyFee: isHourly ? hourlyFee : null,
        metadata: wageTerms.metadataPatch as Prisma.InputJsonValue,
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

    this.events.emit('realtime.broadcast', {
      channel: 'deployments',
      event: directConfirm ? 'placement.confirmed' : 'placement.created',
      data: { placementId: row.id, staffId: row.staffId },
    });

    const [staffMeta, client] = await Promise.all([this.getStaffMeta(row.staffId), this.getClientMeta(row.clientId)]);
    return this.mapRow(row, staffMeta, client);
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
    data: { staff_salary?: unknown; management_fee?: unknown; wage_config?: unknown },
    actorId?: string,
  ) {
    const existing = await this.prisma.placement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Placement not found');

    const wageTerms = this.resolveWageTerms(data);
    const existingMetadata = (existing.metadata as Record<string, unknown> | null) ?? {};

    const row = await this.prisma.placement.update({
      where: { id },
      data: {
        ...(wageTerms.staffSalary != null ? { staffSalary: wageTerms.staffSalary } : {}),
        ...(wageTerms.managementFee != null ? { managementFee: wageTerms.managementFee } : {}),
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
      metadata: { action: 'terms_updated', staff_salary: wageTerms.staffSalary, management_fee: wageTerms.managementFee, via_wage_config: !!data.wage_config },
    });

    const [staff, client] = await Promise.all([this.getStaffMeta(row.staffId), this.getClientMeta(row.clientId)]);
    return this.mapRow(row, staff, client);
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
    if (existing.placementType === 'TEMPORARY') {
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
      data: { status: PlacementStatus.CONFIRMED },
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

  async findAll(params: { limit: number; offset: number; staffId?: string; clientId?: string }) {
    const where = {
      ...(params.staffId ? { staffId: params.staffId } : {}),
      ...(params.clientId ? { clientId: params.clientId } : {}),
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
