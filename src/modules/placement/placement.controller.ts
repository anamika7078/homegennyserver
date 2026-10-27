import { Controller, Get, Post, Patch, Param, Body, Query, Req, BadRequestException } from '@nestjs/common';
import { PlacementStatus } from '@prisma/client';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { PlacementService, PlacementRow, PlacementList } from './placement.service';
import { WageConfigInput } from './wage-calculator.util';

// Same fields as Finance's Commercial Calculator (homegenny's WageConfigFormModal /
// wageEngine.ts) — RM fills this at placement time instead of typing a flat number,
// so salary/fee stay driven by variable, editable rates instead of a guess.
const WAGE_CONFIG_SCHEMA = {
  type: 'object',
  description: 'Full wage-breakup inputs — when supplied, staff_salary and management_fee are computed from this (and both are ignored/overridden if also passed flat).',
  properties: {
    basic_wage: { type: 'number', example: 15000 },
    da: { type: 'number', example: 0 },
    hra: { type: 'number', example: 0 },
    skilled_allowance: { type: 'number', example: 0 },
    working_hours: { type: 'number', enum: [8, 12], default: 8, description: '12 adds a +50% additional-hours uplift' },
    employer_pf_pct: { type: 'number', example: 13 },
    employer_pf_max: { type: 'number', example: 15000, description: 'PF ceiling limit' },
    employee_pf_pct: { type: 'number', example: 12 },
    employer_esic_pct: { type: 'number', example: 3.25 },
    employee_esic_pct: { type: 'number', example: 0.75 },
    bonus_pct: { type: 'number', example: 8.33 },
    bonus_frequency: { type: 'string', enum: ['monthly', 'yearly'], default: 'monthly' },
    leave_days: { type: 'number', example: 32, description: 'Leave days / year' },
    lwf_amount: { type: 'number', example: 62 },
    uniform_allowance: { type: 'number', example: 275 },
    relieving_pct: { type: 'number', example: 16.67 },
    management_pct: { type: 'number', example: 5.5, description: 'Management fee %' },
    professional_tax: { type: 'number', example: 0 },
    pf_applicable: { type: 'boolean', default: true },
    esic_applicable: { type: 'boolean', default: true },
    bonus_applicable: { type: 'boolean', default: true },
    lwf_applicable: { type: 'boolean', default: true },
    uniform_applicable: { type: 'boolean', default: true },
    relieving_applicable: { type: 'boolean', default: true },
    gst_applicable: { type: 'boolean', default: true },
    gst_type: { type: 'string', enum: ['intra_state', 'inter_state'], default: 'intra_state' },
    gst_pct: { type: 'number', example: 18 },
  },
};

// Spec: Matching & Placement — RM=Y, BM=Y, Admin=Y, Staff/Client/Finance=no access.
// All 4 routes here are things an RM actually does from the mobile app (start a trial,
// confirm it once it goes well, exit it if it doesn't, browse the list) — tagged into
// "Mobile App RM APIs" alongside their own "Placements" tag for that reason.
@ApiTags('Placements', 'Mobile App RM APIs')
@ApiBearerAuth()
@Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
@Controller({ path: 'placements', version: '1' })
export class PlacementController {
  constructor(private readonly service: PlacementService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a new placement (trial or direct-confirm) — only once the staff is at S5_DEPLOY',
    description:
      'Links a staff member to a client. Requires the staff to have already reached S5_DEPLOY — ' +
      '400 otherwise. Defaults to TRIAL (call POST /:id/confirm later); pass status: "CONFIRMED" to ' +
      'skip the trial entirely (staff_salary and management_fee are required up front in that case).',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['staff_id', 'client_id'],
      properties: {
        staff_id: { type: 'string', description: 'StaffApplicant id — must be at pipeline_stage S5_DEPLOY' },
        client_id: { type: 'string', description: 'FinanceCustomer id' },
        branch_id: { type: 'string', description: 'Optional — defaults to the main branch' },
        rm_id: { type: 'string', description: 'Optional — RM managing this placement' },
        status: { type: 'string', enum: ['TRIAL', 'CONFIRMED'], default: 'TRIAL', description: 'TRIAL (default) or CONFIRMED to deploy straight to a confirmed placement' },
        staff_salary: { type: 'number', example: 18000, description: 'Flat entry — ignored if wage_config is also supplied. Required if status is CONFIRMED (directly, or via wage_config).' },
        management_fee: { type: 'number', example: 4500, description: 'Flat entry — ignored if wage_config is also supplied. Required if status is CONFIRMED (directly, or via wage_config).' },
        wage_config: WAGE_CONFIG_SCHEMA,
        trial_start_date: { type: 'string', format: 'date', description: 'Optional — defaults to now' },
        trial_end_date: { type: 'string', format: 'date', description: 'Optional — defaults to +7 days (Maid/UC/DR) or +14 days (SC), based on the staff\'s series' },
        shift_start: { type: 'string', example: '08:00', description: 'Optional HH:MM (IST) the shift starts — defaults to the staff request\'s start_time. Without it the snapshot never calls the staff late.' },
      },
    },
  })
  create(@Req() req: { user: { id: string } }, @Body() body: Record<string, unknown>): Promise<PlacementRow> {
    return this.service.create(body, req.user.id);
  }

  @Post('calculate-wage')
  @ApiOperation({
    summary: 'Compute a wage breakup (no persistence) — for a live preview before create()/terms',
    description:
      'Same formula Finance\'s Commercial Calculator uses. Returns netSalary (→ staff_salary) and ' +
      'managementFee (→ management_fee) plus the full PF/ESIC/bonus/GST/CTC breakdown, purely computed ' +
      'from the inputs given — nothing is saved.',
  })
  @ApiBody({ schema: WAGE_CONFIG_SCHEMA })
  calculateWage(@Body() body: WageConfigInput) {
    return this.service.calculateWage(body);
  }

  @Get()
  @ApiOperation({
    summary: 'List placements',
    description: 'Optionally filter to a single staff member or client — e.g. to find "this staff\'s placement" without paging through everything.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 100 })
  @ApiQuery({ name: 'offset', required: false, type: Number, example: 0 })
  @ApiQuery({ name: 'staff_id', required: false, description: 'StaffApplicant id' })
  @ApiQuery({ name: 'client_id', required: false, description: 'FinanceCustomer id' })
  @ApiQuery({ name: 'status', required: false, enum: ['TRIAL', 'CONFIRMED', 'EXITED', 'TERMINATED'] })
  findAll(
    @Req() req: { user: { id: string; role: string; branchId?: string | null } },
    @Query() q: Record<string, string>,
  ): Promise<PlacementList> {
    const status = q['status']?.toUpperCase();
    if (status && !(status in PlacementStatus)) {
      throw new BadRequestException(`status must be one of ${Object.keys(PlacementStatus).join(', ')}`);
    }
    // Was unscoped — every RM saw every branch's placements.
    const scope =
      req.user.role === UserRole.RM
        ? { rmId: req.user.id }
        : req.user.role === UserRole.BM && req.user.branchId
          ? { branchId: req.user.branchId }
          : undefined;
    return this.service.findAll({
      limit:  q['limit']  ? parseInt(q['limit'],  10) : 100,
      offset: q['offset'] ? parseInt(q['offset'], 10) : 0,
      staffId: q['staff_id'] || undefined,
      clientId: q['client_id'] || undefined,
      status: status as PlacementStatus | undefined,
      scope,
    });
  }

  @Get(':id/rate-history')
  @ApiOperation({
    summary: 'Every rate change on this placement, and the default date a new change applies from',
    description:
      'changes: newest first — effective_from, before/after rates, reason, who (changed_by_name), and ' +
      'superseded_at when a later edit reaching further back replaced it. next_unbilled_day: the first ' +
      'day no payroll covers yet — what PATCH :id/terms uses when effective_from is not sent.',
  })
  rateHistory(@Param('id') id: string) {
    return this.service.rateHistory(id);
  }

  @Post(':id/rate-review/confirm')
  @ApiOperation({
    summary: 'RM: the rate is right — clear the review after Finance rejected an invoice',
    description:
      'Use when the rate on the placement stands (correcting it via PATCH :id/terms clears the review ' +
      'too). Body { note } — why it stands, min 10 characters; kept on the audit trail. The client can ' +
      'be invoiced again once no placement of theirs is under review.',
  })
  confirmRateReview(@Req() req: { user: { id: string } }, @Param('id') id: string, @Body() body: { note?: string }) {
    return this.service.confirmRateReview(id, body?.note, req.user.id);
  }

  @Patch(':id/terms')
  @ApiOperation({
    summary: 'Set/update staff_salary and management_fee on a placement',
    description:
      'Required before confirm() will succeed if either was left unset at creation — there was ' +
      'previously no way to fix a placement created without them. Pass wage_config to compute both ' +
      'from a full wage breakup instead of flat numbers (same as create()) — the raw inputs and full ' +
      'breakdown are merged into the placement\'s metadata. Only the fields supplied are updated.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        staff_salary: { type: 'number', example: 18000, description: 'Ignored if wage_config is also supplied' },
        management_fee: { type: 'number', example: 4500, description: 'Ignored if wage_config is also supplied' },
        wage_config: WAGE_CONFIG_SCHEMA,
        shift_start: { type: 'string', example: '08:00', description: 'HH:MM (IST) the shift starts; "" clears it. Used for "late" on the staff snapshot.' },
        shift_hours: { type: 'number', example: 24, description: '1–24. 24 is a live-in (24×7) duty.' },
        rate_basis: { type: 'string', enum: ['MONTHLY', 'HOURLY', 'PER_DUTY'], description: 'PER_DUTY bills duties × duty_billing_rate; null = default for the placement type' },
        duty_rate: { type: 'number', example: 517, description: 'PER_DUTY: what the staff earns per duty' },
        duty_billing_rate: { type: 'number', example: 585, description: 'PER_DUTY: what the client is billed per duty, before GST (all-in)' },
        esic_applicable: { type: 'boolean', description: 'false = no ESIC for this placement' },
        pf_applicable: { type: 'boolean', description: 'false = no PF for this placement' },
        covers_placement_id: { type: 'string', description: 'Relief placement: the post (placement at the same client) it covers' },
        hourly_rate: { type: 'number', example: 150, description: 'HOURLY: what the staff earns per hour' },
        hourly_fee: { type: 'number', example: 30, description: 'HOURLY: HomeGenny fee per hour' },
        effective_from: {
          type: 'string', example: '2026-10-15',
          description:
            'YYYY-MM-DD the new rates apply from. Default: the first day no payroll covers yet. Earlier ' +
            'than that re-runs the payroll it reaches (draft invoices rebuilt, same number); refused if ' +
            'that payroll is on an approved/sent invoice or already released.',
        },
        reason: { type: 'string', example: 'Increment agreed with the client', description: 'Kept on the rate history' },
      },
    },
  })
  updateTerms(
    @Req() req: { user: { id: string } },
    @Param('id') id: string,
    @Body() body: {
      staff_salary?: number; management_fee?: number; wage_config?: WageConfigInput; shift_start?: string;
      shift_hours?: number; rate_basis?: string | null; duty_rate?: number | null; duty_billing_rate?: number | null;
      esic_applicable?: boolean; pf_applicable?: boolean; covers_placement_id?: string | null;
      hourly_rate?: number; hourly_fee?: number; effective_from?: string; reason?: string;
    },
  ): Promise<PlacementRow & { warnings: string[] }> {
    return this.service.updateTerms(id, body, req.user.id);
  }

  @Post(':id/confirm')
  @ApiOperation({
    summary: 'Confirm a trial placement — TRIAL → CONFIRMED',
    description:
      'Required before the staff can check in, RM can mark their attendance, or Finance can run payroll/invoicing ' +
      'for this placement — all of those require CONFIRMED status. Only valid from TRIAL; 400 otherwise. ' +
      'staff_salary and management_fee must both be set first (PATCH :id/terms if not set at creation). ' +
      'A2 (SOW, must be SENT/ACKNOWLEDGED) and A3 (Indemnity, must exist) must also already be on file for ' +
      'this placement — 400 otherwise. (Not required for a placement created directly as CONFIRMED via POST /.)',
  })
  confirm(@Req() req: { user: { id: string } }, @Param('id') id: string): Promise<PlacementRow> {
    return this.service.confirm(id, req.user.id);
  }

  @Post(':id/exit')
  @ApiOperation({ summary: 'Exit a placement' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['exit_date', 'exit_scenario_code'],
      properties: {
        exit_date: { type: 'string', format: 'date' },
        exit_scenario_code: { type: 'string', example: 'CLIENT_INITIATED' },
      },
    },
  })
  exit(
    @Req() req: { user: { id: string } },
    @Param('id') id: string,
    @Body() body: { exit_date: string; exit_scenario_code: string },
  ): Promise<{ success: boolean }> {
    return this.service.exit(id, body, req.user.id);
  }
}
