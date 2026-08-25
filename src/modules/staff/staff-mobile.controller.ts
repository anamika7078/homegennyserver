import { Controller, Get, Post, Put, Body, UseGuards, Req, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';

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

/** Verification tracks (beyond Police Verification, tracked separately via pvStatus) required per series before S2 is considered complete. */
const REQUIRED_VERIFICATION_TRACKS: Record<string, string[]> = {
  DR: ['AADHAAR_EKYC', 'SARATHI_API', 'ECHALLAN_API', 'HEALTH_SCREENING'],
  SC: ['AADHAAR_EKYC', 'HEALTH_SCREENING'],
  UC: ['AADHAAR_EKYC'],
  MAID: ['AADHAAR_EKYC'],
};

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
  constructor(private readonly prisma: PrismaService) {}

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
    await this.prisma.staffDailyAttendance.upsert({
      where: { staffId_attendanceDate: { staffId: staff.id, attendanceDate: today } },
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
        placementId: placement.id,
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
}
