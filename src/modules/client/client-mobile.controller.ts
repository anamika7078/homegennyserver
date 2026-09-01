import { Controller, Get, Post, Param, Body, UseGuards, UseInterceptors, Req, BadRequestException } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { IncidentsService } from '../incidents/incidents.service';

/**
 * Same series-based required-track logic used in staff-mobile.controller.ts, so a
 * client sees the same "verified" signal staff/RM do — kept as a local copy since
 * these are file-local consts there too (not currently exported/shared).
 *
 * Keyed by the StaffSeries enum values stored on staff.series
 * (MAID/SKILLED_CARE/UNSKILLED_CARE/DRIVER) — NOT the DR/SC/UC short codes the
 * mobile app displays. Keying this by the short codes previously made every lookup
 * below miss for non-MAID series, silently returning `requiredTracks: []` and making
 * `isVerified` true for staff with zero verification tracks on record.
 */
const REQUIRED_VERIFICATION_TRACKS: Record<string, string[]> = {
  DRIVER: ['AADHAAR_EKYC', 'SARATHI_API', 'ECHALLAN_API', 'HEALTH_SCREENING'],
  SKILLED_CARE: ['AADHAAR_EKYC', 'HEALTH_SCREENING'],
  UNSKILLED_CARE: ['AADHAAR_EKYC'],
  MAID: ['AADHAAR_EKYC'],
};

function isPvClear(seriesShort: string, pvStatus: string): boolean {
  if (seriesShort === 'MAID') return pvStatus !== 'ADVERSE';
  return pvStatus === 'CLEAR';
}

// ⚠️ IncidentType enum currently only has 6 values (CLIENT_COMPLAINT, STAFF_MISCONDUCT,
// SAFETY_ISSUE, ATTENDANCE_FRAUD, DRIVING_VIOLATION, LATE_EXIT) — a migration to add
// SCOPE_VIOLATION/ABSENTEEISM/CONDUCT/PROPERTY_DAMAGE/INVOICE_DISPUTE (matching the
// spec's client-complaint categories) is prepared at
// prisma/migrations/20260813000000_extend_incident_type/migration.sql but NOT applied
// yet — this DB user isn't the owner of the incident_type Postgres enum, needs a
// superuser/owner credential to run `ALTER TYPE incident_type ADD VALUE ...`. Until
// then, only the existing 6 values are accepted here.
const CLIENT_INCIDENT_TYPES = [
  'CLIENT_COMPLAINT', 'STAFF_MISCONDUCT', 'SAFETY_ISSUE', 'ATTENDANCE_FRAUD', 'DRIVING_VIOLATION', 'LATE_EXIT',
] as const;

@ApiTags('Client Mobile App', 'Mobile App Client APIs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.CLIENT, UserRole.RM, UserRole.BM, UserRole.ADMIN)
@Controller({ path: 'client', version: '1' })
export class ClientMobileController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly incidents: IncidentsService,
  ) {}

  private async resolveCustomer(userId: string) {
    return this.prisma.financeCustomer.findFirst({ where: { userId } });
  }

  @Get('profile')
  @ApiOperation({
    summary: "Client's own profile — matches the Flutter app's already-wired GET /client/profile call",
    description:
      '⚠️ payment_method/account_last4/upi_id have no backing schema anywhere in the DB — always null. ' +
      'Everything else (name/email/phone/address/city/pincode) is real FinanceCustomer data.',
  })
  async getProfile(@Req() req: any) {
    const customer = await this.resolveCustomer(req.user.id);
    return {
      name: customer?.customerName ?? req.user.fullName,
      email: req.user.email ?? null,
      phone: req.user.phone,
      address: customer?.address ?? null,
      city: customer?.city ?? null,
      pincode: customer?.pincode ?? null,
      payment_method: null,
      account_last4: null,
      upi_id: null,
    };
  }

  private async resolveActivePlacement(customerId: string) {
    return this.prisma.placement.findFirst({
      where: { clientId: customerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Get('dashboard')
  @ApiOperation({ summary: 'Client overview of attendance, active staff & pending payments' })
  async getDashboard(@Req() req: any) {
    const customer = await this.resolveCustomer(req.user.id);
    if (!customer) {
      return { customerName: req.user.fullName, activePlacementsCount: 0, todayAttendanceStatus: null, pendingInvoicesCount: 0, totalUnpaidAmount: 0 };
    }

    const [placementsCount, pendingInvoices, placement] = await Promise.all([
      this.prisma.placement.count({ where: { clientId: customer.id, status: 'CONFIRMED' } }),
      this.prisma.invoice.findMany({ where: { clientId: customer.id, status: 'PENDING' } }),
      this.resolveActivePlacement(customer.id),
    ]);

    let todayAttendanceStatus: string | null = null;
    if (placement) {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const shift = await this.prisma.shiftLog.findUnique({
        where: { staffId_shiftDate: { staffId: placement.staffId, shiftDate: today } },
      });
      todayAttendanceStatus = shift?.checkOutAt ? 'CHECKED_OUT' : shift?.checkInAt ? 'CHECKED_IN' : 'NOT_CHECKED_IN';
    }

    return {
      customerName: customer.customerName,
      activePlacementsCount: placementsCount,
      todayAttendanceStatus,
      pendingInvoicesCount: pendingInvoices.length,
      totalUnpaidAmount: pendingInvoices.reduce((sum, i) => sum + Number(i.totalAmount), 0),
    };
  }

  @Get('assigned-staff')
  @ApiOperation({ summary: 'List of staff deployed at client household' })
  async getAssignedStaff(@Req() req: any) {
    const customer = await this.resolveCustomer(req.user.id);
    if (!customer) return { assignedStaff: [] };

    const placements = await this.prisma.placement.findMany({
      where: { clientId: customer.id, status: { in: ['TRIAL', 'CONFIRMED'] } },
      orderBy: { createdAt: 'desc' },
    });
    const staffIds = placements.map((p) => p.staffId);
    const staffRows = await this.prisma.staffApplicant.findMany({ where: { id: { in: staffIds } } });
    const staffById = new Map(staffRows.map((s) => [s.id, s]));

    return {
      assignedStaff: placements.map((p) => {
        const s = staffById.get(p.staffId);
        return {
          staffId: p.staffId,
          staffCode: s?.staffCode ?? null,
          fullName: s?.fullName ?? null,
          series: s?.series ?? null,
          deploymentDate: p.trialStartDate?.toISOString() ?? p.createdAt.toISOString(),
          status: p.status === 'CONFIRMED' ? 'ACTIVE_DEPLOYED' : 'ON_TRIAL',
        };
      }),
    };
  }

  @Get('staff/:id/profile')
  @ApiOperation({ summary: 'Detailed view of assigned staff profile & verification status' })
  async getStaffDetail(@Param('id') id: string, @Req() req: any) {
    const customer = await this.resolveCustomer(req.user.id);
    if (customer) {
      const placement = await this.prisma.placement.findFirst({ where: { clientId: customer.id, staffId: id } });
      if (!placement) throw new BadRequestException('This staff member is not deployed to your placement');
    }

    const staff = await this.prisma.staffApplicant.findUnique({
      where: { id },
      include: { verificationTracks: true },
    });
    if (!staff) throw new BadRequestException('Staff record not found');

    const requiredTracks = REQUIRED_VERIFICATION_TRACKS[staff.series] ?? [];
    const tracksClear = requiredTracks.every((t) => staff.verificationTracks.some((v) => v.trackType === t && v.status === 'CLEAR'));

    return {
      staffId: staff.id,
      staffCode: staff.staffCode,
      fullName: staff.fullName,
      series: staff.series,
      isVerified: tracksClear && isPvClear(staff.series, staff.pvStatus),
      pvStatus: staff.pvStatus,
      videoCertAvailable: !!staff.videoCertId,
    };
  }

  @Get('attendance/today')
  @ApiOperation({ summary: "Real-time check-in/out status of assigned staff" })
  async getTodayAttendance(@Req() req: any) {
    const customer = await this.resolveCustomer(req.user.id);
    const placement = customer ? await this.resolveActivePlacement(customer.id) : null;
    if (!placement) return { staffCode: null, todayStatus: 'NO_ACTIVE_PLACEMENT' };

    const staff = await this.prisma.staffApplicant.findUnique({ where: { id: placement.staffId } });
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const shift = await this.prisma.shiftLog.findUnique({
      where: { staffId_shiftDate: { staffId: placement.staffId, shiftDate: today } },
    });

    return {
      staffCode: staff?.staffCode ?? null,
      staffName: staff?.fullName ?? null,
      todayStatus: shift?.checkOutAt ? 'CHECKED_OUT' : shift?.checkInAt ? 'PRESENT' : 'NOT_CHECKED_IN',
      checkInTime: shift?.checkInAt?.toISOString() ?? null,
      checkOutTime: shift?.checkOutAt?.toISOString() ?? null,
      gpsVerified: !!(shift?.checkInLat && shift?.checkInLng),
    };
  }

  @Get('attendance/history')
  @ApiOperation({ summary: 'Attendance history for the assigned staff' })
  async getAttendanceHistory(@Req() req: any) {
    const customer = await this.resolveCustomer(req.user.id);
    const placement = customer ? await this.resolveActivePlacement(customer.id) : null;
    if (!placement) return { totalPresent: 0, totalAbsent: 0, history: [] };

    const shifts = await this.prisma.shiftLog.findMany({
      where: { staffId: placement.staffId },
      orderBy: { shiftDate: 'desc' },
      take: 30,
    });

    return {
      totalPresent: shifts.filter((s) => s.checkInAt).length,
      totalAbsent: shifts.filter((s) => !s.checkInAt).length,
      history: shifts.map((s) => ({
        date: s.shiftDate.toISOString().slice(0, 10),
        status: s.checkInAt ? 'PRESENT' : 'ABSENT',
        checkIn: s.checkInAt?.toISOString() ?? null,
        checkOut: s.checkOutAt?.toISOString() ?? null,
      })),
    };
  }

  @Post('attendance/raise-issue')
  @ApiOperation({
    summary: 'Dispute an attendance log',
    description:
      'Files a real Incident (type ATTENDANCE_FRAUD) against the deployed staff — same table RM/BM review. ' +
      'staff_id is optional — defaults to the staff on your current active placement. title defaults to a ' +
      'generic label if omitted, so this also matches the app\'s simpler "raise an issue with a message" shape.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string', example: 'Check-in time does not match actual arrival' },
        staff_id: { type: 'string', description: 'Optional — defaults to your active placement\'s staff' },
        title: { type: 'string', description: 'Optional — defaults to "Attendance dispute"' },
        description: { type: 'string', description: 'Optional — defaults to message' },
      },
    },
  })
  async raiseAttendanceIssue(@Req() req: any, @Body() body: any) {
    const customer = await this.resolveCustomer(req.user.id);
    if (!customer) throw new BadRequestException('No customer account linked to this login');

    const placement = await this.resolveActivePlacement(customer.id);
    const staffId = body.staff_id ?? placement?.staffId;
    if (!staffId) throw new BadRequestException('No active placement to raise an attendance issue against');

    const incident = await this.incidents.fileByClient(
      {
        staffId,
        type: 'ATTENDANCE_FRAUD',
        title: body.title ?? 'Attendance dispute',
        description: body.description ?? body.message,
      },
      customer.id,
      req.user.id,
    );
    return { success: true, ticketId: incident.id, message: 'Attendance dispute logged. Relationship Manager notified.' };
  }

  @Get('invoices')
  @ApiOperation({ summary: 'List generated invoices for client' })
  async getInvoices(@Req() req: any) {
    const customer = await this.resolveCustomer(req.user.id);
    if (!customer) return { invoices: [] };

    const invoices = await this.prisma.invoice.findMany({
      where: { clientId: customer.id },
      orderBy: { dueDate: 'desc' },
    });

    // Employer ESIC/PF are part of what the client is billed, so leaving them
    // out made the four numbers below add up to less than totalAmount — on the
    // screen the paying customer actually looks at. Same defect as F-03 on the
    // Finance console, on a worse surface. See docs/FINANCE_MODULE_AUDIT.md.
    return {
      invoices: invoices.map((i) => ({
        id: i.invoiceNumber,
        billingMonth: `${i.periodMonth}/${i.periodYear}`,
        salaryComponent: Number(i.staffSalaryComponent),
        employerEsic: Number(i.esicEmployer),
        employerPf: Number(i.pfEmployer),
        managementFee: Number(i.managementFee),
        gstAmount: Number(i.gstAmount),
        totalAmount: Number(i.totalAmount),
        status: i.status,
        dueDate: i.dueDate.toISOString(),
      })),
    };
  }

  @Post('complaints')
  @UseInterceptors(AnyFilesInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Raise a client complaint',
    description:
      'Files a real Incident against the deployed staff — visible to RM/BM review queues. ' +
      'Multipart form — matches the Flutter app\'s exact ClientRemoteDataSource.raiseComplaint() shape: ' +
      'subject + description (+ optional images[]). staff_id/type/title are optional overrides for direct ' +
      'API testing — staff_id defaults to your active placement\'s staff, title defaults to subject, ' +
      'type defaults to CLIENT_COMPLAINT. Uploaded images are accepted but not yet persisted (no storage ' +
      'wired here — evidenceUrls stays empty for file uploads; pass evidence_urls as plain string URLs instead).',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['subject', 'description'],
      properties: {
        subject: { type: 'string', example: 'Staff arrived 2 hours late without notice' },
        description: { type: 'string' },
        images: { type: 'array', items: { type: 'string', format: 'binary' } },
        staff_id: { type: 'string', description: 'Optional — defaults to your active placement\'s staff' },
        type: { type: 'string', enum: CLIENT_INCIDENT_TYPES as unknown as string[], example: 'CLIENT_COMPLAINT', description: 'Optional — defaults to CLIENT_COMPLAINT' },
        title: { type: 'string', description: 'Optional — defaults to subject' },
        evidence_urls: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  async raiseComplaint(@Req() req: any, @Body() body: any) {
    const customer = await this.resolveCustomer(req.user.id);
    if (!customer) throw new BadRequestException('No customer account linked to this login');

    const placement = await this.resolveActivePlacement(customer.id);
    const staffId = body.staff_id ?? placement?.staffId;
    if (!staffId) throw new BadRequestException('No active placement to file a complaint against');

    const type = CLIENT_INCIDENT_TYPES.includes(body.type) ? body.type : 'CLIENT_COMPLAINT';
    const title = body.title ?? body.subject ?? 'Client complaint';
    const evidenceUrls = Array.isArray(body.evidence_urls) ? body.evidence_urls : undefined;

    const incident = await this.incidents.fileByClient(
      { staffId, type, title, description: body.description, evidenceUrls },
      customer.id,
      req.user.id,
    );
    return { success: true, ticketNumber: incident.id, status: incident.status, message: 'Complaint submitted to RM and Branch Manager.' };
  }

  @Post('replacements')
  @ApiOperation({
    summary: 'Request staff replacement',
    description: '⚠️ Not yet persisted — no Replacement/ExitRequest schema exists yet. Deferred to a follow-up pass (needs a new Prisma model + migration).',
  })
  async requestReplacement(@Body() body: any) {
    return {
      success: true,
      requestId: `REQ_REPLACE_${Date.now()}`,
      status: 'UNDER_RM_REVIEW',
      message: 'Staff replacement request initiated. RM will contact you within 24 hours.',
    };
  }
}
