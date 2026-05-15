import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Reports & Analytics')
@ApiBearerAuth()
@Controller({ path: 'reports', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('revenue')
  @Roles(UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Get revenue report' })
  async getRevenue(@Query('startDate') start: string, @Query('endDate') end: string) {
    return this.reportsService.getRevenueAnalytics(start, end);
  }

  @Get('staff-distribution')
  @Roles(UserRole.ADMIN, UserRole.BM)
  @ApiOperation({ summary: 'Get staff distribution report' })
  async getStaffDistribution() {
    return this.reportsService.getStaffDistribution();
  }

  @Get('placement-metrics')
  @Roles(UserRole.ADMIN, UserRole.BM)
  @ApiOperation({ summary: 'Get placement funnel metrics' })
  async getPlacementMetrics() {
    return this.reportsService.getPlacementMetrics();
  }
}
