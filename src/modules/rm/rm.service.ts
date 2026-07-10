import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, PipelineStage, UserRole, StaffAttendanceStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PipelineFsmService, PipelineStage as FsmStage } from '../pipeline/pipeline-fsm.service';
import { AuthUser, resolveStaffScope, assertStaffAccess } from '../../common/guards/branch-scope.util';
import { toStaffDto, parseCreateStaffBody } from '../../common/mappers/staff.mapper';
import { StaffService } from '../staff/staff.service';
import { PayrollService } from '../payroll/payroll.service';
import {
  BRANCH_AREA_CONFIG,
  DELHI_BRANCH_ID,
  PUNE_BRANCH_ID,
  MUMBAI_BRANCH_ID,
} from './branch-areas.config';
import * as crypto from 'crypto';

const KANBAN_STAGES: PipelineStage[] = [
  'S1_INTAKE',
  'S2_VERIFY',
  'S2_5_ASSESS',
  'S3_TRAIN',
  'S4_AGREEMENTS',
  'S5_DEPLOY',
  'DEFERRED',
  'TERMINAL',
];

@Injectable()
export class RmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fsm: PipelineFsmService,
    private readonly staffService: StaffService,
    private readonly events: EventEmitter2,
    private readonly payroll: PayrollService,
  ) {}

  private staffWhere(scope: ReturnType<typeof resolveStaffScope>): Prisma.StaffApplicantWhereInput {
    return {
      deletedAt: null,
      ...(scope.rmId ? { assignedRmId: scope.rmId } : {}),
      ...(scope.branchId ? { branchId: scope.branchId } : {}),
    };
  }

  async getDashboard(user: AuthUser) {
    try {
      const scope = resolveStaffScope(user, {});
      const base = this.staffWhere(scope);
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const placementWhere = {
        ...(scope.rmId ? { rmId: scope.rmId } : {}),
        ...(scope.branchId ? { branchId: scope.branchId } : {}),
      };

      const [
        total_staff,
        active_pipeline,
        pending_verification,
        training_queue,
        deployment_queue,
        deferred_cases,
        trial_placements,
        active_placements,
        monthly_placements,
        open_incidents,
        pending_shifts,
        pending_video,
      ] = await Promise.all([
        this.prisma.staffApplicant.count({ where: base }).catch(() => 0),
        this.prisma.staffApplicant.count({
          where: { ...base, pipelineStage: { not: 'TERMINAL' } },
        }).catch(() => 0),
        this.prisma.staffApplicant.count({
          where: { ...base, pipelineStage: 'S2_VERIFY' },
        }).catch(() => 0),
        this.prisma.staffApplicant.count({
          where: { ...base, pipelineStage: 'S3_TRAIN' },
        }).catch(() => 0),
        this.prisma.staffApplicant.count({
          where: { ...base, pipelineStage: 'S4_AGREEMENTS' },
        }).catch(() => 0),
        this.prisma.staffApplicant.count({
          where: { ...base, pipelineStage: 'DEFERRED' },
        }).catch(() => 0),
        this.prisma.placement.count({
          where: { status: 'TRIAL', ...placementWhere },
        }).catch(() => 0),
        this.prisma.placement.count({
          where: { status: { in: ['TRIAL', 'CONFIRMED'] }, ...placementWhere },
        }).catch(() => 0),
        this.prisma.placement.count({
          where: { createdAt: { gte: monthStart }, ...placementWhere },
        }).catch(() => 0),
        this.prisma.incident.count({
          where: {
            status: 'OPEN',
            ...(scope.rmId ? { rmId: scope.rmId } : {}),
          },
        }).catch(() => 0),
        this.prisma.shiftLog.count({
          where: {
            status: 'PENDING',
            staff: scope.rmId
              ? { assignedRmId: scope.rmId }
              : scope.branchId
                ? { branchId: scope.branchId }
                : {},
          },
        }).catch(() => 0),
        this.prisma.videoCertification.count({
          where: {
            reviewStatus: 'PENDING',
            staff: scope.rmId
              ? { assignedRmId: scope.rmId, deletedAt: null }
              : { deletedAt: null },
          },
        }).catch(() => 0),
      ]);

      const row = {
        total_staff,
        active_pipeline,
        pending_verification,
        pending_video,
        trial_placements,
        active_placements,
        training_queue,
        deployment_queue,
        deferred_cases,
        monthly_placements,
        open_incidents,
        pending_shifts,
      };

      const stageCounts = await this.prisma.staffApplicant.groupBy({
        by: ['pipelineStage'],
        where: {
          deletedAt: null,
          ...(scope.rmId ? { assignedRmId: scope.rmId } : {}),
          ...(scope.branchId ? { branchId: scope.branchId } : {}),
        },
        _count: true,
      }).catch(() => []);

      const funnel = KANBAN_STAGES.map((stage) => ({
        stage,
        count: (stageCounts as { pipelineStage: string; _count: number }[]).find((s) => s.pipelineStage === stage)?._count ?? 0,
      }));

      const seriesDist = await this.prisma.staffApplicant.groupBy({
        by: ['series'],
        where: {
          deletedAt: null,
          pipelineStage: { not: 'TERMINAL' },
          ...(scope.rmId ? { assignedRmId: scope.rmId } : {}),
        },
        _count: true,
      }).catch(() => []);

      return {
        kpis: row,
        funnel,
        seriesDistribution: (seriesDist as { series: string; _count: number }[]).map((s) => ({
          series: s.series,
          count: s._count,
        })),
      };
    } catch {
      return {
        kpis: {
          total_staff: 0, active_pipeline: 0, pending_verification: 0,
          pending_video: 0, trial_placements: 0, active_placements: 0,
          training_queue: 0, deployment_queue: 0, deferred_cases: 0,
          monthly_placements: 0, open_incidents: 0, pending_shifts: 0,
        },
        funnel: [],
        seriesDistribution: [],
      };
    }
  }

  async getKanban(
    user: AuthUser,
    params: { search?: string; series?: string; limit?: number },
  ) {
    const scope = resolveStaffScope(user, {});
    const where: Prisma.StaffApplicantWhereInput = {
      deletedAt: null,
      ...(scope.rmId ? { assignedRmId: scope.rmId } : {}),
      ...(scope.branchId ? { branchId: scope.branchId } : {}),
    };
    if (params.series) where.series = params.series as never;
    if (params.search) {
      where.OR = [
        { staffCode: { contains: params.search, mode: 'insensitive' } },
        { fullName: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const items = await this.prisma.staffApplicant.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: params.limit ?? 500,
      include: {
        assignedRm: { select: { id: true, fullName: true } },
        deposits: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    const columns = KANBAN_STAGES.reduce(
      (acc, stage) => {
        acc[stage] = items
          .filter((i) => i.pipelineStage === stage)
          .map(toStaffDto);
        return acc;
      },
      {} as Record<string, ReturnType<typeof toStaffDto>[]>,
    );

    return { columns, total: items.length };
  }

  async advanceStage(
    user: AuthUser,
    staffId: string,
    toStage: string,
    reasonCode?: string,
    payload?: Record<string, unknown>,
  ) {
    const staff = await this.prisma.staffApplicant.findFirst({
      where: { id: staffId, deletedAt: null },
    });
    if (!staff) throw new NotFoundException(`Staff ${staffId} not found`);
    if (user.role === UserRole.RM && staff.assignedRmId !== user.id) {
      throw new ForbiddenException('Not assigned to this staff member');
    }

    await this.fsm.advanceStage({
      staffId,
      toStage: toStage as FsmStage,
      actorId: user.id,
      reasonCode,
      payload,
    });

    if (toStage === 'DEFERRED' && payload?.deferred_reason) {
      const timeoutAt = new Date();
      timeoutAt.setDate(timeoutAt.getDate() + 90);
      await this.prisma.deferredRecord.create({
        data: {
          staffId,
          reason: payload.deferred_reason as never,
          resumeStage: staff.pipelineStage,
          timeoutAt,
          notes: payload.notes ? String(payload.notes) : undefined,
        },
      });
    }

    const updated = await this.prisma.staffApplicant.findUnique({ where: { id: staffId } });
    this.events.emit('realtime.broadcast', {
      channel: 'pipeline',
      event: 'pipeline.stage_changed',
      data: { staffId, toStage, fromStage: staff.pipelineStage },
    });
    return updated ? toStaffDto(updated) : null;
  }

  async processIntake(user: AuthUser, body: Record<string, unknown>) {
    const aadhaar = String(body.aadhaar_number ?? '');
    const phone = String(body.mobile ?? body.phone ?? '');
    const restricted = await this.staffService.checkRestrictedList(aadhaar, phone);

    const intakeBody = {
      ...body,
      assigned_rm_id: user.role === UserRole.RM ? user.id : body.assigned_rm_id,
      branch_id: user.branchId ?? body.branch_id,
    };

    if (restricted.found) {
      const row = await this.prisma.staffApplicant.create({
        data: {
          ...parseCreateStaffBody(intakeBody),
          pipelineStage: 'TERMINAL',
          restrictedListFlag: true,
          terminalOutcome: 'DENIED',
          currentScenarioCode: 'RESTRICTED',
        },
      });
      await this.prisma.pipelineEvent.create({
        data: {
          staffId: row.id,
          eventType: 'RESTRICTED_LIST_HIT',
          fromStage: 'S1_INTAKE',
          toStage: 'TERMINAL',
          actorId: user.id,
          reasonCode: restricted.reason ?? 'RESTRICTED',
          payload: { aadhaar_hash: crypto.createHash('sha256').update(aadhaar).digest('hex') },
        },
      });
      this.events.emit('scenario.triggered', {
        staffId: row.id,
        code: 'RESTRICTED',
        effect: { notify: 'BM' },
      });
      return { outcome: 'RESTRICTED', staff: toStaffDto(row) };
    }

    const created = await this.staffService.create(intakeBody, user.id);
    if (body.deposit_amount) {
      await this.prisma.deposit.create({
        data: {
          staffId: created.id as string,
          amount: Number(body.deposit_amount),
          status: body.deposit_collected ? 'COLLECTED' : 'PENDING',
          collectedAt: body.deposit_collected ? new Date() : undefined,
        },
      });
    }

    if (body.advance_to_verify !== false) {
      await this.advanceStage(user, created.id as string, 'S2_VERIFY', 'INTAKE_COMPLETE', {
        referral_source: body.referral_source,
      });
    }

    const staff = await this.prisma.staffApplicant.findUnique({
      where: { id: created.id as string },
    });
    return { outcome: 'ADVANCE_S2', staff: staff ? toStaffDto(staff) : created };
  }

  async listIncidents(user: AuthUser, status?: string) {
    const scope = resolveStaffScope(user, {});
    return this.prisma.incident.findMany({
      where: {
        ...(scope.rmId ? { rmId: scope.rmId } : {}),
        ...(status ? { status: status as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { staff: { select: { staffCode: true, fullName: true } } },
    });
  }

  async createIncident(user: AuthUser, body: Record<string, unknown>) {
    const staffId = body.staff_id ? String(body.staff_id) : undefined;
    if (staffId) {
      const staff = await this.prisma.staffApplicant.findUnique({ where: { id: staffId } });
      if (!staff) throw new NotFoundException('Staff not found');
      if (user.role === UserRole.RM && staff.assignedRmId !== user.id) {
        throw new ForbiddenException('Not assigned to this staff member');
      }
    }
    return this.prisma.incident.create({
      data: {
        staffId,
        type: body.type as never,
        title: String(body.title),
        description: body.description ? String(body.description) : undefined,
        rmId: user.id,
        branchId: user.branchId ?? undefined,
        clientId: body.client_id ? String(body.client_id) : undefined,
        placementId: body.placement_id ? String(body.placement_id) : undefined,
        evidenceUrls: (body.evidence_urls as string[]) ?? [],
      },
    });
  }

  async listShiftLogs(user: AuthUser, status?: string) {
    const scope = resolveStaffScope(user, {});
    return this.prisma.shiftLog.findMany({
      where: {
        ...(status ? { status: status as never } : {}),
        ...(scope.rmId
          ? { staff: { assignedRmId: scope.rmId } }
          : scope.branchId
            ? { staff: { branchId: scope.branchId } }
            : {}),
      },
      orderBy: { shiftDate: 'desc' },
      take: 100,
      include: {
        staff: { select: { staffCode: true, fullName: true, series: true } },
      },
    });
  }

  async reviewShift(
    user: AuthUser,
    id: string,
    action: 'APPROVED' | 'REJECTED' | 'FLAGGED',
    notes?: string,
  ) {
    const log = await this.prisma.shiftLog.findUnique({
      where: { id },
      include: { staff: true },
    });
    if (!log) throw new NotFoundException('Shift log not found');
    if (user.role === UserRole.RM && log.staff.assignedRmId !== user.id) {
      throw new ForbiddenException('Not assigned to this staff member');
    }
    return this.prisma.shiftLog.update({
      where: { id },
      data: {
        status: action,
        approvedBy: user.id,
        notes: notes ?? log.notes,
      },
    });
  }

  async listDeferred(user: AuthUser) {
    const scope = resolveStaffScope(user, {});
    return this.prisma.deferredRecord.findMany({
      where: {
        staff: {
          pipelineStage: 'DEFERRED',
          deletedAt: null,
          ...(scope.rmId ? { assignedRmId: scope.rmId } : {}),
        },
      },
      orderBy: { deferredAt: 'asc' },
      take: 100,
      include: {
        staff: {
          select: {
            id: true,
            staffCode: true,
            fullName: true,
            series: true,
            currentScenarioCode: true,
          },
        },
      },
    });
  }

  async resumeDeferred(user: AuthUser, staffId: string, toStage: string) {
    const record = await this.prisma.deferredRecord.findFirst({
      where: { staffId },
      orderBy: { deferredAt: 'desc' },
    });
    if (!record) throw new BadRequestException('No deferred record found');
    await this.advanceStage(user, staffId, toStage, 'DEFERRED_RESUME', {
      deferred_record_id: record.id,
    });
    await this.prisma.deferredRecord.update({
      where: { id: record.id },
      data: { resumeAt: new Date() },
    });
    return { success: true };
  }

  async listUpgrades(user: AuthUser) {
    const scope = resolveStaffScope(user, {});
    return this.prisma.upgradeRequest.findMany({
      where: scope.rmId ? { staff: { assignedRmId: scope.rmId } } : {},
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        staff: { select: { staffCode: true, fullName: true, series: true } },
      },
    });
  }

  async listTrials(user: AuthUser) {
    const scope = resolveStaffScope(user, {});
    return this.prisma.placement.findMany({
      where: {
        status: 'TRIAL',
        ...(scope.rmId ? { rmId: scope.rmId } : {}),
        ...(scope.branchId ? { branchId: scope.branchId } : {}),
      },
      orderBy: { trialEndDate: 'asc' },
      take: 100,
    });
  }

  async listTerminal(user: AuthUser) {
    const scope = resolveStaffScope(user, {});
    const items = await this.prisma.staffApplicant.findMany({
      where: {
        pipelineStage: 'TERMINAL',
        deletedAt: null,
        ...(scope.rmId ? { assignedRmId: scope.rmId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return items.map(toStaffDto);
  }

  async getLocations(user: AuthUser) {
    const scope = resolveStaffScope(user, {});

    // Ensure config cities/branches exist for dropdowns (idempotent upsert)
    const extraBranches = [
      { id: PUNE_BRANCH_ID, name: 'HomeGenny Pune', city: 'Pune', state: 'Maharashtra' },
      { id: MUMBAI_BRANCH_ID, name: 'HomeGenny Mumbai', city: 'Mumbai', state: 'Maharashtra' },
    ];
    for (const b of extraBranches) {
      if (scope.branchId && scope.branchId !== b.id && scope.branchId !== DELHI_BRANCH_ID) continue;
      await this.prisma.branch.upsert({
        where: { id: b.id },
        create: {
          id: b.id,
          name: b.name,
          city: b.city,
          state: b.state,
          isActive: true,
        },
        update: { isActive: true },
      });
    }

    const allBranches = await this.prisma.branch.findMany({
      where: {
        isActive: true,
        ...(scope.branchId ? { id: scope.branchId } : {}),
      },
      select: { id: true, name: true, city: true },
      orderBy: [{ city: 'asc' }, { name: 'asc' }],
    });

    const configAreas = scope.branchId
      ? BRANCH_AREA_CONFIG.filter((a) => a.branch_id === scope.branchId)
      : BRANCH_AREA_CONFIG;

    const citySet = new Set<string>();
    for (const b of allBranches) {
      citySet.add(b.city === 'New Delhi' ? 'Delhi NCR' : b.city);
    }
    for (const a of configAreas) citySet.add(a.city);

    const areas = configAreas.map((a) => ({
      city: a.city,
      area: a.area,
      branch_code: a.branch_code,
      branch_id: a.branch_id,
      label: `${a.branch_code} — ${a.area}`,
    }));

    return {
      cities: [...citySet].sort(),
      branches: allBranches.map((b) => ({
        ...b,
        city: b.city === 'New Delhi' ? 'Delhi NCR' : b.city,
      })),
      areas,
    };
  }

  async getAttendance(
    user: AuthUser,
    branchId: string,
    month: number,
    year: number,
    branchCode?: string,
  ) {
    const scope = resolveStaffScope(user, { branchId });
    if (scope.branchId && scope.branchId !== branchId) {
      throw new ForbiddenException('Branch not in scope');
    }

    const placements = await this.prisma.placement.findMany({
      where: {
        branchId,
        status: 'CONFIRMED',
        ...(scope.rmId ? { rmId: scope.rmId } : {}),
      },
      include: {
        branch: { select: { id: true, name: true, city: true } },
      },
    });

    const staffIds = placements.map((p) => p.staffId);
    if (!staffIds.length) {
      return { month, year, branch_id: branchId, staff: [] };
    }

    const staffRows = await this.prisma.staffApplicant.findMany({
      where: {
        id: { in: staffIds },
        deletedAt: null,
        ...(scope.rmId ? { assignedRmId: scope.rmId } : {}),
      },
      select: { id: true, staffCode: true, fullName: true, branchId: true },
    });
    const staffById = new Map(staffRows.map((s) => [s.id, s]));

    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);

    const attendanceRows = await this.prisma.staffDailyAttendance.findMany({
      where: {
        staffId: { in: staffIds },
        branchId,
        attendanceDate: { gte: monthStart, lte: monthEnd },
      },
      orderBy: { attendanceDate: 'asc' },
    });

    const attendanceByStaff = new Map<string, typeof attendanceRows>();
    for (const row of attendanceRows) {
      const list = attendanceByStaff.get(row.staffId) ?? [];
      list.push(row);
      attendanceByStaff.set(row.staffId, list);
    }

    const invoiceRows = await this.prisma.invoice
      .findMany({
        where: {
          periodMonth: month,
          periodYear: year,
          placementId: { in: placements.map((p) => p.id) },
        },
        select: { id: true, placementId: true },
      })
      .catch(() => []);

    const invoiceByPlacement = new Map<string, string>(
      invoiceRows.map((r) => [r.placementId, r.id] as [string, string]),
    );

    const daysInMonth = this.payroll.daysInMonth(month, year);

    const staff = await Promise.all(
      placements
        .filter((p) => staffById.has(p.staffId))
        .map(async (p) => {
          const staff = staffById.get(p.staffId)!;
          const records = (attendanceByStaff.get(p.staffId) ?? []).map((r) => ({
            date: r.attendanceDate.toISOString().slice(0, 10),
            status: r.status,
            overtime_hours: r.overtimeHours ? Number(r.overtimeHours) : null,
          }));

          const statusCounts: Record<string, number> = {};
          for (const r of records) {
            statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
          }
          const summary = this.payroll.summarizeAttendanceCounts(
            Object.entries(statusCounts).map(([status, count]) => ({
              status,
              count: String(count),
            })),
            month,
            year,
          );

          const monthlySalary = Number(p.staffSalary ?? 0);
          const monthlyFee = Number(p.managementFee ?? 0);
          const proratedGross = this.payroll.calculateProratedGross(
            monthlySalary,
            summary.billable_days,
            daysInMonth,
          );

          return {
            staff_id: staff.id,
            staff_code: staff.staffCode,
            full_name: staff.fullName,
            placement_id: p.id,
            monthly_salary: monthlySalary,
            monthly_management_fee: monthlyFee,
            present_days: summary.present_days,
            absent_days: summary.absent_days,
            leave_days: summary.leave_days,
            overtime_days: summary.overtime_days,
            billable_days: summary.billable_days,
            days_in_month: daysInMonth,
            prorated_gross: proratedGross,
            invoice_id: invoiceByPlacement.get(p.id) ?? null,
            daily_records: records,
          };
        }),
    );

    return { month, year, branch_id: branchId, staff };
  }

  async markAttendance(
    user: AuthUser,
    body: {
      staff_id: string;
      date: string;
      status?: StaffAttendanceStatus | null;
      overtime_hours?: number;
      branch_id?: string;
    },
  ) {
    const staff = await this.prisma.staffApplicant.findUnique({
      where: { id: body.staff_id },
    });
    if (!staff) throw new NotFoundException('Staff not found');
    assertStaffAccess(user, staff);

    const placement = await this.prisma.placement.findFirst({
      where: {
        staffId: body.staff_id,
        status: 'CONFIRMED',
        ...(body.branch_id ? { branchId: body.branch_id } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!placement) throw new BadRequestException('No confirmed placement for staff');

    const attendanceDate = new Date(body.date);
    if (Number.isNaN(attendanceDate.getTime())) {
      throw new BadRequestException('Invalid date');
    }

    if (!body.status) {
      await this.prisma.staffDailyAttendance.deleteMany({
        where: { staffId: body.staff_id, attendanceDate },
      });
      return { cleared: true, staff_id: body.staff_id, date: body.date };
    }

    const record = await this.prisma.staffDailyAttendance.upsert({
      where: {
        staffId_attendanceDate: {
          staffId: body.staff_id,
          attendanceDate,
        },
      },
      create: {
        staffId: body.staff_id,
        placementId: placement.id,
        branchId: placement.branchId,
        attendanceDate,
        status: body.status,
        overtimeHours: body.overtime_hours,
        markedBy: user.id,
      },
      update: {
        status: body.status,
        overtimeHours: body.overtime_hours,
        markedBy: user.id,
        placementId: placement.id,
        branchId: placement.branchId,
      },
    });

    return {
      id: record.id,
      staff_id: record.staffId,
      date: body.date,
      status: record.status,
      overtime_hours: record.overtimeHours ? Number(record.overtimeHours) : null,
    };
  }

  async previewAttendanceInvoice(user: AuthUser, staffId: string, month: number, year: number) {
    const staff = await this.prisma.staffApplicant.findUnique({ where: { id: staffId } });
    if (!staff) throw new NotFoundException('Staff not found');
    assertStaffAccess(user, staff);

    const placement = await this.prisma.placement.findFirst({
      where: { staffId, status: 'CONFIRMED' },
      orderBy: { createdAt: 'desc' },
    });
    if (!placement) throw new NotFoundException('No confirmed placement');

    const preview = await this.payroll.previewAttendancePayroll(placement.id, month, year);
    const existing = await this.prisma.invoice.findFirst({
      where: { placementId: placement.id, periodMonth: month, periodYear: year },
      select: { id: true },
    });

    return {
      ...preview,
      staff_code: staff.staffCode,
      staff_name: staff.fullName,
      invoice_id: existing?.id ?? null,
    };
  }

  async generateAttendanceInvoice(user: AuthUser, staffId: string, month: number, year: number) {
    const staff = await this.prisma.staffApplicant.findUnique({ where: { id: staffId } });
    if (!staff) throw new NotFoundException('Staff not found');
    assertStaffAccess(user, staff);

    const placement = await this.prisma.placement.findFirst({
      where: { staffId, status: 'CONFIRMED' },
      orderBy: { createdAt: 'desc' },
    });
    if (!placement) throw new NotFoundException('No confirmed placement');

    const result = await this.payroll.runAttendancePayroll(placement.id, month, year);
    const invoice = result.invoice as Record<string, unknown>;
    return {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      payroll_id: (result.payroll as Record<string, unknown>).id,
      preview: result.preview,
      calculation: result.calculation,
    };
  }
}
