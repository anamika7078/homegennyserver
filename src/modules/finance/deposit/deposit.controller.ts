import { Controller, Get, Post, Param, Body, Query, Req, UseGuards, DefaultValuePipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles, UserRole } from '../../auth/decorators/roles.decorator';
import { DepositService } from './deposit.service';

@ApiTags('Finance — Deposits')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.BM, UserRole.FINANCE, UserRole.ADMIN)
@Controller({ path: 'finance/deposits', version: '1' })
export class DepositController {
  constructor(private readonly service: DepositService) {}

  @Get()
  @ApiOperation({ summary: 'List staff deposits with status filter' })
  @ApiQuery({ name: 'status', required: false, enum: ['PAID', 'UNPAID', 'FORFEITED'] })
  listDeposits(@Query('status', new DefaultValuePipe('')) status: string) {
    return this.service.listDeposits(status as 'PAID' | 'UNPAID' | 'FORFEITED' | undefined);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Deposit summary statistics' })
  getStats() {
    return this.service.getDepositStats();
  }

  @Post(':staffId/event')
  @ApiOperation({
    summary: 'Record deposit event (refund, forfeiture, partial refund)',
    description:
      'Resolves the staff member\'s most recent deposit. PARTIAL_REFUND requires refund_amount; ' +
      'REFUND refunds the full held amount and FORFEITURE refunds nothing. A deposit that is ' +
      'already resolved is rejected rather than overwritten.',
  })
  recordEvent(
    @Param('staffId') staffId: string,
    @Body() body: {
      event: 'REFUND' | 'FORFEITURE' | 'PARTIAL_REFUND';
      notes?: string;
      scenario_code?: string;
      refund_amount?: number;
    },
    @Req() req: { user?: { id?: string } },
  ) {
    return this.service.recordDepositEvent(
      staffId,
      body.event,
      body.notes,
      body.scenario_code,
      body.refund_amount,
      req.user?.id,
    );
  }
}
