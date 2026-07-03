import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('System Monitoring')
@ApiBearerAuth()
@Controller({ path: 'monitoring', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class MonitoringController {
  constructor(private readonly monitoringService: MonitoringService) {}

  /** Returns all 7 cron job definitions with their status/schedule */
  @Get('cron-jobs')
  @Roles(UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'List all cron job definitions and their current status' })
  async getCronJobs() {
    return this.monitoringService.getCronJobDefinitions();
  }

  /** Returns today's cron execution activity log */
  @Get('activity-log')
  @Roles(UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: "Get today's cron activity log" })
  async getActivityLog() {
    return this.monitoringService.getTodayActivityLog();
  }

  /** Returns system health overview (counts, DB status, queue depths) */
  @Get('system-health')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get system health overview' })
  async getSystemHealth() {
    return this.monitoringService.getSystemHealth();
  }

  /** Manually trigger a specific cron job by its key */
  @Post('cron-jobs/:jobKey/trigger')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Manually trigger a cron job' })
  async triggerCronJob(@Param('jobKey') jobKey: string) {
    return this.monitoringService.triggerJob(jobKey);
  }
}
