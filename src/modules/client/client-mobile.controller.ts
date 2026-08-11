import { Controller, Get, Post, Param, Body, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('Client Mobile App')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.CLIENT, UserRole.RM, UserRole.BM, UserRole.ADMIN)
@Controller({ path: 'client', version: '1' })
export class ClientMobileController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Client Overview of attendance, active staff & pending payments' })
  async getDashboard(@Req() req: any) {
    return {
      customerName: req.user.fullName || 'Rohan Sharma',
      activePlacementsCount: 1,
      todayAttendanceStatus: 'CHECKED_IN (09:02 AM)',
      pendingInvoicesCount: 0,
      totalUnpaidAmount: 0,
    };
  }

  @Get('assigned-staff')
  @ApiOperation({ summary: 'List of staff deployed at client household' })
  async getAssignedStaff(@Req() req: any) {
    return {
      assignedStaff: [
        {
          staffId: 'usr_staff_9921',
          staffCode: 'STF-1029',
          fullName: 'Pooja Mishra',
          series: 'MAID',
          deploymentDate: '2026-05-01',
          status: 'ACTIVE_DEPLOYED',
        },
      ],
    };
  }

  @Get('staff/:id/profile')
  @ApiOperation({ summary: 'Detailed view of assigned staff profile & skills' })
  async getStaffDetail(@Param('id') id: string) {
    return {
      staffId: id,
      staffCode: 'STF-1029',
      fullName: 'Pooja Mishra',
      series: 'MAID',
      experienceYears: 4,
      languagesSpoken: ['Hindi', 'English'],
      skills: ['Household Sanitation', 'Cooking', 'Elder Assistance'],
      videoCertAvailable: true,
      performanceRating: 4.8,
    };
  }

  @Get('attendance/today')
  @ApiOperation({ summary: 'Real-time check-in/out status of assigned staff' })
  async getTodayAttendance() {
    return {
      staffCode: 'STF-1029',
      staffName: 'Pooja Mishra',
      todayStatus: 'PRESENT',
      checkInTime: '09:02 AM',
      checkOutTime: null,
      gpsVerified: true,
    };
  }

  @Get('attendance/history')
  @ApiOperation({ summary: 'Monthly attendance calendar view' })
  async getAttendanceHistory() {
    return {
      month: 'August 2026',
      totalPresent: 9,
      totalAbsent: 0,
      history: [
        { date: '2026-08-10', status: 'PRESENT', checkIn: '09:00 AM', checkOut: '06:00 PM' },
        { date: '2026-08-09', status: 'PRESENT', checkIn: '09:02 AM', checkOut: '06:01 PM' },
      ],
    };
  }

  @Post('attendance/raise-issue')
  @ApiOperation({ summary: 'Dispute an attendance log' })
  async raiseAttendanceIssue(@Body() body: any) {
    return {
      success: true,
      ticketId: `TKT_${Date.now()}`,
      message: 'Attendance dispute logged. Relationship Manager notified.',
    };
  }

  @Get('invoices')
  @ApiOperation({ summary: 'List generated invoices for client' })
  async getInvoices() {
    return {
      invoices: [
        {
          id: 'INV-2026-07-001',
          billingMonth: 'July 2026',
          salaryComponent: 18500,
          managementFee: 2500,
          gstAmount: 450,
          totalAmount: 21450,
          status: 'PAID',
          pdfDownloadUrl: '/api/v1/finance/invoices/INV-2026-07-001/pdf',
        },
      ],
    };
  }

  @Post('complaints')
  @ApiOperation({ summary: 'Raise a client complaint' })
  async raiseComplaint(@Body() body: any) {
    return {
      success: true,
      ticketNumber: `INC-${Date.now()}`,
      status: 'OPEN',
      message: 'Complaint submitted to RM and Branch Manager.',
    };
  }

  @Post('replacements')
  @ApiOperation({ summary: 'Request staff replacement' })
  async requestReplacement(@Body() body: any) {
    return {
      success: true,
      requestId: `REQ_REPLACE_${Date.now()}`,
      status: 'UNDER_RM_REVIEW',
      message: 'Staff replacement request initiated. RM will contact you within 24 hours.',
    };
  }
}
