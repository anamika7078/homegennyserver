import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  Req,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { AdminAuditInterceptor } from './interceptors/admin-audit.interceptor';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller({ path: 'admin', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@UseInterceptors(AdminAuditInterceptor)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Profile
  // ─────────────────────────────────────────────────────────────────────────────

  @Get('profile')
  @ApiOperation({ summary: 'Get current Admin profile from JWT context' })
  async getProfile(@Req() req: any) {
    return req.user;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Users
  // ─────────────────────────────────────────────────────────────────────────────

  @Get('users')
  @ApiOperation({ summary: 'List all platform users' })
  async getUsers() {
    return this.adminService.getUsers();
  }

  @Post('users/create')
  @ApiOperation({
    summary: 'Create a user. ADMIN role assignments are queued for dual-Admin confirmation.',
  })
  async createUser(@Body() data: any, @Req() req: any) {
    return this.adminService.createUser(data, req.user.id);
  }

  @Put('users/update/:id')
  @ApiOperation({
    summary: 'Update a user. Promoting to ADMIN role requires dual-Admin confirmation.',
  })
  async updateUser(@Param('id') id: string, @Body() data: any, @Req() req: any) {
    return this.adminService.updateUser(id, data, req.user.id);
  }

  @Delete('users/deactivate/:id')
  @ApiOperation({ summary: 'Deactivate a user account' })
  async deactivateUser(@Param('id') id: string) {
    return this.adminService.deactivateUser(id);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Admin Role Approval Flow
  // ─────────────────────────────────────────────────────────────────────────────

  @Get('approvals')
  @ApiOperation({ summary: 'List all pending Admin role-grant approval requests' })
  async getPendingApprovals() {
    return this.adminService.getPendingApprovals();
  }

  @Post('approvals/:id/approve')
  @ApiOperation({
    summary:
      'Approve a pending Admin role-grant request. ' +
      'The approver must be a different Admin from the requester.',
  })
  async approveAction(@Param('id') id: string, @Req() req: any) {
    return this.adminService.approveAction(id, req.user.id);
  }

  @Post('approvals/:id/reject')
  @ApiOperation({
    summary:
      'Reject a pending Admin role-grant request. ' +
      'The rejecting Admin must be a different person from the requester.',
  })
  async rejectAction(@Param('id') id: string, @Req() req: any) {
    return this.adminService.rejectAction(id, req.user.id);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Branches
  // ─────────────────────────────────────────────────────────────────────────────

  @Get('branches')
  @ApiOperation({ summary: 'List all branches' })
  async getBranches() {
    return this.adminService.getBranches();
  }

  @Post('branches/create')
  @ApiOperation({ summary: 'Create a branch' })
  async createBranch(@Body() data: any) {
    return this.adminService.createBranch(data);
  }

  @Put('branches/update/:id')
  @ApiOperation({ summary: 'Update a branch' })
  async updateBranch(@Param('id') id: string, @Body() data: any) {
    return this.adminService.updateBranch(id, data);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Admin Audit Logs (read-only view; the underlying table is append-only)
  // ─────────────────────────────────────────────────────────────────────────────

  @Get('audit-logs')
  @ApiOperation({ summary: 'Query Admin audit logs (paginated)' })
  async getAuditLogs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
  ) {
    return this.adminService.getAuditLogs({
      page:    page    ? parseInt(page, 10)    : 1,
      limit:   limit   ? parseInt(limit, 10)   : 50,
      actorId: actorId ?? undefined,
      action:  action  ?? undefined,
    });
  }

  @Get('audit-logs/:id')
  @ApiOperation({ summary: 'Get a single Admin audit log entry' })
  async getAuditLogDetails(@Param('id') id: string) {
    return this.adminService.getAuditLogDetails(id);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Monitoring
  // ─────────────────────────────────────────────────────────────────────────────

  @Get('system-health')
  @ApiOperation({ summary: 'System health status' })
  async getSystemHealth() {
    return this.adminService.getSystemHealth();
  }

  @Get('queues')
  @ApiOperation({ summary: 'Queue status' })
  async getQueueStatus() {
    return this.adminService.getQueueStatus();
  }

  @Get('queues/failed')
  @ApiOperation({ summary: 'List failed BullMQ jobs' })
  async getFailedQueueJobs(@Query('limit') limit?: string) {
    return this.adminService.getFailedQueueJobs(limit ? parseInt(limit, 10) : 20);
  }

  @Post('queues/retry-failed')
  @ApiOperation({ summary: 'Retry all failed BullMQ jobs' })
  async retryFailedQueueJobs() {
    return this.adminService.retryFailedQueueJobs();
  }

  @Get('cron-status')
  @ApiOperation({ summary: 'Cron job status' })
  async getCronStatus() {
    return this.adminService.getCronStatus();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Analytics
  // ─────────────────────────────────────────────────────────────────────────────

  @Get('analytics/revenue')
  @ApiOperation({ summary: 'Revenue analytics' })
  async getRevenueAnalytics() {
    return this.adminService.getRevenueAnalytics();
  }

  @Get('analytics/pipeline')
  @ApiOperation({ summary: 'Pipeline analytics' })
  async getPipelineAnalytics() {
    return this.adminService.getPipelineAnalytics();
  }

  @Get('pipeline/overview')
  @ApiOperation({ summary: 'Global pipeline overview with funnel, KPIs, and recent events' })
  async getPipelineOverview() {
    return this.adminService.getPipelineOverview();
  }

  @Get('analytics/placements')
  @ApiOperation({ summary: 'Placement analytics' })
  async getPlacementAnalytics() {
    return this.adminService.getPlacementAnalytics();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Privacy
  // ─────────────────────────────────────────────────────────────────────────────

  @Post('privacy/delete-request')
  @ApiOperation({ summary: 'Submit a GDPR / data-privacy deletion request' })
  async submitDeleteRequest(@Body() data: any) {
    return this.adminService.submitDeleteRequest(data);
  }

  @Get('privacy/requests')
  @ApiOperation({ summary: 'List all privacy/deletion requests' })
  async getPrivacyRequests() {
    return this.adminService.getPrivacyRequests();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Video Certifications
  // ─────────────────────────────────────────────────────────────────────────────

  @Get('video-certifications')
  @ApiOperation({ summary: 'List all video certifications (paginated, filterable)' })
  async getVideoCertifications(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getVideoCertifications({
      status: status ?? undefined,
      search: search ?? undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  @Put('video-certifications/:id/review')
  @ApiOperation({ summary: 'Approve or reject a pending video certification' })
  async reviewVideoCertification(
    @Param('id') id: string,
    @Body() body: { status: 'APPROVED' | 'REJECTED'; notes?: string },
    @Req() req: any,
  ) {
    return this.adminService.reviewVideoCertification(id, req.user.id, body);
  }
}
