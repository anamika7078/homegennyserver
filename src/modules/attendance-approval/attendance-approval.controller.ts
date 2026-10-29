import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { AttendanceApprovalService, DEEMED_AFTER_HOURS } from './attendance-approval.service';

type Req = { user: { id: string; role: string } };

/** The client confirming (or disputing) the days their staff mark from the app. */
@ApiTags('Client Mobile App', 'Mobile App Client APIs')
@ApiBearerAuth()
@Roles(UserRole.CLIENT)
@Controller({ path: 'client/attendance', version: '1' })
export class ClientAttendanceApprovalController {
  constructor(private readonly svc: AttendanceApprovalService) {}

  @Get('approvals')
  @ApiOperation({
    summary: 'Staff-app days at my home, to confirm',
    description:
      'Default: the days waiting on me (status PENDING), last 30 days. status=ALL|APPROVED|DEEMED|DISPUTED|APPROVED_PAPER. ' +
      `Each item: date, staff, check_in/check_out (+ _ist HH:MM), client_status, deemed_at (an unanswered day counts as ` +
      `confirmed after ${DEEMED_AFTER_HOURS}h). pending_count / disputed_count cover all dates.`,
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'staff_id', required: false })
  list(@Req() req: Req, @Query() q: { status?: string; from?: string; to?: string; staff_id?: string }) {
    return this.svc.listForClient(req.user, q);
  }

  @Post('approve')
  @ApiOperation({
    summary: 'Confirm days — some (ids) or every waiting day in a range (the week at once)',
    description: 'Body { ids: [...] } or { from, to } (YYYY-MM-DD), optional staff_id. Returns { approved, ids }.',
  })
  @ApiBody({ schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, from: { type: 'string' }, to: { type: 'string' }, staff_id: { type: 'string' } } } })
  approve(@Req() req: Req, @Body() body: { ids?: string[]; from?: string; to?: string; staff_id?: string }) {
    return this.svc.approveByClient(req.user, body ?? {});
  }

  @Post(':id/dispute')
  @ApiOperation({
    summary: 'This day is not right',
    description:
      'Body { reason (min 5), actual?: ABSENT | HALF_DAY | LATE | LEFT_EARLY | OTHER }. The day is not paid or billed ' +
      'until the RM resolves it; the RM is notified. 400 when the day is already on an approved invoice.',
  })
  dispute(@Req() req: Req, @Param('id') id: string, @Body() body: { reason?: string; actual?: string }) {
    return this.svc.disputeByClient(req.user, id, body ?? {});
  }
}

/** The RM's side: disputes to resolve, and confirming for clients who do not use the app. */
@ApiTags('RM Operations')
@ApiBearerAuth()
@Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
@Controller({ path: 'rm/attendance', version: '1' })
export class RmAttendanceApprovalController {
  constructor(private readonly svc: AttendanceApprovalService) {}

  @Get('disputes')
  @ApiOperation({ summary: 'Days clients disputed on my placements (all for BM/Admin), oldest first' })
  disputes(@Req() req: Req) {
    return this.svc.disputesForRm(req.user);
  }

  @Get('awaiting-client')
  @ApiOperation({ summary: 'Staff-app days still waiting on the client — to confirm on behalf of clients who do not use the app' })
  @ApiQuery({ name: 'client_id', required: false })
  awaiting(@Req() req: Req, @Query('client_id') clientId?: string) {
    return this.svc.pendingForRm(req.user, { client_id: clientId || undefined });
  }

  @Post('approve-on-behalf')
  @ApiOperation({
    summary: 'Record the client\'s confirmation for them',
    description: 'Body { ids, note (how they confirmed, min 5) }. Recorded as the RM\'s, with the note.',
  })
  approveOnBehalf(@Req() req: Req, @Body() body: { ids?: string[]; note?: string }) {
    return this.svc.approveOnBehalf(req.user, body ?? {});
  }

  // Literal paths before ':id/…' so they are not read as an id.
  @Post('jobs/deem')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: `Admin: run now the hourly job that deems days unanswered for ${DEEMED_AFTER_HOURS}h approved` })
  runDeem() {
    return this.svc.deemUnanswered();
  }

  @Post('jobs/remind')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin: send now the 9 pm "confirm today\'s attendance" notes to clients' })
  runRemind() {
    return this.svc.remindClients();
  }

  @Post(':id/resolve')
  @ApiOperation({
    summary: 'Resolve a disputed day',
    description: 'Body { status: PRESENT | ABSENT | HALF_DAY, note (min 5) }. The day counts again as decided; client and staff are told.',
  })
  resolve(@Req() req: Req, @Param('id') id: string, @Body() body: { status?: string; note?: string }) {
    return this.svc.resolveByRm(req.user, id, body ?? {});
  }
}
