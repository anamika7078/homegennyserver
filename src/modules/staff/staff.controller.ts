import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, Req, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { StaffService } from './staff.service';
import { resolveStaffScope, AuthUser } from '../../common/guards/branch-scope.util';

// RM-facing staff applicant CRUD (create/list/update pipeline records) — not the
// same as the STAFF role's own mobile-app onboarding view. Spec: RM operates the
// pipeline directly, BM has branch oversight, Admin platform-wide. Finance must
// not access pipeline/staff records; confirmed live in the audit (GET /staff
// returned 200 for a FINANCE token before this fix).
@ApiTags('Staff Onboarding')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
@Controller({ path: 'staff', version: '1' })
export class StaffController {
  constructor(private readonly service: StaffService) {}

  @Post()
  @ApiOperation({ summary: 'Create new staff applicant (S1 Intake)' })
  create(@Body() body: Record<string, unknown>, @Req() req: { user: { id: string } }) {
    return this.service.create(body, req.user.id);
  }

  @Get()
  @ApiOperation({ summary: 'List staff applicants with optional filters' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'stage', required: false })
  @ApiQuery({ name: 'series', required: false })
  @ApiQuery({ name: 'rmId', required: false })
  @ApiQuery({ name: 'branchId', required: false })
  findAll(
    @Req() req: { user: AuthUser },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('stage') stage?: string,
    @Query('series') series?: string,
    @Query('rmId') rmId?: string,
    @Query('branchId') branchId?: string,
  ) {
    const scope = resolveStaffScope(req.user, { rmId, branchId });
    return this.service.findAll({
      limit: limit ? parseInt(limit, 10) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
      stage,
      series,
      rmId: scope.rmId,
      branchId: scope.branchId,
    });
  }

  @Get(':id/timeline')
  @ApiOperation({ summary: 'Unified activity + scenario history' })
  timeline(@Param('id') id: string) {
    return this.service.getTimeline(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single staff applicant by ID' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update staff applicant record' })
  update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: { user: AuthUser },
  ) {
    // FSM-owned fields must never be settable via this generic PATCH, for any
    // role — they must only change through POST /pipeline/:staffId/advance,
    // which validates transition legality, business/deployment gates, and
    // persists scenario routing atomically. This previously only blocked RM
    // specifically, leaving BM/Admin able to PATCH pipeline_stage directly
    // and skip every FSM/business check entirely.
    const fsmOwnedFields = ['pipeline_stage', 'current_scenario_code', 'terminal_outcome'];
    const attempted = fsmOwnedFields.filter((f) => body[f] !== undefined);
    if (attempted.length) {
      throw new ForbiddenException(
        `${attempted.join(', ')} cannot be changed via PATCH /staff/:id — use POST /pipeline/:staffId/advance`,
      );
    }
    return this.service.update(id, body, req.user.id);
  }

  @Post('check-restricted')
  @ApiOperation({ summary: 'Check Aadhaar + phone against restricted list before intake' })
  checkRestricted(@Body() body: { aadhaar_number: string; phone: string }) {
    return this.service.checkRestrictedList(body.aadhaar_number, body.phone);
  }
}
