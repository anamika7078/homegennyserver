import { Controller, Get, Post, Param, Query, Body, Req, UseGuards, DefaultValuePipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles, UserRole } from '../../auth/decorators/roles.decorator';
import { ExitSettlementService, type ExitReason } from './exit-settlement.service';

@ApiTags('Finance — Exit Settlements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.FINANCE, UserRole.ADMIN, UserRole.BM)
@Controller({ path: 'finance/exit-settlements', version: '1' })
export class ExitSettlementController {
  constructor(private readonly service: ExitSettlementService) {}

  @Get()
  @ApiOperation({ summary: 'List exit settlements' })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'APPROVED', 'SETTLED', 'CANCELLED'] })
  list(@Query('status', new DefaultValuePipe('')) status: string) {
    return this.service.list(status || undefined);
  }

  @Get('pending')
  @ApiOperation({
    summary: 'Exited placements with no settlement yet',
    description: 'The work Finance still owes — every exit that has not been settled.',
  })
  pending() {
    return this.service.pending();
  }

  @Post('preview')
  @ApiOperation({
    summary: 'What an exit would settle to',
    description:
      'Applies the spec fee matrix without writing anything. Reports both sides separately: ' +
      'the cancellation fee owed by the client, and the final month, goodwill and deposit owed ' +
      'to the staff member.',
  })
  preview(
    @Body() body: { placement_id: string; exit_date: string; reason: ExitReason; trial_extended?: boolean },
  ) {
    return this.service.preview({
      placementId: body.placement_id,
      exitDate: body.exit_date,
      reason: body.reason,
      trialExtended: body.trial_extended,
    });
  }

  @Post()
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Create a draft settlement for an exit' })
  create(
    @Body() body: {
      placement_id: string; exit_date: string; reason: ExitReason;
      trial_extended?: boolean; scenario_code?: string;
    },
    @Req() req: { user?: { id?: string } },
  ) {
    return this.service.create({
      placementId: body.placement_id,
      exitDate: body.exit_date,
      reason: body.reason,
      trialExtended: body.trial_extended,
      scenarioCode: body.scenario_code,
      actorId: req.user?.id,
    });
  }

  @Post(':id/approve')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Approve a draft settlement' })
  approve(@Param('id') id: string, @Req() req: { user?: { id?: string } }) {
    return this.service.approve(id, req.user?.id);
  }

  @Post(':id/settle')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Mark an approved settlement as paid',
    description:
      'Resolves the deposit in the same step — refunded or forfeited per the fee band — so it ' +
      'cannot be left for someone to remember separately.',
  })
  settle(@Param('id') id: string, @Req() req: { user?: { id?: string } }) {
    return this.service.settle(id, req.user?.id);
  }
}
