import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { AuthUser } from '../../common/guards/branch-scope.util';
import { StaffRequestsService } from './staff-requests.service';

const REQUEST_BODY = {
  schema: {
    type: 'object',
    required: ['series', 'start_date', 'start_time', 'address', 'requirements'],
    properties: {
      series: { type: 'string', enum: ['UC', 'SC', 'CK'], description: 'Active series only — see GET /meta/series' },
      visit_type: { type: 'string', enum: ['REGULAR', 'ONE_TIME'], default: 'REGULAR', description: 'ONE_TIME = one visit of duration_min; REGULAR = daily staff' },
      duration_min: { type: 'integer', enum: [60, 90, 120, 180], description: 'Required for ONE_TIME (sets TEMPORARY, shift_hours = duration/60)' },
      placement_type: { type: 'string', enum: ['PERMANENT', 'TEMPORARY'], default: 'PERMANENT', description: 'REGULAR only' },
      shift_hours: { type: 'number', example: 8 },
      start_date: { type: 'string', example: '2026-10-20', description: 'Required. YYYY-MM-DD, not in the past' },
      start_time: { type: 'string', example: '09:00', description: 'Required. HH:MM IST' },
      address: { type: 'string', description: 'Required — where the staff will work' },
      lat: { type: 'number', example: 28.5355, description: 'Map pin (send with lng)' },
      lng: { type: 'number', example: 77.391 },
      language: { type: 'string', example: 'Hindi' },
      gender_pref: { type: 'string', enum: ['ANY', 'FEMALE', 'MALE'], default: 'ANY' },
      headcount: { type: 'integer', default: 1, minimum: 1, maximum: 20 },
      notes: { type: 'string' },
      menu: {
        type: 'object',
        description:
          'Cook only. ONE_TIME: { dish_ids[], dishes[], meal?, meal_time?, special_instruction? } — 1+ dishes, max 3/4/5/7 for 60/90/120/180 min. ' +
          'REGULAR (optional): { items: [weekly template items] }. Becomes the menu / template when staff is placed.',
      },
      care_needs: {
        type: 'object',
        description: 'UC/SC only, optional. Care-plan format: patient, medications[], vitals[], activities[], diet_notes, dos, donts (UC: no medications/vitals). Becomes care plan v1 when staff is placed.',
      },
      requirements: {
        type: 'object',
        description:
          'UC/SC: patient_age*, mobility* (WALKING|ASSISTED|BEDRIDDEN), patient_gender, conditions[], medical_needs[], night_care. ' +
          'CK: diet_type* (VEG|EGG|NON_VEG|JAIN|VEGAN), family_size*, meals_per_day* (BREAKFAST|LUNCH|SNACKS|DINNER), cuisines[], health_conditions[]. ' +
          'UC cannot have medical_needs MEDICATION/VITALS/WOUND_CARE/INJECTION/CLINICAL_ESCALATION.',
        example: { patient_age: 78, mobility: 'ASSISTED', conditions: ['DIABETES'], night_care: false },
      },
    },
  },
};

/** The client app's side: raise a request, see the shortlist, choose. */
@ApiTags('Client Mobile App', 'Staff Requests')
@ApiBearerAuth()
@Roles(UserRole.CLIENT)
@Controller({ path: 'client/staff-requests', version: '1' })
export class ClientStaffRequestsController {
  constructor(private readonly svc: StaffRequestsService) {}

  @Post()
  @ApiOperation({ summary: 'Ask for staff. The RM is assigned automatically and gets notified.' })
  @ApiBody(REQUEST_BODY)
  create(@Req() req: { user: { id: string } }, @Body() body: Record<string, unknown>) {
    return this.svc.createFromClient(req.user.id, body);
  }

  @Get()
  @ApiOperation({ summary: "This client's requests, newest first, with shortlist/selected counts" })
  list(@Req() req: { user: { id: string } }) {
    return this.svc.listForClient(req.user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One request, with a card per shortlisted staff member (no phone/Aadhaar/address)' })
  get(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.svc.getForClient(req.user.id, id);
  }

  @Post(':id/select')
  @ApiOperation({ summary: 'Choose a shortlisted staff member' })
  @ApiBody({ schema: { type: 'object', required: ['staff_id'], properties: { staff_id: { type: 'string' }, note: { type: 'string' } } } })
  select(@Req() req: { user: { id: string } }, @Param('id') id: string, @Body() body: { staff_id?: string; note?: string }) {
    return this.svc.selectByClient(req.user.id, id, body);
  }

  @Post(':id/reject-shortlist')
  @ApiOperation({ summary: 'None of the shortlist will do — the RM is asked for a new one' })
  @ApiBody({ schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } } })
  rejectShortlist(@Req() req: { user: { id: string } }, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.svc.rejectShortlist(req.user.id, id, body);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Withdraw the request' })
  @ApiBody({ schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } } })
  cancel(@Req() req: { user: { id: string } }, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.svc.cancelByClient(req.user.id, id, body);
  }
}

/** The RM/BM side: the queue, matching, shortlisting, and handing over to a placement. */
@ApiTags('RM Operations', 'Staff Requests')
@ApiBearerAuth()
@Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
@Controller({ path: 'rm', version: '1' })
export class RmStaffRequestsController {
  constructor(private readonly svc: StaffRequestsService) {}

  @Get('staff-requests')
  @ApiOperation({ summary: 'Request queue — RM: own + unassigned in branch; BM: branch; Admin: all. Includes sla_breached.' })
  @ApiQuery({ name: 'status', required: false, description: 'Comma list, e.g. NEW,ASSIGNED' })
  @ApiQuery({ name: 'open', required: false, description: 'true = only NEW/ASSIGNED/SHORTLISTED/CLIENT_SELECTED' })
  @ApiQuery({ name: 'series', required: false })
  @ApiQuery({ name: 'branch_id', required: false, description: 'Admin only' })
  list(
    @Req() req: { user: AuthUser },
    @Query() q: { status?: string; series?: string; branch_id?: string; open?: string },
  ) {
    return this.svc.list(req.user, q);
  }

  @Post('staff-requests')
  @ApiOperation({ summary: 'Raise a request for a client (client_id) or a lead (lead_name + lead_phone [+ lead_city])' })
  @ApiBody(REQUEST_BODY)
  create(@Req() req: { user: AuthUser }, @Body() body: Record<string, unknown>) {
    return this.svc.createFromRm(req.user, body);
  }

  @Get('staff-requests/:id')
  @ApiOperation({ summary: 'One request with client, RM, branch and every candidate' })
  get(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.svc.getForStaffUser(id, req.user);
  }

  @Get('staff-requests/:id/candidates')
  @ApiOperation({ summary: 'Staff who could fill it, best first, with the reasons' })
  candidates(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.svc.candidates(req.user, id);
  }

  @Post('staff-requests/:id/shortlist')
  @ApiOperation({ summary: 'Put staff forward to the client' })
  @ApiBody({ schema: { type: 'object', required: ['staff_ids'], properties: { staff_ids: { type: 'array', items: { type: 'string' } }, rm_note: { type: 'string' } } } })
  shortlist(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { staff_ids?: string[]; rm_note?: string }) {
    return this.svc.shortlist(req.user, id, body);
  }

  @Delete('staff-requests/:id/shortlist/:staffId')
  @ApiOperation({ summary: 'Take a staff member back off the shortlist' })
  withdraw(@Req() req: { user: AuthUser }, @Param('id') id: string, @Param('staffId') staffId: string) {
    return this.svc.withdraw(req.user, id, staffId);
  }

  @Post('staff-requests/:id/select')
  @ApiOperation({ summary: "Choose on the client's behalf (phone clients, leads)" })
  @ApiBody({ schema: { type: 'object', required: ['staff_id'], properties: { staff_id: { type: 'string' }, note: { type: 'string' } } } })
  select(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { staff_id?: string; note?: string }) {
    return this.svc.selectByRm(req.user, id, body);
  }

  @Patch('staff-requests/:id/assign')
  @ApiOperation({ summary: 'BM/Admin: give the request to an RM' })
  @ApiBody({ schema: { type: 'object', required: ['rm_id'], properties: { rm_id: { type: 'string' } } } })
  assign(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { rm_id?: string }) {
    return this.svc.assign(req.user, id, body);
  }

  @Patch('staff-requests/:id/client')
  @ApiOperation({ summary: 'A lead became a client — attach the client account' })
  @ApiBody({ schema: { type: 'object', required: ['client_id'], properties: { client_id: { type: 'string' } } } })
  attachClient(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { client_id?: string }) {
    return this.svc.attachClient(req.user, id, body);
  }

  @Post('staff-requests/:id/link-placement')
  @ApiOperation({ summary: 'Mark an already-made placement as filling this request' })
  @ApiBody({ schema: { type: 'object', required: ['placement_id'], properties: { placement_id: { type: 'string' } } } })
  linkPlacement(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { placement_id?: string }) {
    return this.svc.linkPlacement(req.user, id, body);
  }

  @Post('staff-requests/:id/cancel')
  @ApiOperation({ summary: 'Close the request (reason required); the client is told' })
  @ApiBody({ schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } } })
  cancel(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.svc.cancelByRm(req.user, id, body);
  }

  @Post('replacements/:id/convert')
  @ApiOperation({ summary: "Turn a client's replacement request into a staff request (same series and terms unless overridden)" })
  convert(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.svc.convertReplacement(req.user, id, body ?? {});
  }
}
