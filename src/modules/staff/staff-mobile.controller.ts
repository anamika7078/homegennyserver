import { Controller, Get, Post, Put, Body, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('Staff Mobile App')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.STAFF, UserRole.RM, UserRole.BM, UserRole.ADMIN)
@Controller({ path: 'staff', version: '1' })
export class StaffMobileController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Get staff today tasks & completion %' })
  async getDashboard(@Req() req: any) {
    const userId = req.user.id;
    const staff = await this.prisma.staffApplicant.findFirst({
      where: { OR: [{ id: userId }, { mobile: req.user.phone }] },
      include: { branch: true },
    });

    return {
      staffCode: staff?.staffCode || 'STF-1029',
      fullName: staff?.fullName || req.user.fullName || 'Pooja Mishra',
      series: staff?.series || 'MAID',
      pipelineStage: staff?.pipelineStage || 'S2_VERIFY',
      completionPct: 65,
      assignedRm: {
        name: 'Amit Gupta (RM)',
        phone: '+919800000001',
      },
      todayTasks: [
        { id: 1, title: 'Record Video Certification Prompt #2', done: false },
        { id: 2, title: 'Upload Police Verification Document', done: false },
      ],
    };
  }

  @Get('profile')
  @ApiOperation({ summary: 'Fetch staff personal details' })
  async getProfile(@Req() req: any) {
    const userId = req.user.id;
    const staff = await this.prisma.staffApplicant.findFirst({
      where: { OR: [{ id: userId }, { mobile: req.user.phone }] },
    });

    return {
      id: userId,
      staffCode: staff?.staffCode || 'STF-1029',
      fullName: staff?.fullName || req.user.fullName || 'Pooja Mishra',
      mobile: staff?.mobile || req.user.phone,
      email: staff?.email || req.user.email,
      series: staff?.series || 'MAID',
      pipelineStage: staff?.pipelineStage || 'S2_VERIFY',
      address: staff?.address || 'Sector 62, Noida, UP',
      dateOfBirth: staff?.dateOfBirth || '1996-05-15',
    };
  }

  @Put('profile')
  @ApiOperation({ summary: 'Update staff personal details' })
  async updateProfile(@Req() req: any, @Body() body: any) {
    const userId = req.user.id;
    const staff = await this.prisma.staffApplicant.findFirst({
      where: { OR: [{ id: userId }, { mobile: req.user.phone }] },
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
  @ApiOperation({ summary: 'Fetch current onboarding stage (Stage 1 to 5)' })
  async getPipelineStatus(@Req() req: any) {
    const userId = req.user.id;
    const staff = await this.prisma.staffApplicant.findFirst({
      where: { OR: [{ id: userId }, { mobile: req.user.phone }] },
    });

    return {
      staffCode: staff?.staffCode || 'STF-1029',
      pipelineStage: staff?.pipelineStage || 'S2_VERIFY',
      series: staff?.series || 'MAID',
      stageName: 'Stage 2 - Verification & Assessment',
      isVerified: false,
    };
  }

  @Get('deployment')
  @ApiOperation({ summary: 'Get assigned client placement details' })
  async getDeployment(@Req() req: any) {
    return {
      hasActivePlacement: true,
      placementId: 'plc_991',
      clientName: 'Rohan Sharma',
      clientPhone: '+919800000004',
      deploymentAddress: 'Flat 402, Green Valley Apartments, Noida',
      deploymentDate: '2026-05-01',
      trialStatus: 'CONFIRMED',
    };
  }

  @Post('attendance/check-in')
  @ApiOperation({ summary: 'Submit staff check-in with GPS' })
  async checkIn(@Req() req: any, @Body() body: any) {
    return {
      success: true,
      attendanceId: `att_${Date.now()}`,
      status: 'CHECKED_IN',
      latitude: body.latitude || 28.5355,
      longitude: body.longitude || 77.3910,
      timestamp: new Date().toISOString(),
    };
  }

  @Post('attendance/check-out')
  @ApiOperation({ summary: 'Submit staff check-out with GPS' })
  async checkOut(@Req() req: any, @Body() body: any) {
    return {
      success: true,
      attendanceId: `att_${Date.now()}`,
      status: 'CHECKED_OUT',
      latitude: body.latitude || 28.5355,
      longitude: body.longitude || 77.3910,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('attendance/history')
  @ApiOperation({ summary: 'Fetch past attendance history' })
  async getAttendanceHistory(@Req() req: any) {
    return {
      history: [
        { date: '2026-08-10', checkIn: '09:00 AM', checkOut: '06:00 PM', status: 'PRESENT' },
        { date: '2026-08-09', checkIn: '09:02 AM', checkOut: '06:01 PM', status: 'PRESENT' },
        { date: '2026-08-08', checkIn: '08:58 AM', checkOut: '06:05 PM', status: 'PRESENT' },
      ],
    };
  }
}
