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
  } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { RmService } from './rm.service';
import { HOLD_REASONS, COMPLETE_REASONS } from '../pipeline/pipeline-fsm.service';
import { AuthUser } from '../../common/guards/branch-scope.util';

const PIPELINE_STAGES = [
  'S1_INTAKE', 'S2_VERIFY', 'S2_5_ASSESS', 'S3_TRAIN',
  'S4_AGREEMENTS', 'S5_DEPLOY', 'DEFERRED', 'TERMINAL',
];
const TERMINAL_OUTCOMES = ['ENROLLED', 'CONDITIONAL', 'DEFERRED', 'DENIED', 'ABANDONED', 'LATE_EXIT'];

@ApiTags('RM Operations', 'Mobile App RM APIs')
@ApiBearerAuth()
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

  @Post('pipeline/:staffId/hold')
  @ApiOperation({
    summary: 'Put a stage on hold — its work is pending, but the staff may advance past it',
    description:
      'Defaults to the staff\'s current stage. Advancing from a held stage skips that stage\'s exit gate; ' +
      'releasing the hold is where the gate is checked instead. No placement can be created while a hold is open.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', enum: [...HOLD_REASONS], example: 'PV_PENDING' },
        stage: { type: 'string', enum: PIPELINE_STAGES.slice(0, 6), description: 'Optional — defaults to the current stage' },
        notes: { type: 'string' },
      },
    },
  })
  placeHold(
    @Req() req: { user: AuthUser },
    @Param('staffId') staffId: string,
    @Body() body: { reason?: string; stage?: string; notes?: string },
  ) {
    return this.rm.placeHold(req.user, staffId, body ?? {});
  }

  @Post('pipeline/:staffId/complete')
  @ApiOperation({
    summary: 'Mark a stage complete — its work already happened outside the system',
    description:
      'For a migrated or previously-vetted staff member whose verification/training/agreement is already done ' +
      'in reality, just not recorded here — re-doing it has no benefit. Permanent, not re-checked, and unlike ' +
      'a hold it does NOT block placement. The underlying verification/training/video/agreement workflows are ' +
      'unaffected for everyone else; this only satisfies the gate check for this one staff and stage.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', enum: [...COMPLETE_REASONS], example: 'ALREADY_VERIFIED_EXTERNALLY' },
        stage: { type: 'string', enum: PIPELINE_STAGES.slice(0, 6), description: 'Optional — defaults to the current stage' },
        notes: { type: 'string' },
      },
    },
  })
  markComplete(
    @Req() req: { user: AuthUser },
    @Param('staffId') staffId: string,
    @Body() body: { reason?: string; stage?: string; notes?: string },
  ) {
    return this.rm.markComplete(req.user, staffId, body ?? {});
  }

  @Post('holds/:holdId/release')
  @ApiOperation({
    summary: 'Release a hold, or revert a complete',
    description:
      'A HOLD: if the staff has moved past the held stage, that stage\'s exit gate must pass first (400 lists ' +
      'what is missing). A COMPLETE: reverted unconditionally — there is nothing to re-check, since it was ' +
      'never a gate result to begin with.',
  })
  @ApiBody({ schema: { type: 'object', properties: { notes: { type: 'string' } } } })
  releaseHold(
    @Req() req: { user: AuthUser },
    @Param('holdId') holdId: string,
    @Body() body: { notes?: string },
  ) {
    return this.rm.releaseHold(req.user, holdId, body?.notes);
  }

  @Get('holds')
  @ApiOperation({ summary: 'Open holds and completes, oldest first (branch/RM scoped)' })
  holds(@Req() req: { user: AuthUser }) {
    return this.rm.listHolds(req.user);
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
  @ApiOperation({ summary: 'Resume deferred staff — to the stage they were deferred from unless to_stage says otherwise' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        to_stage: {
          type: 'string',
          enum: PIPELINE_STAGES,
          example: 'S2_VERIFY',
          description: 'Optional — defaults to the stage the staff was deferred from. Cannot be later than that stage.',
        },
      },
    },
  })
  resumeDeferred(
    @Req() req: { user: AuthUser },
    @Param('staffId') staffId: string,
    @Body() body: { to_stage?: string },
  ) {
    return this.rm.resumeDeferred(req.user, staffId, body?.to_stage);
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

  @Get('unassigned-staff')
  @ApiOperation({
    summary: 'Staff who self-registered from the app and have no RM yet',
    description:
      'Not scoped by RM (there is nothing to scope by — that\'s the point) or by branch, since a self-registered ' +
      'staff member has neither yet. Any RM/BM/Admin sees the same list; claim one to take it.',
  })
  listUnassignedStaff() {
    return this.rm.listUnassignedStaff();
  }

  @Post('unassigned-staff/:staffId/claim')
  @ApiOperation({
    summary: 'Claim an unassigned (self-registered) staff member',
    description:
      'Sets the caller as assignedRmId — first to claim wins. Refuses (409) if someone already claimed it, ' +
      'including the caller themself on a double-click, so the button never silently no-ops.',
  })
  claimStaff(@Req() req: { user: AuthUser }, @Param('staffId') staffId: string) {
    return this.rm.claimStaff(req.user, staffId);
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
  @ApiOperation({
    summary: 'Correction/fallback: mark or clear a day\'s attendance directly',
    description:
      'Attendance is normally staff-owned — they self-check-in via POST /staff/attendance/check-in ' +
      'and RM reviews it via PATCH /rm/shifts/:id/review. This endpoint is only for a genuine gap ' +
      '(no shift log at all for that date) or fixing a date RM already rejected as inaccurate — 400 ' +
      'if the staff has a live (PENDING/APPROVED) or FLAGGED self-check-in for that date instead.',
  })
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
