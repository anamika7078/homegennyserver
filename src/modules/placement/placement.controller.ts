import { Controller, Get, Post, Patch, Param, Body, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { PlacementService, PlacementRow, PlacementList } from './placement.service';

// Spec: Matching & Placement — RM=Y, BM=Y, Admin=Y, Staff/Client/Finance=no access.
// All 4 routes here are things an RM actually does from the mobile app (start a trial,
// confirm it once it goes well, exit it if it doesn't, browse the list) — tagged into
// "Mobile App RM APIs" alongside their own "Placements" tag for that reason.
@ApiTags('Placements', 'Mobile App RM APIs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
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
        staff_salary: { type: 'number', example: 18000, description: 'Required if status is CONFIRMED' },
        management_fee: { type: 'number', example: 4500, description: 'Required if status is CONFIRMED' },
        trial_start_date: { type: 'string', format: 'date', description: 'Optional — defaults to now' },
        trial_end_date: { type: 'string', format: 'date', description: 'Optional — defaults to +7 days (Maid/UC/DR) or +14 days (SC), based on the staff\'s series' },
      },
    },
  })
  create(@Req() req: { user: { id: string } }, @Body() body: Record<string, unknown>): Promise<PlacementRow> {
    return this.service.create(body, req.user.id);
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
  findAll(@Query() q: Record<string, string>): Promise<PlacementList> {
    return this.service.findAll({
      limit:  q['limit']  ? parseInt(q['limit'],  10) : 100,
      offset: q['offset'] ? parseInt(q['offset'], 10) : 0,
      staffId: q['staff_id'] || undefined,
      clientId: q['client_id'] || undefined,
    });
  }

  @Patch(':id/terms')
  @ApiOperation({
    summary: 'Set/update staff_salary and management_fee on a placement',
    description:
      'Required before confirm() will succeed if either was left unset at creation — there was ' +
      'previously no way to fix a placement created without them. Both are optional here; only the ' +
      'ones supplied are updated.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        staff_salary: { type: 'number', example: 18000 },
        management_fee: { type: 'number', example: 4500 },
      },
    },
  })
  updateTerms(
    @Req() req: { user: { id: string } },
    @Param('id') id: string,
    @Body() body: { staff_salary?: number; management_fee?: number },
  ): Promise<PlacementRow> {
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
