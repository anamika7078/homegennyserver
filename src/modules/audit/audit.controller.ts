import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { AuditService } from './audit.service';

@ApiTags('Audit')
@ApiBearerAuth()
@Controller({ path: 'audit', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  // FINANCE added here (was ADMIN/BM only) so the "Finance Audit Trail" page
  // (homegenny/src/app/finance/audit/page.tsx) has a real, role-permitted
  // endpoint to call — it was previously calling the admin-only
  // GET /admin/audit-logs, always 403ing for FINANCE, and silently falling
  // back to 5 hardcoded fake rows shown as if real. This is the correct
  // endpoint anyway: /admin/audit-logs only logs admin-panel actions
  // (AdminAuditInterceptor), while THIS one is the general AuditLog table
  // that deposit/invoice/payroll/placement actions actually write to via
  // AuditService.log() throughout the codebase.
  @Get('logs')
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.FINANCE)
  list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('action') action?: AuditAction,
    @Query('actorId') actorId?: string,
  ) {
    return this.audit.findMany({
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
      action,
      actorId,
    });
  }
}
