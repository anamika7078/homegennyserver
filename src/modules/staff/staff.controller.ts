import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffService } from './staff.service';
import { StaffApplicant } from './staff.entity';

interface StaffQueryParams {
  limit?: string;
  offset?: string;
  stage?: string;
  series?: string;
  rmId?: string;
  branchId?: string;
}

interface RestrictedCheckBody {
  aadhaar_number: string;
  phone: string;
}

@ApiTags('Staff Onboarding')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'staff', version: '1' })
export class StaffController {
  constructor(private readonly service: StaffService) {}

  @Post()
  @ApiOperation({ summary: 'Create new staff applicant (S1 Intake)' })
  create(@Body() body: Partial<StaffApplicant>): Promise<StaffApplicant> {
    return this.service.create(body);
  }

  @Get()
  @ApiOperation({ summary: 'List staff applicants with optional filters' })
  @ApiQuery({ name: 'limit',    required: false })
  @ApiQuery({ name: 'offset',   required: false })
  @ApiQuery({ name: 'stage',    required: false })
  @ApiQuery({ name: 'series',   required: false })
  @ApiQuery({ name: 'rmId',     required: false })
  @ApiQuery({ name: 'branchId', required: false })
  findAll(@Query() q: StaffQueryParams): Promise<{ items: StaffApplicant[]; total: number }> {
    return this.service.findAll({
      limit:    q.limit    ? parseInt(q.limit,    10) : 100,
      offset:   q.offset   ? parseInt(q.offset,   10) : 0,
      stage:    q.stage,
      series:   q.series,
      rmId:     q.rmId,
      branchId: q.branchId,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single staff applicant by ID' })
  findOne(@Param('id') id: string): Promise<StaffApplicant> {
    return this.service.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update staff applicant record' })
  update(
    @Param('id') id: string,
    @Body() body: Partial<StaffApplicant>,
  ): Promise<StaffApplicant> {
    return this.service.update(id, body);
  }

  @Post('check-restricted')
  @ApiOperation({ summary: 'Check Aadhaar + phone against restricted list before intake' })
  checkRestricted(
    @Body() body: RestrictedCheckBody,
  ): Promise<{ found: boolean; reason?: string }> {
    return this.service.checkRestrictedList(body.aadhaar_number, body.phone);
  }
}
