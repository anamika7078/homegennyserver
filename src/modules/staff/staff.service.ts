import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PipelineStage } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';
import * as crypto from 'crypto';
import { mapSeriesFromShort, parseCreateStaffBody, toStaffDto, mapSeriesToShort } from '../../common/mappers/staff.mapper';

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(data: Record<string, unknown>, actorId?: string) {
    const input = parseCreateStaffBody(data);
    
    if (!data.staff_code) {
      const firstName = input.fullName
        ? input.fullName.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '')
        : 'emp';

      let seqNumber = 1;
      
      const latest = await this.prisma.staffApplicant.findFirst({
        where: { staffCode: { startsWith: firstName } },
        orderBy: { staffCode: 'desc' },
      });

      if (latest) {
        const match = latest.staffCode.match(/\d+$/);
        if (match) {
          seqNumber = parseInt(match[0], 10) + 1;
        }
      }
      
      input.staffCode = `${firstName}${seqNumber.toString().padStart(3, '0')}`;
    }

    const row = await this.prisma.staffApplicant.create({ data: input });
    await this.audit.log({
      actorId,
      action: AuditAction.STAGE_TRANSITION,
      entityType: 'staff_applicant',
      entityId: row.id,
      metadata: { stage: 'S1_INTAKE', action: 'created' },
    });
    return toStaffDto(row);
  }

  async findById(id: string) {
    // Try by UUID first, then fall back to staff_code
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const row = await this.prisma.staffApplicant.findFirst({
      where: isUuid
        ? { id, deletedAt: null }
        : { staffCode: id, deletedAt: null },
    });
    if (row) return toStaffDto(row);

    // Fall back to internal HR employees table
    const emp = await this.prisma.employee.findFirst({
      where: isUuid
        ? { id, deletedAt: null }
        : { employeeId: { equals: id, mode: 'insensitive' }, deletedAt: null },
    });
    if (emp) {
      return {
        id: emp.id,
        staff_code: emp.employeeId,
        branch_id: emp.branchId,
        assigned_rm_id: null,
        series: emp.department || 'GENERAL',
        series_db: emp.department || 'GENERAL',
        role_types: [emp.designation || emp.department || 'STAFF'],
        language_tier: 'ENGLISH',
        pipeline_stage: emp.status === 'Active' ? 'CONFIRMED' : emp.status.toUpperCase(),
        current_scenario_code: null,
        terminal_outcome: null,
        full_name: emp.fullName,
        date_of_birth: emp.dateOfBirth,
        mobile: emp.mobile,
        email: emp.email,
        address: `${emp.address || ''}, ${emp.city || ''}`.trim().replace(/^,/, ''),
        emergency_contact_name: null,
        emergency_contact_mobile: null,
        verified_docs: true,
        pv_status: 'CLEARED',
        restricted_list_flag: false,
        video_cert_id: null,
        restrictions: [],
        metadata: {},
        created_at: emp.createdAt,
        updated_at: emp.updatedAt,
        source: 'HR_EMPLOYEE',
      };
    }

    throw new NotFoundException(`Staff ${id} not found`);
  }

  async findAll(params: {
    limit?: number;
    offset?: number;
    stage?: string;
    series?: string;
    rmId?: string;
    branchId?: string;
  }) {
    const where: Prisma.StaffApplicantWhereInput = { deletedAt: null };
    if (params.stage) where.pipelineStage = params.stage as PipelineStage;
    if (params.rmId) where.assignedRmId = params.rmId;
    if (params.branchId) where.branchId = params.branchId;
    if (params.series) where.series = mapSeriesFromShort(params.series);

    const [items, total] = await Promise.all([
      this.prisma.staffApplicant.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: params.limit ?? 100,
        skip: params.offset ?? 0,
      }),
      this.prisma.staffApplicant.count({ where }),
    ]);

    // Also include internal HR employees
    let effectiveBranchId = params.branchId;
    if (!effectiveBranchId && params.rmId) {
      const rm = await this.prisma.user.findUnique({
        where: { id: params.rmId },
        select: { branchId: true },
      });
      if (rm?.branchId) effectiveBranchId = rm.branchId;
    }

    const empWhere: Prisma.EmployeeWhereInput = { deletedAt: null };
    if (effectiveBranchId) empWhere.branchId = effectiveBranchId;

    const empItems = await this.prisma.employee.findMany({
      where: empWhere,
      orderBy: { updatedAt: 'desc' },
      take: params.limit ?? 100,
    });

    const mappedEmployees = empItems.map((e) => ({
      id: e.id,
      staff_code: e.employeeId,
      branch_id: e.branchId,
      assigned_rm_id: params.rmId ?? null,
      series: e.department || 'GENERAL',
      series_db: e.department || 'GENERAL',
      role_types: [e.designation || e.department || 'STAFF'],
      language_tier: 'ENGLISH',
      pipeline_stage: e.status === 'Active' ? 'CONFIRMED' : e.status.toUpperCase(),
      current_scenario_code: null,
      terminal_outcome: null,
      full_name: e.fullName,
      date_of_birth: e.dateOfBirth,
      mobile: e.mobile,
      email: e.email,
      address: `${e.address || ''}, ${e.city || ''}`.trim().replace(/^,/, ''),
      emergency_contact_name: null,
      emergency_contact_mobile: null,
      verified_docs: true,
      pv_status: 'CLEARED',
      restricted_list_flag: false,
      video_cert_id: null,
      restrictions: [],
      metadata: {},
      created_at: e.createdAt,
      updated_at: e.updatedAt,
      source: 'HR_EMPLOYEE',
    }));

    const combined = [...items.map(toStaffDto), ...mappedEmployees];
    return { items: combined, total: total + mappedEmployees.length };
  }

  async update(id: string, data: Record<string, unknown>, actorId?: string) {
    const before = await this.prisma.staffApplicant.findUnique({ where: { id } });
    if (!before) throw new NotFoundException(`Staff ${id} not found`);

    const patch: Prisma.StaffApplicantUpdateInput = {};
    if (data.pipeline_stage) patch.pipelineStage = data.pipeline_stage as PipelineStage;
    if (data.current_scenario_code) patch.currentScenarioCode = String(data.current_scenario_code);
    if (data.full_name) patch.fullName = String(data.full_name);
    if (data.assigned_rm_id) {
      patch.assignedRm = { connect: { id: String(data.assigned_rm_id) } };
    }
    if (data.metadata) patch.metadata = data.metadata as Prisma.InputJsonValue;
    if (data.pv_status) patch.pvStatus = data.pv_status as never;
    if (data.video_cert_id) patch.videoCertId = String(data.video_cert_id);

    const row = await this.prisma.staffApplicant.update({ where: { id }, data: patch });
    if (data.pipeline_stage && data.pipeline_stage !== before.pipelineStage) {
      await this.prisma.pipelineEvent.create({
        data: {
          staffId: id,
          eventType: 'STAGE_ADVANCE',
          fromStage: before.pipelineStage,
          toStage: String(data.pipeline_stage),
          actorId,
          payload: {},
        },
      });
      await this.audit.log({
        actorId,
        action: AuditAction.STAGE_TRANSITION,
        entityType: 'staff_applicant',
        entityId: id,
        before: { pipeline_stage: before.pipelineStage },
        after: { pipeline_stage: data.pipeline_stage },
      });
    }
    return toStaffDto(row);
  }

  async getTimeline(staffId: string) {
    await this.findById(staffId);
    const [pipeline, scenarios, audits] = await Promise.all([
      this.prisma.pipelineEvent.findMany({
        where: { staffId },
        orderBy: { occurredAt: 'desc' },
        take: 100,
      }),
      this.prisma.scenarioLog.findMany({
        where: { staffId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.auditLog.findMany({
        where: { entityId: staffId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { actor: { select: { fullName: true, role: true } } },
      }),
    ]);

    const events = [
      ...pipeline.map((e) => ({
        id: e.id,
        type: 'pipeline' as const,
        title: `${e.fromStage ?? '?'} → ${e.toStage ?? e.eventType}`,
        at: e.occurredAt,
        meta: e.reasonCode ?? e.eventType,
        payload: e.payload,
      })),
      ...scenarios.map((s) => ({
        id: s.id,
        type: 'scenario' as const,
        title: `Scenario ${s.scenarioCode}`,
        at: s.createdAt,
        meta: s.escalatedToBm ? 'BM escalated' : 'Routed',
        payload: s.flags,
      })),
      ...audits.map((a) => ({
        id: a.id,
        type: 'audit' as const,
        title: a.action,
        at: a.createdAt,
        meta: a.actor?.fullName ?? 'System',
        payload: a.metadata,
      })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return { staffId, events };
  }

  async checkRestrictedList(aadhaarNumber: string, phone: string) {
    try {
      const aadhaarHash = crypto.createHash('sha256').update(aadhaarNumber).digest('hex');
      const phoneHash = crypto.createHash('sha256').update(phone).digest('hex');
      const hit = await this.prisma.restrictedListEntry.findFirst({
        where: { OR: [{ aadhaarHash }, { phoneHash }] },
      });
      return hit ? { found: true, reason: hit.reason } : { found: false };
    } catch {
      return { found: false };
    }
  }
}
