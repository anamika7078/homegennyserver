import { Controller, Get, Post, Param, Body, Query, Req, Headers, UseGuards, DefaultValuePipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles, UserRole } from '../../auth/decorators/roles.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { FinanceSettlementService } from './settlement.service';
import { CreditNoteService } from './credit-note.service';

@ApiTags('Finance — Settlements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.BM, UserRole.FINANCE, UserRole.ADMIN)
@Controller({ path: 'finance/settlements', version: '1' })
export class FinanceSettlementController {
  constructor(
    private readonly service: FinanceSettlementService,
    private readonly creditNotes: CreditNoteService,
  ) {}

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

  // Razorpay's servers call this, not a logged-in user — cannot carry a Bearer
  // JWT, so it must stay public. What authenticates it instead is the HMAC
  // signature over the raw body, verified before the payload is touched.
  @Post('webhook')
  @Public()
  @ApiOperation({
    summary: 'Razorpay webhook handler — match payment to invoice',
    description:
      'Requires a valid X-Razorpay-Signature over the raw request body, checked against ' +
      'RAZORPAY_WEBHOOK_SECRET. Returns 401 if the secret is unset or the signature does not match.',
  })
  handleWebhook(
    @Body() body: any,
    @Headers('x-razorpay-signature') signature: string,
    @Req() req: { rawBody?: Buffer },
  ) {
    this.service.verifyWebhookSignature(req.rawBody, signature);
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

  @Get('credit-notes')
  @ApiOperation({ summary: 'List credit notes' })
  @ApiQuery({ name: 'clientId', required: false })
  listCreditNotes(@Query('clientId') clientId?: string) {
    return this.creditNotes.list(clientId || undefined);
  }

  @Get(':id/credit-notes')
  @ApiOperation({
    summary: 'Credit notes issued against one invoice',
    description: 'Partial credits mean an invoice can carry several.',
  })
  creditNotesForInvoice(@Param('id') id: string) {
    return this.creditNotes.getForInvoice(id);
  }

  @Post(':id/credit-note/preview')
  @ApiOperation({
    summary: 'What crediting this invoice would produce',
    description:
      'Computes the amount and the tax reversal without issuing anything or consuming a number ' +
      'from the credit-note series. Omit `amount` for a full reversal of whatever is uncredited.',
  })
  previewCreditNote(@Param('id') id: string, @Body() body: { amount?: number }) {
    return this.creditNotes.preview(id, body?.amount);
  }

  @Post(':id/credit-note')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Issue a credit note against an invoice',
    description:
      'Creates a real document with its own number from the customer series, reversing tax in ' +
      'proportion to the amount credited. Partial credits are allowed — a dispute is usually ' +
      'about one line, not the whole invoice — and only a full reversal moves the invoice to ' +
      'CREDIT_NOTE.',
  })
  creditNote(
    @Param('id') id: string,
    @Body() body: { reason: string; amount?: number },
    @Req() req: { user?: { id?: string } },
  ) {
    return this.service.issueCreditNote(id, body.reason, body.amount, req.user?.id);
  }
}
