import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, PipelineStage, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PipelineFsmService, PipelineStage as FsmStage } from '../pipeline/pipeline-fsm.service';
import { AuthUser, resolveStaffScope } from '../../common/guards/branch-scope.util';
import { toStaffDto, parseCreateStaffBody } from '../../common/mappers/staff.mapper';
import { StaffService } from '../staff/staff.service';
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
}
