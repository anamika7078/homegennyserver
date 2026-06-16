import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, Req, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffService } from './staff.service';
import { resolveStaffScope, AuthUser } from '../../common/guards/branch-scope.util';

@ApiTags('Staff Onboarding')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
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
    if (req.user.role === 'RM' && body.pipeline_stage) {
      throw new ForbiddenException(
        'RM cannot bypass FSM — use POST /rm/pipeline/:staffId/advance',
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
