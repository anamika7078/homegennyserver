import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { AuthUser } from '../../common/guards/branch-scope.util';
import { SnapshotService } from './snapshot.service';

@ApiTags('RM Portal')
@ApiBearerAuth()
@Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
@Controller({ path: 'rm', version: '1' })
export class RmSnapshotController {
  constructor(private readonly svc: SnapshotService) {}

  @Get('snapshot')
  @ApiOperation({
    summary: 'Staff snapshot: availability, current deployments and the day\'s work, in one read',
    description:
      'RM: own staff and placements; BM: branch; Admin: all (or ?branch_id). summary has counts for the three ' +
      'blocks; staff[] is every S5 staff member with an availability state (AVAILABLE, PARTLY_AVAILABLE, ' +
      'FREE_SOON, DEPLOYED, ON_LEAVE, ON_HOLD); deployments[] is every active placement with today\'s ' +
      'attendance (late/no-show measured from shift_start), check-in distance, care tasks / meals, report, ' +
      'instructions, a RED/AMBER/NOT_STARTED/GREEN status and the flags behind it — RED first. ' +
      'docs/STAFF_SNAPSHOT_PLAN.md.',
  })
  @ApiQuery({ name: 'date', required: false, description: 'YYYY-MM-DD (IST), default today — for the day\'s work only' })
  @ApiQuery({ name: 'series', required: false, enum: ['UC', 'SC', 'CK'] })
  @ApiQuery({ name: 'branch_id', required: false, description: 'Admin only' })
  rm(@Req() req: { user: AuthUser }, @Query() q: { date?: string; series?: string; branch_id?: string }) {
    return this.svc.rmSnapshot(req.user, q);
  }
}

@ApiTags('Client Mobile App', 'Mobile App Client APIs')
@ApiBearerAuth()
@Roles(UserRole.CLIENT)
@Controller({ path: 'client', version: '1' })
export class ClientSnapshotController {
  constructor(private readonly svc: SnapshotService) {}

  @Get('snapshot')
  @ApiOperation({
    summary: '"Today at home": every staff member placed with me, how today is going, my last 7 days, my open requests',
    description:
      'staff[]: one card per active placement — deployment (type, trial end, shift start), today (attendance, ' +
      'check-in/out, tasks or meals done, next task), status_today (RED/AMBER/NOT_STARTED/GREEN), a one-line ' +
      'message, and last_7_days. requests[]: open staff requests. replacements[]: replacements under RM review. ' +
      'No staff phone, Aadhaar or address. docs/MOBILE_BRIEF_STAFF_SNAPSHOT.md.',
  })
  @ApiQuery({ name: 'date', required: false, description: 'YYYY-MM-DD (IST), default today' })
  client(@Req() req: { user: AuthUser }, @Query() q: { date?: string }) {
    return this.svc.clientSnapshot(req.user.id, q);
  }
}
