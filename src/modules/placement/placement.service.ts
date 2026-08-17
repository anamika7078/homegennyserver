import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PlacementStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';

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
    createdAt: Date;
    updatedAt: Date;
  }, staff?: { staffCode: string; series: string; fullName?: string } | null, client?: { customerName: string } | null): PlacementRow {
    return {
      id: p.id,
      staff_id: p.staffId,
      client_id: p.clientId,
      status: p.status,
      staff_salary: p.staffSalary != null ? Number(p.staffSalary) : null,
      management_fee: p.managementFee != null ? Number(p.managementFee) : null,
      trial_start_date: p.trialStartDate,
      trial_end_date: p.trialEndDate,
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

  async create(data: Record<string, unknown>, actorId?: string) {
    const branchId = String(data.branch_id ?? '00000000-0000-0000-0000-000000000001');
    const row = await this.prisma.placement.create({
      data: {
        staffId: String(data.staff_id),
        clientId: String(data.client_id),
        branchId,
        rmId: data.rm_id ? String(data.rm_id) : undefined,
        status: PlacementStatus.TRIAL,
        staffSalary: data.staff_salary != null ? Number(data.staff_salary) : undefined,
        managementFee: data.management_fee != null ? Number(data.management_fee) : undefined,
        trialStartDate: data.trial_start_date ? new Date(String(data.trial_start_date)) : new Date(),
        trialEndDate: data.trial_end_date
          ? new Date(String(data.trial_end_date))
          : new Date(Date.now() + 14 * 86400000),
      },
    });

    await this.prisma.deployment.create({
      data: {
        staffId: row.staffId,
        clientId: row.clientId,
        placementId: row.id,
        status: PlacementStatus.TRIAL,
        trialStartDate: row.trialStartDate,
        trialEndDate: row.trialEndDate,
      },
    }).catch(() => undefined);

    await this.audit.log({
      actorId,
      action: AuditAction.DEPLOYMENT_ACTION,
      entityType: 'placement',
      entityId: row.id,
      metadata: { action: 'trial_started' },
    });

    this.events.emit('realtime.broadcast', {
      channel: 'deployments',
      event: 'placement.created',
      data: { placementId: row.id, staffId: row.staffId },
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

  async findAll(params: { limit: number; offset: number }) {
    const [rows, total] = await Promise.all([
      this.prisma.placement.findMany({
        orderBy: { createdAt: 'desc' },
        take: params.limit,
        skip: params.offset,
        include: {
          branch: false,
        },
      }),
      this.prisma.placement.count(),
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
