import { Controller, Get, Post, Param, Body, UseGuards, UseInterceptors, Req, BadRequestException } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { IncidentsService } from '../incidents/incidents.service';
import { CLIENT_VISIBLE_INVOICE_STATUSES } from '../../common/finance/invoice-status';

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

    // 'PENDING' stopped being a status when the invoice state machine went in
    // (F-12) and this query was never updated, so it matched nothing: the
    // client's dashboard showed "0 invoices, ₹0 outstanding" however much they
    // owed. Unpaid means sent and not yet settled — PAID is done and
    // CREDIT_NOTE has been reversed.
    const [placementsCount, unpaidInvoices, placement] = await Promise.all([
      this.prisma.placement.count({ where: { clientId: customer.id, status: 'CONFIRMED' } }),
      this.prisma.invoice.findMany({
        where: {
          clientId: customer.id,
          status: { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] },
        },
      }),
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
      pendingInvoicesCount: unpaidInvoices.length,
      totalUnpaidAmount:
        Math.round(unpaidInvoices.reduce((sum, i) => sum + Number(i.totalAmount), 0) * 100) / 100,
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

    // Only what has actually been sent to them. There was no filter here at
    // all, so a DRAFT reached the client's phone the moment Finance created
    // it, and a cancelled one never left. See CLIENT_VISIBLE_INVOICE_STATUSES.
    const invoices = await this.prisma.invoice.findMany({
      where: { clientId: customer.id, status: { in: CLIENT_VISIBLE_INVOICE_STATUSES } },
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
    summary: 'Request that a staff member be replaced',
    description:
      'Recorded against the client and, where given, the placement — so the RM has ' +
      'something to work from and the client can look it up again. This used to return ' +
      'a made-up ticket number and write nothing anywhere.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', example: 'Frequently late, and the work is not to standard' },
        placement_id: { type: 'string', description: 'Which placement — required once more than one staff member is placed' },
        preferred_date: { type: 'string', example: '2026-10-01', description: 'When they would like the change' },
      },
    },
  })
  async requestReplacement(@Req() req: any, @Body() body: any) {
    const customer = await this.resolveCustomer(req.user.id);
    if (!customer) throw new BadRequestException('No client account is linked to this login.');

    const reason = String(body?.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Tell us why — the RM needs a reason to act on.');

    const active = await this.prisma.placement.findMany({
      where: { clientId: customer.id, status: { in: ['CONFIRMED', 'TRIAL'] } },
      select: { id: true, staffId: true, branchId: true, rmId: true },
    });
    if (!active.length) {
      throw new BadRequestException('Nobody is placed with you right now, so there is nobody to replace.');
    }

    // Naming the placement matters once more than one person works here —
    // otherwise the RM cannot tell who is being complained about.
    let placement = active.length === 1 ? active[0] : undefined;
    if (body?.placement_id) {
      placement = active.find((p) => p.id === body.placement_id);
      if (!placement) throw new BadRequestException('That placement is not one of yours.');
    }
    if (!placement) {
      throw new BadRequestException(
        `${active.length} staff are placed with you — send placement_id to say which one.`,
      );
    }

    const [row] = await this.prisma.$queryRaw<{ id: string; status: string; created_at: Date }[]>`
      INSERT INTO replacement_requests
        (client_id, placement_id, staff_id, branch_id, rm_id, reason, preferred_date, raised_by)
      VALUES (${customer.id}::uuid, ${placement.id}::uuid, ${placement.staffId}::uuid,
              ${placement.branchId}::uuid, ${placement.rmId ?? null}::uuid, ${reason},
              ${body?.preferred_date ? new Date(body.preferred_date) : null}::date,
              ${req.user.id}::uuid)
      RETURNING id, status, created_at`;

    return {
      success: true,
      requestId: row.id,
      status: row.status,
      raisedAt: row.created_at,
      message: 'Replacement request recorded. Your RM can see it and will be in touch.',
    };
  }

  @Get('replacements')
  @ApiOperation({ summary: 'Replacement requests this client has raised, newest first' })
  async listReplacements(@Req() req: any) {
    const customer = await this.resolveCustomer(req.user.id);
    if (!customer) return { requests: [], total: 0 };

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT rr.id, rr.reason, rr.status, rr.preferred_date, rr.resolution,
             rr.resolved_at, rr.created_at, sa.full_name AS staff_name, sa.staff_code
        FROM replacement_requests rr
        LEFT JOIN staff_applicants sa ON sa.id = rr.staff_id
       WHERE rr.client_id = ${customer.id}::uuid
       ORDER BY rr.created_at DESC`;

    return {
      requests: rows.map((r) => ({
        id: r.id,
        staffName: r.staff_name,
        staffCode: r.staff_code,
        reason: r.reason,
        status: r.status,
        preferredDate: r.preferred_date,
        resolution: r.resolution,
        resolvedAt: r.resolved_at,
        raisedAt: r.created_at,
      })),
      total: rows.length,
    };
  }

  @Get('complaints')
  @ApiOperation({
    summary: 'Complaints this client has raised, newest first',
    description:
      'A complaint is filed as an Incident, so this reads them back from there. ' +
      'The client could raise one and never see it again.',
  })
  async listComplaints(@Req() req: any) {
    const customer = await this.resolveCustomer(req.user.id);
    if (!customer) return { complaints: [], total: 0 };

    const rows = await this.prisma.incident.findMany({
      where: { clientId: customer.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, type: true, status: true, title: true, description: true,
        resolution: true, resolvedAt: true, createdAt: true,
        staff: { select: { fullName: true, staffCode: true } },
      },
    });

    return {
      complaints: rows.map((r) => ({
        ticketNumber: r.id,
        type: r.type,
        status: r.status,
        title: r.title,
        description: r.description,
        staffName: r.staff?.fullName ?? null,
        staffCode: r.staff?.staffCode ?? null,
        resolution: r.resolution,
        resolvedAt: r.resolvedAt,
        raisedAt: r.createdAt,
      })),
      total: rows.length,
    };
  }

  @Get('invoices/:id')
  @ApiOperation({
    summary: 'One invoice, with the line items behind the total',
    description:
      'Takes the invoice number the list returns (or the id). A client could see what ' +
      'they owed but never what it was made of.',
  })
  async getInvoiceDetail(@Req() req: any, @Param('id') id: string) {
    const customer = await this.resolveCustomer(req.user.id);
    if (!customer) throw new BadRequestException('No client account is linked to this login.');

    // The list hands out invoice_number as the id, so accept either — and scope
    // to this customer, so one client can never read another's bill.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const invoice = await this.prisma.invoice.findFirst({
      where: {
        clientId: customer.id,
        // The same rule as the list. Without it, knowing a number would open a
        // draft the client was never meant to see.
        status: { in: CLIENT_VISIBLE_INVOICE_STATUSES },
        ...(isUuid ? { id } : { invoiceNumber: id }),
      },
    });
    if (!invoice) throw new BadRequestException(`No invoice ${id} on your account.`);

    const items = await this.prisma.$queryRaw<any[]>`
      SELECT description, amount, is_taxable, staff_name, sac_code
        FROM invoice_items WHERE invoice_id = ${invoice.id}::uuid
       ORDER BY sort_order NULLS LAST, created_at`;

    const paid = await this.prisma.$queryRaw<{ total: string }[]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total
        FROM invoice_payments WHERE invoice_id = ${invoice.id}::uuid AND status = 'SUCCESS'`;
    const paidTotal = Number(paid[0]?.total ?? 0);

    return {
      id: invoice.invoiceNumber,
      invoiceId: invoice.id,
      documentType: invoice.documentType,
      billingMonth: `${invoice.periodMonth}/${invoice.periodYear}`,
      status: invoice.status,
      dueDate: invoice.dueDate,
      salaryComponent: Number(invoice.staffSalaryComponent),
      employerEsic: Number(invoice.esicEmployer),
      employerPf: Number(invoice.pfEmployer),
      managementFee: Number(invoice.managementFee),
      gstAmount: Number(invoice.gstAmount),
      totalAmount: Number(invoice.totalAmount),
      amountPaid: paidTotal,
      amountDue: Math.round((Number(invoice.totalAmount) - paidTotal) * 100) / 100,
      lineItems: items.map((i) => ({
        description: i.description,
        staffName: i.staff_name,
        amount: Number(i.amount),
        taxable: i.is_taxable,
        sacCode: i.sac_code,
      })),
    };
  }

  @Get('payments/history')
  @ApiOperation({ summary: 'Payments this client has made, newest first' })
  async getPaymentHistory(@Req() req: any) {
    const customer = await this.resolveCustomer(req.user.id);
    if (!customer) return { payments: [], total: 0, totalPaid: 0 };

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT ip.id, ip.amount, ip.payment_date, ip.payment_method, ip.transaction_id,
             ip.status, ci.invoice_number, ci.period_month, ci.period_year
        FROM invoice_payments ip
        JOIN client_invoices ci ON ci.id = ip.invoice_id
       WHERE ci.client_id = ${customer.id}::uuid
       ORDER BY ip.payment_date DESC`;

    return {
      payments: rows.map((r) => ({
        id: r.id,
        invoiceNumber: r.invoice_number,
        billingMonth: `${r.period_month}/${r.period_year}`,
        amount: Number(r.amount),
        paidOn: r.payment_date,
        method: r.payment_method,
        reference: r.transaction_id,
        status: r.status,
      })),
      total: rows.length,
      totalPaid: rows
        .filter((r) => r.status === 'SUCCESS')
        .reduce((s, r) => s + Number(r.amount), 0),
    };
  }

  @Get('notifications')
  @ApiOperation({
    summary: 'This client’s in-app notifications',
    description:
      'The same rows /notifications/in-app serves, scoped to the caller — so the app ' +
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
