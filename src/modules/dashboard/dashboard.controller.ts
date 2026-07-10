import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller({ path: 'dashboard', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('admin')
  @Roles(UserRole.ADMIN, UserRole.HR)
  @ApiOperation({ summary: 'Super Admin dashboard KPIs' })
  getAdminStats() {
    return this.dashboardService.getAdminStats();
  }

  @Get('bm')
  @Roles(UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'Branch Manager dashboard KPIs' })
  getBmStats(@Req() req: { user: { branchId?: string } }) {
    return this.dashboardService.getBmStats(req.user.branchId);
  }

  @Get('rm')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'Relationship Manager dashboard KPIs' })
  getRmStats(@Req() req: { user: { id: string; role: string } }) {
    const rmId = req.user.role === 'RM' ? req.user.id : undefined;
    return this.dashboardService.getRmStats(rmId);
  }
}
