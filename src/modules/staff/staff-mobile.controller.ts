import {
  Controller, Get, Post, Put, Body, UseGuards, Req, Res, Query, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { EmployeePayslipService } from '../employees/employee-payslip.service';

const PIPELINE_STAGE_LABELS: Record<string, string> = {
  S1_INTAKE: 'Stage 1 - Intake',
  S2_VERIFY: 'Stage 2 - Verification',
  S2_5_ASSESS: 'Stage 2.5 - Practical Assessment',
  S3_TRAIN: 'Stage 3 - Training & Certification',
  S4_AGREEMENTS: 'Stage 4 - Agreements',
  S5_DEPLOY: 'Stage 5 - Deployment',
  DEFERRED: 'Deferred',
  TERMINAL: 'Terminal',
};

/** The 6 forward stages of the FSM — DEFERRED/TERMINAL are exception states, handled separately. */
const STAGE_ORDER = ['S1_INTAKE', 'S2_VERIFY', 'S2_5_ASSESS', 'S3_TRAIN', 'S4_AGREEMENTS', 'S5_DEPLOY'];

const STAGE_DESCRIPTIONS: Record<string, string> = {
  S1_INTAKE: 'Restricted-list check, personal details, and deposit collection',
  S2_VERIFY: 'Aadhaar eKYC, driving licence, eChallan, police verification, and medical checks',
  S2_5_ASSESS: 'Practical/road test (Driver series only)',
  S3_TRAIN: 'Series-specific training modules and video self-certification',
  S4_AGREEMENTS: 'Employment contract, scope of work, and client indemnity sign-off',
  S5_DEPLOY: 'Trial period, shift attendance, and confirmed placement',
};

/**
 * Verification tracks (beyond Police Verification, tracked separately via pvStatus)
 * required per series before S2 is considered complete. Keyed by the StaffSeries enum
 * values stored on staff.series (MAID/SKILLED_CARE/UNSKILLED_CARE/DRIVER) — NOT the
 * DR/SC/UC short codes the mobile app displays. Keying this by the short codes
 * previously made every lookup below miss for non-MAID series, silently returning
 * `requiredTracks: []` and making `tracksClear`/`isVerified` vacuously true.
 */
const REQUIRED_VERIFICATION_TRACKS: Record<string, string[]> = {
  DRIVER: ['AADHAAR_EKYC', 'SARATHI_API', 'ECHALLAN_API', 'HEALTH_SCREENING'],
  SKILLED_CARE: ['AADHAAR_EKYC', 'HEALTH_SCREENING'],
  UNSKILLED_CARE: ['AADHAAR_EKYC'],
  MAID: ['AADHAAR_EKYC'],
};

/**
 * How many RM-approved prompts each series needs, and the short code the
 * deployment gate keys them by. Both mirror pipeline-fsm.service.ts, whose
 * copies are file-local and not exported; if that gate's numbers change, this
 * has to change with it or the app will show a completion the gate disagrees
 * with.
 */
const REQUIRED_VIDEO_PROMPTS: Record<string, number> = { MAID: 9, SC: 10, UC: 10, DR: 12 };
const STAFF_SERIES_SHORT: Record<string, string> = {
  MAID: 'MAID',
  SKILLED_CARE: 'SC',
  UNSKILLED_CARE: 'UC',
  DRIVER: 'DR',
};

/** "1 day", not "1 days" — this text is read by the staff member, not a log. */
function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** MAID may proceed with PV still pending (only an adverse result blocks); every other series needs a CLEAR result. */
function isPvClear(seriesShort: string, pvStatus: string): boolean {
  if (seriesShort === 'MAID') return pvStatus !== 'ADVERSE';
  return pvStatus === 'CLEAR';
}

@ApiTags('Staff Mobile App', 'Mobile App RM APIs', 'Mobile App Staff APIs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.STAFF, UserRole.RM, UserRole.BM, UserRole.ADMIN)
@Controller({ path: 'staff', version: '1' })
export class StaffMobileController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payslips: EmployeePayslipService,
  ) {}

  /**
   * Builds the 6-stage progress array (completed/current/pending) from real
   * PipelineEvent history, same table `staff.service.ts`'s admin/RM
   * getTimeline() reads, just staff-scoped and reshaped for the app's
   * List<PipelineStage> model.
   */
  private async buildPipelineProgress(staff: { id: string; pipelineStage: string } | null) {
    if (!staff) {
      return {
        items: STAGE_ORDER.map((stage) => ({
          id: stage,
          title: PIPELINE_STAGE_LABELS[stage],
          description: STAGE_DESCRIPTIONS[stage],
          status: 'pending' as const,
          completed_at: null as string | null,
        })),
        overall_status: 'IN_PROGRESS' as const,
        completion_pct: 0,
      };
    }

    const events = await this.prisma.pipelineEvent.findMany({
      where: { staffId: staff.id },
      orderBy: { occurredAt: 'asc' },
    });

    // completedAt per stage = occurredAt of the event whose fromStage was that stage
    // (i.e. the transition that moved the applicant OUT of it).
    const completedAtByStage: Record<string, Date> = {};
    for (const event of events) {
      if (event.fromStage && STAGE_ORDER.includes(event.fromStage) && !completedAtByStage[event.fromStage]) {
        completedAtByStage[event.fromStage] = event.occurredAt;
      }
    }

    const isException = staff.pipelineStage === 'DEFERRED' || staff.pipelineStage === 'TERMINAL';
    // If deferred/terminal, "current" for display purposes is the last forward
    // stage actually reached — the most recent event's fromStage — not DEFERRED/TERMINAL itself.
    const displayStage = isException
      ? events[events.length - 1]?.fromStage ?? STAGE_ORDER[0]
      : staff.pipelineStage;
    const currentIndex = STAGE_ORDER.indexOf(displayStage);

    const items = STAGE_ORDER.map((stage, index) => {
      let status: 'completed' | 'current' | 'pending';
      if (index < currentIndex) {
        status = 'completed';
      } else if (index === currentIndex) {
        status = 'current';
      } else {
        status = 'pending';
      }
      return {
        id: stage,
        title: PIPELINE_STAGE_LABELS[stage],
        description: STAGE_DESCRIPTIONS[stage],
        status,
        completed_at: completedAtByStage[stage]?.toISOString() ?? null,
      };
    });

    const completedCount = items.filter((i) => i.status === 'completed').length;
    return {
      items,
      overall_status: isException ? (staff.pipelineStage as 'DEFERRED' | 'TERMINAL') : ('IN_PROGRESS' as const),
      completion_pct: Math.round((completedCount / STAGE_ORDER.length) * 100),
    };
  }

  @Get('dashboard')
  @ApiOperation({ summary: 'Get staff today tasks & completion %' })
  async getDashboard(@Req() req: any) {
    const staff = await this.prisma.staffApplicant.findFirst({
      where: { userId: req.user.id },
      include: { branch: true, assignedRm: true },
    });

    const progress = await this.buildPipelineProgress(staff);

    return {
      staffCode: staff?.staffCode || 'STF-1029',
      fullName: staff?.fullName || req.user.fullName || 'Pooja Mishra',
      series: staff?.series || 'MAID',
      pipelineStage: staff?.pipelineStage || 'S2_VERIFY',
      completionPct: progress.completion_pct,
      assignedRm: staff?.assignedRm
        ? { name: staff.assignedRm.fullName, phone: staff.assignedRm.phone }
        : { name: 'Amit Gupta (RM)', phone: '+919800000001' },
      // ⚠️ Not yet backed by a real task/checklist table — no schema exists
      // for per-day staff tasks. Flagged as a known follow-up, not silently dropped.
      todayTasks: [
        { id: 1, title: 'Record Video Certification Prompt #2', done: false },
        { id: 2, title: 'Upload Police Verification Document', done: false },
      ],
    };
  }

  @Get('profile')
  @ApiOperation({ summary: 'Fetch staff personal details' })
  async getProfile(@Req() req: any) {
    const staff = await this.prisma.staffApplicant.findFirst({
      where: { userId: req.user.id },
    });

    return {
      id: req.user.id,
      // The video-cert endpoints (upload-url/finalize/list) key everything on
      // staff_applicants.id and check ownership by phone match against it —
      // `id` above is the *users* row, which is a different id. Without this,
      // the app had no way to learn its own staffApplicant id and every
      // video-cert call 403'd with "You may only access your own staff record".
      staffApplicantId: staff?.id ?? null,
      staffCode: staff?.staffCode || 'STF-1029',
      fullName: staff?.fullName || req.user.fullName || 'Pooja Mishra',
      mobile: staff?.mobile || req.user.phone,
      email: staff?.email || req.user.email,
      series: staff?.series || 'MAID',
      pipelineStage: staff?.pipelineStage || 'S2_VERIFY',
      // Fallback literals only fire when there's no staff row at all — a real
      // staff with a genuinely blank address/DOB no longer gets overwritten.
      address: staff ? staff.address ?? null : 'Sector 62, Noida, UP',
      dateOfBirth: staff ? staff.dateOfBirth : '1996-05-15',
    };
  }

  @Put('profile')
  @ApiOperation({ summary: 'Update staff personal details' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        address: { type: 'string', example: 'Sector 12, Noida' },
        email: { type: 'string', example: 'rohan@example.com' },
      },
    },
  })
  async updateProfile(@Req() req: any, @Body() body: any) {
    const staff = await this.prisma.staffApplicant.findFirst({
      where: { userId: req.user.id },
    });

    if (staff) {
      await this.prisma.staffApplicant.update({
        where: { id: staff.id },
        data: {
          address: body.address || staff.address,
          email: body.email || staff.email,
        },
      });
    }

    return { success: true, message: 'Profile updated successfully' };
  }

  @Get('pipeline-status')
  @ApiOperation({ summary: 'Fetch current onboarding stage only (see GET /staff/pipeline for full stage-by-stage progress)' })
  async getPipelineStatus(@Req() req: any) {
    const staff = await this.prisma.staffApplicant.findFirst({
      where: { userId: req.user.id },
      include: { verificationTracks: true },
    });

    const series = staff?.series || 'MAID';
    const requiredTracks = REQUIRED_VERIFICATION_TRACKS[series] ?? [];
    const tracksClear = requiredTracks.every((trackType) =>
      staff?.verificationTracks.some((t) => t.trackType === trackType && t.status === 'CLEAR'),
    );
    const pvClear = staff ? isPvClear(series, staff.pvStatus) : false;

    return {
      staffCode: staff?.staffCode || 'STF-1029',
      pipelineStage: staff?.pipelineStage || 'S2_VERIFY',
      series,
      stageName: PIPELINE_STAGE_LABELS[staff?.pipelineStage ?? 'S2_VERIFY'] ?? 'Unknown Stage',
      isVerified: tracksClear && pvClear,
    };
  }

  @Get('pipeline')
  @ApiOperation({
    summary: 'Full stage-by-stage pipeline progress (read-only) — every stage with completed/current/pending status',
    description:
      'Returns all 6 forward FSM stages built from real PipelineEvent history. Matches the app\'s ' +
      'List<PipelineStage> model exactly (snake_case completed_at) — this is the endpoint the app\'s ' +
      'pipeline-progress timeline screen expects.',
  })
  async getPipeline(@Req() req: any) {
    const staff = await this.prisma.staffApplicant.findFirst({
      where: { userId: req.user.id },
    });
    return this.buildPipelineProgress(staff);
  }

  @Get('deployment')
  @ApiOperation({ summary: 'Get assigned client placement details' })
  async getDeployment(@Req() req: any) {
    const staff = await this.prisma.staffApplicant.findFirst({
      where: { userId: req.user.id },
    });
    if (!staff) {
      return { hasActivePlacement: false };
    }

    const placement = await this.prisma.placement.findFirst({
      where: { staffId: staff.id },
      orderBy: { createdAt: 'desc' },
      include: { branch: true },
    });
    if (!placement) {
      return { hasActivePlacement: false };
    }

    // Placement.clientId has no declared Prisma relation — assumption: it
    // targets finance_customers (the table Placement/invoicing elsewhere in
    // rm.service.ts treats as "the client"). Falls back gracefully if not found.
    const client = await this.prisma.financeCustomer
      .findUnique({ where: { id: placement.clientId } })
      .catch(() => null);

    return {
      hasActivePlacement: true,
      placementId: placement.id,
      clientName: client?.customerName ?? 'Client',
      clientPhone: null,
      deploymentAddress: client?.address ?? placement.branch?.name ?? null,
      deploymentDate: placement.trialStartDate?.toISOString() ?? placement.createdAt.toISOString(),
      trialStatus: placement.status,
    };
  }

  @Post('attendance/check-in')
  @ApiOperation({
    summary: 'Submit staff check-in with GPS',
    description:
      'Requires a CONFIRMED placement — writes a real ShiftLog row (same table RM\'s /rm/shifts review ' +
      'reads) and is immediately billable: attendance is staff-owned, so this auto-approves and syncs ' +
      'straight to StaffDailyAttendance rather than waiting on RM review. RM can still retroactively ' +
      'reject a fraudulent/incorrect day via PATCH /rm/shifts/:id/review, which un-syncs it.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', example: 28.5355 },
        longitude: { type: 'number', example: 77.3910 },
      },
    },
  })
  async checkIn(@Req() req: any, @Body() body: any) {
    const staff = await this.prisma.staffApplicant.findFirst({ where: { userId: req.user.id } });
    if (!staff) throw new BadRequestException('No staff record linked to this account');

    const placement = await this.prisma.placement.findFirst({
      where: { staffId: staff.id, status: 'CONFIRMED' },
      orderBy: { createdAt: 'desc' },
    });
    if (!placement) throw new BadRequestException('No confirmed placement — cannot check in yet');

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const shift = await this.prisma.shiftLog.upsert({
      where: { staffId_shiftDate: { staffId: staff.id, shiftDate: today } },
      create: {
        staffId: staff.id,
        placementId: placement.id,
        shiftDate: today,
        checkInAt: new Date(),
        checkInLat: body.latitude,
        checkInLng: body.longitude,
        status: 'APPROVED',
      },
      update: {
        checkInAt: new Date(),
        checkInLat: body.latitude,
        checkInLng: body.longitude,
        status: 'APPROVED',
      },
    });

    // Same sync reviewShift() does on APPROVED — attendance is billable the
    // moment staff checks in, no RM action required.
    // Keyed by placement too — a maid can check in at a second house the same
    // day, and each day belongs to the client whose invoice will carry it.
    // See docs/HOURLY_MULTI_CLIENT_PLAN.md §S1.
    await this.prisma.staffDailyAttendance.upsert({
      where: {
        staffId_placementId_attendanceDate: {
          staffId: staff.id, placementId: placement.id, attendanceDate: today,
        },
      },
      create: {
        staffId: staff.id,
        placementId: placement.id,
        branchId: placement.branchId,
        attendanceDate: today,
        status: 'PRESENT',
        markedBy: req.user.id,
      },
      update: {
        status: 'PRESENT',
        branchId: placement.branchId,
        markedBy: req.user.id,
      },
    }).catch(() => undefined);

    return {
      success: true,
      attendanceId: shift.id,
      status: 'CHECKED_IN',
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      timestamp: shift.checkInAt?.toISOString(),
    };
  }

  @Post('attendance/check-out')
  @ApiOperation({
    summary: 'Submit staff check-out with GPS',
    description: 'Updates today\'s real ShiftLog row (requires a prior check-in today).',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', example: 28.5355 },
        longitude: { type: 'number', example: 77.3910 },
      },
    },
  })
  async checkOut(@Req() req: any, @Body() body: any) {
    const staff = await this.prisma.staffApplicant.findFirst({ where: { userId: req.user.id } });
    if (!staff) throw new BadRequestException('No staff record linked to this account');

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const existing = await this.prisma.shiftLog.findUnique({
      where: { staffId_shiftDate: { staffId: staff.id, shiftDate: today } },
    });
    if (!existing || !existing.checkInAt) {
      throw new BadRequestException('No check-in found for today — check in before checking out');
    }

    const shift = await this.prisma.shiftLog.update({
      where: { staffId_shiftDate: { staffId: staff.id, shiftDate: today } },
      data: {
        checkOutAt: new Date(),
        checkOutLat: body.latitude,
        checkOutLng: body.longitude,
      },
    });

    return {
      success: true,
      attendanceId: shift.id,
      status: 'CHECKED_OUT',
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      timestamp: shift.checkOutAt?.toISOString(),
    };
  }

  @Get('attendance/history')
  @ApiOperation({ summary: 'Fetch past attendance history (real ShiftLog records)' })
  async getAttendanceHistory(@Req() req: any) {
    const staff = await this.prisma.staffApplicant.findFirst({ where: { userId: req.user.id } });
    if (!staff) return { history: [] };

    const shifts = await this.prisma.shiftLog.findMany({
      where: { staffId: staff.id },
      orderBy: { shiftDate: 'desc' },
      take: 30,
    });

    return {
      history: shifts.map((s) => ({
        date: s.shiftDate.toISOString().slice(0, 10),
        check_in: s.checkInAt?.toISOString() ?? null,
        check_out: s.checkOutAt?.toISOString() ?? null,
        status: s.checkInAt && s.checkOutAt ? 'present' : s.checkInAt ? 'in_progress' : 'absent',
        location: s.checkInLat && s.checkInLng ? `${s.checkInLat},${s.checkInLng}` : null,
      })),
    };
  }

  /**
   * What this staff member was paid, from `payroll_records` — the one payroll
   * engine, and the same rows the client's invoice is built from. A staff
   * member and their client therefore cannot be shown different numbers.
   *
   * A maid working three houses is paid once, so one month is one figure with
   * the houses named underneath it, not three payslips.
   */
  private async payMonths(staffId: string) {
    const rows = await this.prisma.payrollRecord.findMany({
      where: { staffId },
      orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }],
    });
    if (!rows.length) return [];

    const placementIds = [...new Set(rows.map((r) => r.placementId).filter(Boolean))] as string[];
    const placements = placementIds.length
      ? await this.prisma.placement.findMany({
          where: { id: { in: placementIds } },
          select: { id: true, clientId: true, placementType: true },
        })
      : [];
    const clients = placements.length
      ? await this.prisma.financeCustomer.findMany({
          where: { id: { in: [...new Set(placements.map((p) => p.clientId))] } },
          select: { id: true, customerName: true },
        })
      : [];
    const placementById = new Map(placements.map((p) => [p.id, p]));
    const clientName = new Map(clients.map((c) => [c.id, c.customerName]));

    const byPeriod = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.periodYear}-${r.periodMonth}`;
      const bucket = byPeriod.get(key);
      if (bucket) bucket.push(r);
      else byPeriod.set(key, [r]);
    }

    return [...byPeriod.values()].map((group) => {
      const num = (v: unknown) => Number(v ?? 0);
      const gross = group.reduce((s, r) => s + num(r.grossSalary), 0);
      const net = group.reduce((s, r) => s + num(r.netSalary), 0);
      const esic = group.reduce((s, r) => s + num(r.esicEmployee), 0);
      const pf = group.reduce((s, r) => s + num(r.pfEmployee), 0);
      const round2 = (n: number) => Math.round(n * 100) / 100;

      return {
        period_month: group[0].periodMonth,
        period_year: group[0].periodYear,
        days_worked: group.reduce((s, r) => s + Number(r.shiftDays ?? 0), 0),
        gross_salary: round2(gross),
        esic_employee: round2(esic),
        pf_employee: round2(pf),
        total_deductions: round2(gross - net),
        net_salary: round2(net),
        // PENDING until Finance approves it. Saying so stops "why is my money
        // not here yet" being a mystery.
        status: group.every((r) => r.status === 'PAID')
          ? 'PAID'
          : group.every((r) => r.status === 'APPROVED' || r.status === 'PAID')
            ? 'APPROVED'
            : 'PENDING',
        houses: group.map((r) => {
          const p = r.placementId ? placementById.get(r.placementId) : undefined;
          return {
            client_name: p ? clientName.get(p.clientId) ?? 'Client' : 'Client',
            placement_type: p?.placementType ?? 'PERMANENT',
            worked: p?.placementType === 'TEMPORARY'
              ? plural(Number(r.hoursWorked ?? 0), 'hour')
              : plural(Number(r.shiftDays ?? 0), 'day'),
            gross_salary: round2(num(r.grossSalary)),
          };
        }),
      };
    });
  }

  @Get('salary')
  @Roles(UserRole.STAFF, UserRole.RM, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({
    summary: 'This month’s pay, and what it is made of',
    description:
      'Reads payroll_records — the same rows the client is invoiced from. Returns the ' +
      'latest month by default; pass month and year for an older one. `houses` names ' +
      'every client the month’s pay came from.',
  })
  async getSalary(
    @Req() req: any,
    @Query('month') month?: string,
    @Query('year') year?: string,
  ) {
    const staff = await this.prisma.staffApplicant.findFirst({ where: { userId: req.user.id } });
    if (!staff) return { salary: null, message: 'No staff record is linked to this login.' };

    const months = await this.payMonths(staff.id);
    if (!months.length) {
      return { salary: null, message: 'No payroll has been run for you yet.' };
    }
    const wanted = month && year
      ? months.find((m) => m.period_month === Number(month) && m.period_year === Number(year))
      : months[0];

    return {
      salary: wanted ?? null,
      ...(wanted ? {} : { message: `No payroll for ${month}/${year}.` }),
    };
  }

  @Get('payslips')
  @Roles(UserRole.STAFF, UserRole.RM, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Every month this staff member has been paid for',
    description: 'Newest first. Each entry carries the same shape as GET /staff/salary.',
  })
  async getPayslips(@Req() req: any) {
    const staff = await this.prisma.staffApplicant.findFirst({ where: { userId: req.user.id } });
    if (!staff) return { payslips: [], total: 0 };
    const months = await this.payMonths(staff.id);
    return { payslips: months, total: months.length };
  }

  @Get('payslips/pdf')
  @Roles(UserRole.STAFF, UserRole.RM, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({
    summary: 'One month’s payslip as a PDF',
    description:
      'Renders the same document HR downloads, so a staff member and the office are ' +
      'never looking at two different payslips.',
  })
  async getPayslipPdf(
    @Req() req: any,
    @Res() res: Response,
    @Query('month') month?: string,
    @Query('year') year?: string,
  ) {
    const staff = await this.prisma.staffApplicant.findFirst({ where: { userId: req.user.id } });
    if (!staff) throw new BadRequestException('No staff record is linked to this login.');

    const employee = await this.prisma.employee.findFirst({
      where: { staffApplicantId: staff.id, deletedAt: null },
      select: { id: true },
    });
    if (!employee) {
      throw new BadRequestException(
        'Your employment record is not set up yet, so a payslip cannot be issued. Ask HR to complete onboarding.',
      );
    }

    const slips = await this.payslips.listForEmployee(employee.id);
    const items: { ref: string; periodMonth: number; periodYear: number }[] =
      (slips as any)?.items ?? (Array.isArray(slips) ? slips : []);
    const wanted = month && year
      ? items.find((s) => s.periodMonth === Number(month) && s.periodYear === Number(year))
      : items[0];
    if (!wanted) {
      throw new BadRequestException(
        month && year ? `No payslip for ${month}/${year}.` : 'No payslip has been issued for you yet.',
      );
    }

    const { buffer, filename } = await this.payslips.renderPdf(employee.id, wanted.ref);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  /** The staff record behind the token, or a clear refusal. */
  private async requireStaff(req: any) {
    const staff = await this.prisma.staffApplicant.findFirst({ where: { userId: req.user.id } });
    if (!staff) throw new BadRequestException('No staff record is linked to this login.');
    return staff;
  }

  @Get('bank-account')
  @ApiOperation({
    summary: 'Where this staff member is paid',
    description:
      'The account number is masked — the app only needs to show which account it is, ' +
      'and a full number on a phone screen is a liability.',
  })
  async getBankAccount(@Req() req: any) {
    const staff = await this.requireStaff(req);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT account_holder_name, account_number, ifsc, bank_name, is_verified, verified_at
        FROM staff_bank_accounts WHERE staff_id = ${staff.id}::uuid
       ORDER BY created_at DESC LIMIT 1`;
    if (!rows.length) {
      return { bankAccount: null, message: 'No bank account on record yet. Add one to be paid.' };
    }
    const b = rows[0];
    const acc = String(b.account_number ?? '');
    return {
      bankAccount: {
        accountHolderName: b.account_holder_name,
        accountNumberMasked: acc.length > 4 ? `${'X'.repeat(acc.length - 4)}${acc.slice(-4)}` : acc,
        last4: acc.slice(-4),
        ifsc: b.ifsc,
        bankName: b.bank_name,
        verified: b.is_verified,
        verifiedAt: b.verified_at,
      },
    };
  }

  @Put('bank-account')
  @ApiOperation({
    summary: 'Add or replace the account this staff member is paid into',
    description:
      'Saving a new account clears the verified flag — a changed account has not been ' +
      'checked, and paying into an unverified one on the strength of the old check is ' +
      'how money goes to the wrong place.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['account_holder_name', 'account_number', 'ifsc'],
      properties: {
        account_holder_name: { type: 'string', example: 'Anamika Devi' },
        account_number: { type: 'string', example: '50100123456789' },
        ifsc: { type: 'string', example: 'HDFC0000133' },
        bank_name: { type: 'string', example: 'HDFC Bank' },
      },
    },
  })
  async saveBankAccount(@Req() req: any, @Body() body: any) {
    const staff = await this.requireStaff(req);
    const holder = String(body?.account_holder_name ?? '').trim();
    const account = String(body?.account_number ?? '').replace(/\s+/g, '');
    const ifsc = String(body?.ifsc ?? '').trim().toUpperCase();

    if (!holder) throw new BadRequestException('The account holder’s name is required.');
    if (!/^\d{9,18}$/.test(account)) {
      throw new BadRequestException('An account number is 9 to 18 digits.');
    }
    // The RBI format: four letters, a zero, then the branch code.
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
      throw new BadRequestException('That IFSC does not look right — it is 11 characters, like HDFC0000133.');
    }

    await this.prisma.$executeRaw`
      DELETE FROM staff_bank_accounts WHERE staff_id = ${staff.id}::uuid`;
    await this.prisma.$executeRaw`
      INSERT INTO staff_bank_accounts
        (id, staff_id, account_holder_name, account_number, ifsc, bank_name,
         is_verified, created_by, created_at, updated_at)
      VALUES (gen_random_uuid(), ${staff.id}::uuid, ${holder}, ${account}, ${ifsc},
              ${body?.bank_name ?? null}, false, ${req.user.id}::uuid, now(), now())`;

    return {
      saved: true,
      verified: false,
      message: 'Account saved. It has to be verified before a payout can go to it.',
    };
  }

  @Get('agreement')
  @ApiOperation({
    summary: 'This staff member’s agreements',
    description:
      'Read-only. Signing goes through /agreements/:id/sign with its OTP flow — that ' +
      'lives in the agreements module and is not duplicated here.',
  })
  async getAgreements(@Req() req: any) {
    const staff = await this.requireStaff(req);
    const rows = await this.prisma.agreement.findMany({
      where: { staffId: staff.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, type: true, status: true, pdfUrl: true,
        otpVerified: true, createdAt: true, updatedAt: true,
      },
    });
    return {
      agreements: rows.map((a) => ({
        id: a.id,
        type: a.type,
        status: a.status,
        signed: a.status === 'SIGNED',
        pdfUrl: a.pdfUrl,
        otpVerified: a.otpVerified,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
      /** Everything below S5 needs a signed one before deployment. */
      hasSigned: rows.some((a) => a.status === 'SIGNED'),
      signAt: '/agreements/{id}/sign',
    };
  }

  @Get('video-certification')
  @ApiOperation({
    summary: 'This staff member’s video certification, and what is left',
    description:
      'Recording and uploading live in the /video-cert module; this says where they ' +
      'stand, which is what the app’s own screen needs.',
  })
  async getVideoCertification(@Req() req: any) {
    const staff = await this.requireStaff(req);
    const rows = await this.prisma.videoCertification.findMany({
      where: { staffId: staff.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, promptKey: true, reviewStatus: true, attemptNumber: true, createdAt: true },
    });

    const seriesShort = STAFF_SERIES_SHORT[staff.series] ?? 'MAID';
    const required = REQUIRED_VIDEO_PROMPTS[seriesShort] ?? 9;
    const approved = new Set(
      rows.filter((r) => r.reviewStatus === 'APPROVED').map((r) => r.promptKey),
    ).size;

    return {
      required,
      approved,
      complete: approved >= required,
      submissions: rows.map((r) => ({
        id: r.id,
        promptKey: r.promptKey,
        reviewStatus: r.reviewStatus,
        attempt: r.attemptNumber,
        submittedAt: r.createdAt,
      })),
      recordAt: '/video-cert',
    };
  }

  @Get('notifications')
  @ApiOperation({
    summary: 'This staff member’s in-app notifications',
    description:
      'The same rows /notifications/in-app serves, scoped to the caller, so the app ' +
      'does not have to know about a second module.',
  })
  async getNotifications(@Req() req: any) {
    const rows = await this.prisma.notification.findMany({
      where: { userId: req.user.id, channel: 'IN_APP' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      notifications: rows.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        read: n.readAt !== null,
        sentAt: n.sentAt ?? n.createdAt,
      })),
      unread: rows.filter((n) => n.readAt === null).length,
    };
  }
}
