import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { AssessorsService } from './assessors.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('Assessors')
@ApiBearerAuth()
@Controller({ path: 'assessors', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ASSESSOR, UserRole.ADMIN)
export class AssessorsController {
  constructor(private readonly assessorsService: AssessorsService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Assessor dashboard KPIs + driver/SC queues' })
  getDashboard(@Req() req: any) {
    const assessorId = req.user?.role === 'ASSESSOR' ? req.user.id : undefined;
    return this.assessorsService.getDashboardStats(assessorId);
  }

  @Get('assessments')
  @ApiOperation({ summary: 'Pending assessments queue for this assessor' })
  getPendingAssessments(@Req() req: any) {
    const assessorId = req.user?.role === 'ASSESSOR' ? req.user.id : undefined;
    return this.assessorsService.getPendingAssessments(assessorId);
  }

  @Get('schedules')
  @ApiOperation({ summary: 'Upcoming assessment schedule slots' })
  getSchedules(@Req() req: any) {
    const assessorId = req.user?.role === 'ASSESSOR' ? req.user.id : undefined;
    return this.assessorsService.getSchedules(assessorId);
  }

  @Get('reports')
  @ApiOperation({ summary: 'Pass/fail analytics and weekly trend' })
  getReports(@Req() req: any) {
    const assessorId = req.user?.role === 'ASSESSOR' ? req.user.id : undefined;
    return this.assessorsService.getReports(assessorId);
  }
}
