import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { RmService } from './rm.service';
import { AuthUser } from '../../common/guards/branch-scope.util';

const PIPELINE_STAGES = [
  'S1_INTAKE', 'S2_VERIFY', 'S2_5_ASSESS', 'S3_TRAIN',
  'S4_AGREEMENTS', 'S5_DEPLOY', 'DEFERRED', 'TERMINAL',
];
const TERMINAL_OUTCOMES = ['ENROLLED', 'CONDITIONAL', 'DEFERRED', 'DENIED', 'ABANDONED', 'LATE_EXIT'];

@ApiTags('RM Operations', 'Mobile App RM APIs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
@Controller({ path: 'rm', version: '1' })
export class RmController {
  constructor(private readonly rm: RmService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'RM dashboard KPIs, funnel, and series distribution' })
  dashboard(@Req() req: { user: AuthUser }) {
    return this.rm.getDashboard(req.user);
  }

  @Get('kanban')
  @ApiOperation({ summary: 'Pipeline kanban columns (branch/RM scoped)' })
  @ApiQuery({ name: 'search', required: false, description: 'Filter by staff name/code' })
  @ApiQuery({ name: 'series', required: false, enum: ['DR', 'SC', 'UC', 'MAID'] })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  kanban(
    @Req() req: { user: AuthUser },
    @Query('search') search?: string,
    @Query('series') series?: string,
    @Query('limit') limit?: string,
  ) {
    return this.rm.getKanban(req.user, {
      search,
      series,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Post('pipeline/:staffId/advance')
  @ApiOperation({ summary: 'FSM-validated stage transition (immutable event log)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['to_stage'],
      properties: {
        to_stage: { type: 'string', enum: PIPELINE_STAGES, example: 'S2_VERIFY' },
        reason_code: { type: 'string', example: 'INTAKE_COMPLETE' },
        payload: { type: 'object', additionalProperties: true, example: { deferred_reason: 'string', notes: 'string' } },
        terminal_outcome: {
          type: 'string',
          enum: TERMINAL_OUTCOMES,
          description: 'Required only when to_stage = TERMINAL',
          example: 'DENIED',
        },
      },
    },
  })
  advance(
    @Req() req: { user: AuthUser },
    @Param('staffId') staffId: string,
    @Body() body: {
      to_stage: string;
      reason_code?: string;
      payload?: Record<string, unknown>;
      terminal_outcome?: string;
    },
  ) {
    return this.rm.advanceStage(
      req.user,
      staffId,
      body.to_stage,
      body.reason_code,
      body.payload,
      body.terminal_outcome,
    );
  }

  @Get('trials')
  @ApiOperation({ summary: 'Active trial placements for RM' })
  trials(@Req() req: { user: AuthUser }) {
    return this.rm.listTrials(req.user);
  }

  @Get('deferred')
  @ApiOperation({ summary: 'Deferred cases with aging' })
  deferred(@Req() req: { user: AuthUser }) {
    return this.rm.listDeferred(req.user);
  }

  @Post('deferred/:staffId/resume')
  @ApiOperation({ summary: 'Resume deferred staff to target stage' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['to_stage'],
      properties: { to_stage: { type: 'string', enum: PIPELINE_STAGES, example: 'S2_VERIFY' } },
    },
  })
  resumeDeferred(
    @Req() req: { user: AuthUser },
    @Param('staffId') staffId: string,
    @Body() body: { to_stage: string },
  ) {
    return this.rm.resumeDeferred(req.user, staffId, body.to_stage);
  }

  @Get('terminal')
  @ApiOperation({ summary: 'Terminal outcome staff list' })
  terminal(@Req() req: { user: AuthUser }) {
    return this.rm.listTerminal(req.user);
  }

  @Get('incidents')
  @ApiOperation({ summary: 'Incident inbox' })
  @ApiQuery({ name: 'status', required: false })
  incidents(@Req() req: { user: AuthUser }, @Query('status') status?: string) {
    return this.rm.listIncidents(req.user, status);
  }

  @Post('incidents')
  @ApiOperation({ summary: 'Raise new incident' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['type', 'title'],
      properties: {
        staff_id: { type: 'string', example: 'b0116bc6-b2db-45e3-a6af-530b285a777e' },
        type: {
          type: 'string',
          enum: ['CLIENT_COMPLAINT', 'STAFF_MISCONDUCT', 'SAFETY_ISSUE', 'ATTENDANCE_FRAUD', 'DRIVING_VIOLATION', 'LATE_EXIT'],
          example: 'CLIENT_COMPLAINT',
        },
        title: { type: 'string', example: 'Driver asked to do grocery shopping outside SOW' },
        description: { type: 'string' },
        client_id: { type: 'string' },
        placement_id: { type: 'string' },
        evidence_urls: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  createIncident(@Req() req: { user: AuthUser }, @Body() body: Record<string, unknown>) {
    return this.rm.createIncident(req.user, body);
  }

  @Get('shifts')
  @ApiOperation({ summary: 'Shift logs pending approval' })
  @ApiQuery({ name: 'status', required: false })
  shifts(@Req() req: { user: AuthUser }, @Query('status') status?: string) {
    return this.rm.listShiftLogs(req.user, status);
  }

  @Patch('shifts/:id/review')
  @ApiOperation({ summary: 'Approve / reject / flag shift log' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['APPROVED', 'REJECTED', 'FLAGGED'], example: 'APPROVED' },
        notes: { type: 'string' },
      },
    },
  })
  reviewShift(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { action: 'APPROVED' | 'REJECTED' | 'FLAGGED'; notes?: string },
  ) {
    return this.rm.reviewShift(req.user, id, body.action, body.notes);
  }

  @Get('upgrades')
  @ApiOperation({ summary: 'Upgrade path tracker (Maid→UC, UC→SC)' })
  upgrades(@Req() req: { user: AuthUser }) {
    return this.rm.listUpgrades(req.user);
  }

  @Post('intake')
  @Roles(UserRole.RM, UserRole.HR, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({
    summary: 'S1 intake with restricted-list check, deposit, and optional S2 advance',
    description:
      'Creates the StaffApplicant record AND a login-capable STAFF account (default password ' +
      'HomeGenny@2024, must_change_password: true) linked to it. If the restricted-list check ' +
      '(Aadhaar + phone) hits, the record is created directly at TERMINAL with no login provisioned. ' +
      'HR can also call this (candidate intake, separate from the payroll-grade POST /employees) — ' +
      'pass assigned_rm_id explicitly since HR is not itself an RM.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['aadhaar_number', 'mobile', 'full_name', 'series'],
      properties: {
        aadhaar_number: { type: 'string', example: '999988887777', description: 'Full Aadhaar — only used for the restricted-list hash check, not stored' },
        mobile: { type: 'string', example: '9911100001' },
        full_name: { type: 'string', example: 'Rohan Test Kumar' },
        date_of_birth: { type: 'string', example: '1998-04-12' },
        address: { type: 'string', example: 'Sector 12, Noida' },
        email: { type: 'string', example: 'rohan@example.com' },
        series: { type: 'string', enum: ['DR', 'SC', 'UC', 'MAID'], example: 'MAID' },
        language_tier: { type: 'string', example: 'T1' },
        role_types: { type: 'array', items: { type: 'string' } },
        branch_id: { type: 'string', description: 'Defaults to the RM\'s own branch if omitted' },
        deposit_amount: { type: 'number', example: 500, description: 'DR ₹2000 · SC ₹1500 · UC ₹1000 · MAID ₹500 (not auto-derived — send the right amount for the series)' },
        deposit_collected: { type: 'boolean', example: true },
        advance_to_verify: { type: 'boolean', default: true, description: 'Set false to leave the staff at S1_INTAKE instead of auto-advancing to S2_VERIFY' },
        referral_source: { type: 'string' },
        assigned_rm_id: { type: 'string', description: 'Required from non-RM callers (HR/BM/ADMIN) — which RM owns this candidate from S2 onward' },
      },
    },
  })
  intake(@Req() req: { user: AuthUser }, @Body() body: Record<string, unknown>) {
    return this.rm.processIntake(req.user, body);
  }

  @Get('users')
  @Roles(UserRole.RM, UserRole.HR, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'Lightweight list of active RM users, for assignment dropdowns (e.g. HR intake)' })
  listRmUsers() {
    return this.rm.listRmUsers();
  }

  @Get('locations')
  @ApiOperation({ summary: 'Cities and branches for attendance location filters' })
  locations(@Req() req: { user: AuthUser }) {
    return this.rm.getLocations(req.user);
  }

  @Get('attendance')
  @ApiOperation({ summary: 'Branch staff attendance for a month' })
  @ApiQuery({ name: 'branchId', required: true })
  @ApiQuery({ name: 'month', required: true, type: Number, example: 8 })
  @ApiQuery({ name: 'year', required: true, type: Number, example: 2026 })
  @ApiQuery({ name: 'branchCode', required: false })
  attendance(
    @Req() req: { user: AuthUser },
    @Query('branchId') branchId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('branchCode') branchCode?: string,
  ) {
    return this.rm.getAttendance(
      req.user,
      branchId,
      parseInt(month, 10),
      parseInt(year, 10),
      branchCode,
    );
  }

  @Put('attendance')
  @ApiOperation({ summary: 'Mark or clear daily attendance for a staff member' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['staff_id', 'date'],
      properties: {
        staff_id: { type: 'string' },
        date: { type: 'string', example: '2026-08-13' },
        status: { type: 'string', enum: ['PRESENT', 'ABSENT', 'LEAVE', 'OVERTIME'], nullable: true, description: 'null clears the day\'s record' },
        overtime_hours: { type: 'number', example: 2 },
        branch_id: { type: 'string' },
      },
    },
  })
  markAttendance(
    @Req() req: { user: AuthUser },
    @Body() body: {
      staff_id: string;
      date: string;
      status?: 'PRESENT' | 'ABSENT' | 'LEAVE' | 'OVERTIME' | null;
      overtime_hours?: number;
      branch_id?: string;
    },
  ) {
    return this.rm.markAttendance(req.user, body);
  }

  @Get('attendance/:staffId/invoice-preview')
  @ApiOperation({ summary: 'Preview pro-rated invoice for staff month' })
  @ApiQuery({ name: 'month', required: true, type: Number, example: 8 })
  @ApiQuery({ name: 'year', required: true, type: Number, example: 2026 })
  invoicePreview(
    @Req() req: { user: AuthUser },
    @Param('staffId') staffId: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    return this.rm.previewAttendanceInvoice(
      req.user,
      staffId,
      parseInt(month, 10),
      parseInt(year, 10),
    );
  }

  @Post('attendance/:staffId/generate-invoice')
  @ApiOperation({ summary: 'Generate payroll record and client invoice from attendance' })
  @ApiQuery({ name: 'month', required: true, type: Number, example: 8 })
  @ApiQuery({ name: 'year', required: true, type: Number, example: 2026 })
  generateInvoice(
    @Req() req: { user: AuthUser },
    @Param('staffId') staffId: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    return this.rm.generateAttendanceInvoice(
      req.user,
      staffId,
      parseInt(month, 10),
      parseInt(year, 10),
    );
  }
}
