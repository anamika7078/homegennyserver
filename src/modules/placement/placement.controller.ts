import { Controller, Get, Post, Param, Body, Query, Req, UseGuards } from '@nestjs/common';
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
    summary: 'Create a new placement (trial)',
    description: 'Links a staff member to a client. Always starts as TRIAL — call POST /:id/confirm once the trial succeeds.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['staff_id', 'client_id'],
      properties: {
        staff_id: { type: 'string', description: 'StaffApplicant id' },
        client_id: { type: 'string', description: 'FinanceCustomer id' },
        branch_id: { type: 'string', description: 'Optional — defaults to the main branch' },
        rm_id: { type: 'string', description: 'Optional — RM managing this placement' },
        staff_salary: { type: 'number', example: 18000 },
        management_fee: { type: 'number', example: 4500 },
        trial_start_date: { type: 'string', format: 'date', description: 'Optional — defaults to now' },
        trial_end_date: { type: 'string', format: 'date', description: 'Optional — defaults to +14 days' },
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

  @Post(':id/confirm')
  @ApiOperation({
    summary: 'Confirm a trial placement — TRIAL → CONFIRMED',
    description:
      'Required before the staff can check in, RM can mark their attendance, or Finance can run payroll/invoicing ' +
      'for this placement — all of those require CONFIRMED status. Only valid from TRIAL; 400 otherwise.',
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
