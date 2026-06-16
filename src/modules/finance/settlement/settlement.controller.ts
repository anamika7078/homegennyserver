import { Controller, Get, Post, Param, Body, Query, UseGuards, DefaultValuePipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { FinanceSettlementService } from './settlement.service';

@ApiTags('Finance — Settlements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'finance/settlements', version: '1' })
export class FinanceSettlementController {
  constructor(private readonly service: FinanceSettlementService) {}

  @Get()
  @ApiOperation({ summary: 'List payment settlements' })
  @ApiQuery({ name: 'status', required: false })
  listPayments(@Query('status', new DefaultValuePipe('')) status: string) {
    return this.service.listPayments(status || undefined);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Settlement summary stats' })
  getStats() {
    return this.service.getSettlementStats();
  }

  @Post('webhook')
  @ApiOperation({ summary: 'Razorpay webhook handler — match payment to invoice' })
  handleWebhook(@Body() body: any) {
    return this.service.matchWebhookEvent(body);
  }

  @Post(':id/mark-settled')
  @ApiOperation({ summary: 'Manually mark an invoice as settled' })
  markSettled(
    @Param('id') id: string,
    @Body() body: { payment_ref: string },
  ) {
    return this.service.markSettled(id, body.payment_ref);
  }

  @Post(':id/credit-note')
  @ApiOperation({ summary: 'Issue a credit note for an invoice' })
  creditNote(
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.service.issueCreditNote(id, body.reason);
  }
}
