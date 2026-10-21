import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Prisma, PipelineStage, LanguageTier } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';
import * as crypto from 'crypto';
import { mapSeriesFromShort, parseCreateStaffBody, toStaffDto, mapSeriesToShort } from '../../common/mappers/staff.mapper';
import { assertSeriesActive } from '../../common/config/active-series';

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(data: Record<string, unknown>, actorId?: string) {
    const input = parseCreateStaffBody(data);

    // Restricted-list check — "always first, before any other action" per
    // spec. Previously this check only existed as an advisory endpoint
    // (POST /staff/check-restricted) the caller could simply not call, or as
    // a branch inside the standalone scenario router that advanceStage()
    // never invoked — neither actually blocked anything. This is intake, so
    // aadhaar usually isn't collected yet (that's S2_VERIFY); phone is
    // always available and is checked. Aadhaar is also checked when supplied.
    const aadhaarNumber = data.aadhaar_number ? String(data.aadhaar_number) : '';
    if (input.mobile) {
      const hit = await this.checkRestrictedList(aadhaarNumber, input.mobile);
      if (hit.found) {
        await this.audit.log({
          actorId,
          action: AuditAction.RESTRICTED_LIST,
          entityType: 'staff_applicant_intake',
          metadata: { phone: input.mobile, reason: hit.reason, blocked: 'intake' },
        });
        throw new ForbiddenException(
          `Intake blocked — this applicant matches the restricted list (${hit.reason ?? 'reason withheld'}).`,
        );
      }
    }

    if (!data.staff_code) {
      input.staffCode = await this.nextStaffCode(input.fullName);
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

  /** First name + a running number (pooja001, pooja002…); "new" when there is no name yet. */
  private async nextStaffCode(fullName?: string | null): Promise<string> {
    const firstName =
      (fullName ?? '').trim().split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '') || (fullName == null ? 'new' : 'emp');
    let seqNumber = 1;
    const latest = await this.prisma.staffApplicant.findFirst({
      where: { staffCode: { startsWith: firstName } },
      orderBy: { staffCode: 'desc' },
    });
    if (latest) {
      const match = latest.staffCode.match(/\d+$/);
      if (match) seqNumber = parseInt(match[0], 10) + 1;
    }
    return `${firstName}${seqNumber.toString().padStart(3, '0')}`;
  }

  /**
   * A staff member who signed up from the app with a mobile number only. The
   * row sits at S1_INTAKE with no name, DOB, address or series until an RM
   * fills them in with completeIntake(). Same restricted-list check as an
   * RM intake, on the phone.
   */
  async createSelfRegistered(params: {
    mobile: string;
    fullName?: string;
    series?: string;
    /** Older app builds still send the full form — kept for the RM to confirm. */
    email?: string;
    dateOfBirth?: string;
    address?: string;
    extra?: Record<string, unknown>;
  }) {
    const hit = await this.checkRestrictedList('', params.mobile);
    if (hit.found) {
      await this.audit.log({
        action: AuditAction.RESTRICTED_LIST,
        entityType: 'staff_applicant_intake',
        metadata: { phone: params.mobile, reason: hit.reason, blocked: 'self_registration' },
      });
      throw new ForbiddenException('This number cannot be registered. Please contact HomeGenny.');
    }
    // Optional at sign-up: kept if given, checked the same way as everywhere else.
    let series: ReturnType<typeof mapSeriesFromShort> | null = null;
    if (params.series) {
      series = mapSeriesFromShort(params.series);
      assertSeriesActive(series);
    }
    const fullName = params.fullName?.trim() || null;
    const row = await this.prisma.staffApplicant.create({
      data: {
        staffCode: await this.nextStaffCode(fullName),
        series,
        fullName,
        dateOfBirth: params.dateOfBirth ? new Date(`${params.dateOfBirth.slice(0, 10)}T00:00:00.000Z`) : null,
        address: params.address?.trim() || null,
        email: params.email || null,
        mobile: params.mobile,
        pipelineStage: PipelineStage.S1_INTAKE,
        metadata: { ...(params.extra ?? {}), self_registered: true, staff_code_provisional: !fullName } as Prisma.InputJsonValue,
      },
    });
    await this.audit.log({
      action: AuditAction.STAGE_TRANSITION,
      entityType: 'staff_applicant',
      entityId: row.id,
      metadata: { stage: 'S1_INTAKE', action: 'self_registered' },
    });
    return row;
  }

  /**
   * "Complete S1" — the RM fills in what an app sign-up left out. Writes the
   * S1 fields only (the stage move to S2 is the caller's); a staff code made
   * before there was a name is replaced with one from the name.
   */
  async completeIntake(staffId: string, body: Record<string, unknown>, actorId: string) {
    const staff = await this.prisma.staffApplicant.findFirst({ where: { id: staffId, deletedAt: null } });
    if (!staff) throw new NotFoundException(`Staff ${staffId} not found`);
    if (staff.pipelineStage !== PipelineStage.S1_INTAKE) {
      throw new BadRequestException(`S1 is already done — this staff member is at ${staff.pipelineStage}.`);
    }

    const str = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? undefined : String(v).trim());
    const fullName = str(body.full_name) ?? staff.fullName ?? undefined;
    const dob = str(body.date_of_birth);
    const address = str(body.address) ?? staff.address ?? undefined;
    const seriesRaw = str(body.series);
    const missing = [
      !fullName && 'full_name',
      !dob && !staff.dateOfBirth && 'date_of_birth',
      !address && 'address',
      !seriesRaw && !staff.series && 'series',
    ].filter(Boolean);
    if (missing.length) throw new BadRequestException(`Required to complete S1: ${missing.join(', ')}`);
    if (fullName!.length < 2) throw new BadRequestException('full_name is too short.');
    let dateOfBirth: Date | undefined;
    if (dob) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(`${dob}T00:00:00Z`))) {
        throw new BadRequestException('date_of_birth must be YYYY-MM-DD.');
      }
      // UTC midnight — a @db.Date column stores the day meant (this server runs IST).
      dateOfBirth = new Date(`${dob}T00:00:00.000Z`);
    }
    let series = staff.series;
    if (seriesRaw) {
      series = mapSeriesFromShort(seriesRaw);
      if (series !== staff.series) assertSeriesActive(series);
    }

    const aadhaar = str(body.aadhaar_number);
    if (aadhaar && !/^\d{12}$/.test(aadhaar)) throw new BadRequestException('aadhaar_number must be 12 digits.');
    const hit = await this.checkRestrictedList(aadhaar ?? '', staff.mobile);

    const meta = (staff.metadata ?? {}) as Record<string, unknown>;
    const extra: Record<string, unknown> = {};
    for (const k of ['gender', 'alternate_phone', 'city', 'state', 'pincode', 'hometown', 'referral_source', 'intake_notes']) {
      const v = str(body[k]);
      if (v !== undefined) extra[k] = k === 'gender' ? v.toUpperCase() : v;
    }
    if (extra.gender !== undefined && !['MALE', 'FEMALE', 'OTHER'].includes(String(extra.gender))) {
      throw new BadRequestException('gender must be MALE, FEMALE or OTHER.');
    }
    const languageTier = str(body.language_tier);
    if (languageTier && !['T1', 'T2', 'T3', 'T4'].includes(languageTier)) {
      throw new BadRequestException('language_tier must be T1, T2, T3 or T4.');
    }
    const email = str(body.email);

    const renameCode = meta.staff_code_provisional === true;
    const updated = await this.prisma.staffApplicant.update({
      where: { id: staffId },
      data: {
        fullName,
        address,
        series,
        ...(dateOfBirth ? { dateOfBirth } : {}),
        ...(aadhaar ? { aadhaarNumber: aadhaar } : {}),
        ...(languageTier ? { languageTier: languageTier as LanguageTier } : {}),
        ...(email ? { email } : {}),
        ...(str(body.emergency_contact_name) ? { emergencyContactName: str(body.emergency_contact_name) } : {}),
        ...(str(body.emergency_contact_mobile) ? { emergencyContactMobile: str(body.emergency_contact_mobile) } : {}),
        ...(renameCode ? { staffCode: await this.nextStaffCode(fullName) } : {}),
        ...(hit.found ? { restrictedListFlag: true } : {}),
        metadata: {
          ...meta,
          ...extra,
          staff_code_provisional: false,
          intake_completed_at: new Date().toISOString(),
          intake_completed_by: actorId,
        } as Prisma.InputJsonValue,
      },
    });
    // The login shows this name in the app header.
    if (updated.userId) {
      await this.prisma.user.update({ where: { id: updated.userId }, data: { fullName: fullName! } }).catch(() => undefined);
    }
    await this.audit.log({
      actorId,
      action: AuditAction.STAGE_TRANSITION,
      entityType: 'staff_applicant',
      entityId: staffId,
      metadata: { stage: 'S1_INTAKE', action: 'intake_completed', restricted: hit.found },
    });
    return { staff: updated, restricted: hit };
  }

  async findById(id: string) {
    // Try by UUID first, then fall back to staff_code
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const row = await this.prisma.staffApplicant.findFirst({
      where: isUuid
        ? { id, deletedAt: null }
        : { staffCode: id, deletedAt: null },
      include: {
        // The deposit lives in `deposits` — intake writes it there. The
        // staff_applicants.deposit_amount/deposit_paid columns default to 0
        // and false and nothing has ever written them, so the staff detail
        // screen showed "₹0 Pending" for everyone. Same root cause as F-05.
        deposits: { orderBy: { createdAt: 'desc' }, take: 1 },
        // Open holds on this staff — toStaffDto() maps this to `open_holds`.
        // Without it, the staff detail screen (Agreements/S4 in particular)
        // had no way to show a held stage, or let the RM bypass a blocked
        // deployment gate by placing one.
        stageHolds: { where: { releasedAt: null }, orderBy: { heldAt: 'asc' } },
      },
    });
    if (row) {
      const deposit = row.deposits?.[0];
      return {
        ...toStaffDto(row),
        deposit_amount: deposit ? Number(deposit.amount) : 0,
        deposit_paid: deposit ? deposit.status === 'COLLECTED' : false,
        deposit_status: deposit
          ? (deposit.event ?? (deposit.status === 'COLLECTED' ? 'PAID' : 'UNPAID'))
          : 'NONE',
      };
    }

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
        pipeline_stage: emp.status === 'Active' ? 'CONFIRMED' : (emp.status || '').toUpperCase(),
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
    if (effectiveBranchId && effectiveBranchId !== '00000000-0000-0000-0000-000000000001') {
      empWhere.OR = [
        { branchId: effectiveBranchId },
        { branchId: '00000000-0000-0000-0000-000000000001' },
      ];
    }

    const empItems = await this.prisma.employee.findMany({
      where: empWhere,
      orderBy: { updatedAt: 'desc' },
      take: params.limit ?? 100,
    });

    const mappedEmployees = empItems.map((e) => {
      const depStr = `${e.department || ''} ${e.designation || ''}`.toUpperCase();
      let series = 'DRIVER';
      if (depStr.includes('COOK') || depStr.includes('CHEF')) series = 'COOK';
      else if (depStr.includes('MAID') || depStr.includes('CLEAN')) series = 'MAID';
      else if (depStr.includes('SKILL') || depStr.includes('CARE') || depStr.includes('NURSE')) series = 'SKILLED_CARE';
      else if (depStr.includes('UNSKILL') || depStr.includes('HELP') || depStr.includes('BOY') || depStr.includes('GUARD')) series = 'UNSKILLED_CARE';
      else if (depStr.includes('DRIV')) series = 'DRIVER';
      else series = (e.department || 'GENERAL').toUpperCase();

      return {
        id: e.id,
        staff_code: e.employeeId,
        branch_id: e.branchId,
        assigned_rm_id: params.rmId ?? null,
        series: series,
        series_db: series,
        role_types: [e.designation || e.department || 'STAFF'],
        language_tier: 'ENGLISH',
        pipeline_stage: e.status === 'Active' ? 'CONFIRMED' : (e.status || '').toUpperCase(),
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
      };
    }).filter((e) => {
      if (params.series) {
        const targetSeries = mapSeriesFromShort(params.series);
        if (e.series !== targetSeries && e.series !== params.series) return false;
      }
      return true;
    });

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
