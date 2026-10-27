import {
  BadRequestException, Controller, Get, Post, Param, Query, Body, Req, DefaultValuePipe, ParseIntPipe, Res,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles, UserRole } from '../../auth/decorators/roles.decorator';
import { FinanceInvoiceService } from './invoice.service';
import { ConsolidatedInvoiceService } from './consolidated-invoice.service';
import { InvoiceCorrectionService } from './invoice-correction.service';
import { SentInvoiceCorrectionService } from './sent-invoice-correction.service';
import { FinanceOversightService } from './finance-oversight.service';
import { parseTillDate } from '../../../common/finance/period.util';

// Spec: Client Invoicing — RM=R, BM=R, Finance=Y, Admin=Y. (Client=Y refers to a
// client-facing "view my invoices" capability that has no endpoint in this
// controller today — see audit §NOT IMPLEMENTED; not added here, Phase 1 is
// authz-only.) Staff has no access.
@ApiTags('Finance — Invoices')
@ApiBearerAuth()
@Roles(UserRole.RM, UserRole.BM, UserRole.FINANCE, UserRole.ADMIN)
@Controller({ path: 'finance/invoices', version: '1' })
export class FinanceInvoiceController {
  constructor(
    private readonly service: FinanceInvoiceService,
    private readonly consolidated: ConsolidatedInvoiceService,
    private readonly correction: InvoiceCorrectionService,
    private readonly sentCorrection: SentInvoiceCorrectionService,
    private readonly oversight: FinanceOversightService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List client invoices with optional status filter' })
  @ApiQuery({
    name: 'status', required: false,
    enum: ['DRAFT', 'APPROVED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CREDIT_NOTE', 'CANCELLED'],
  })
  @ApiQuery({ name: 'page',   required: false })
  listInvoices(
    @Query('status', new DefaultValuePipe('')) status: string,
    @Query('page',   new DefaultValuePipe('1'))  page:   string,
  ) {
    return this.service.listInvoices({
      status: status || undefined,
      page:   parseInt(page, 10) || 1,
    });
  }

  @Get('by-unit-code')
  @ApiOperation({
    summary: 'A client, their placements and their invoice status, by unit code',
    description:
      'The way Finance identifies a client. Returns who they are, what is running ' +
      'for them this period — permanent and temporary listed apart — whether an ' +
      'invoice already exists, and what an invoice issued now would carry.',
  })
  @ApiQuery({ name: 'unit_code', required: true })
  @ApiQuery({ name: 'month', required: true })
  @ApiQuery({ name: 'year', required: true })
  byUnitCode(
    @Query('unit_code') unitCode: string,
    @Query('month', ParseIntPipe) month: number,
    @Query('year', ParseIntPipe) year: number,
  ) {
    return this.consolidated.lookupByUnitCode(unitCode, month, year);
  }

  @Get('consolidated/pending')
  @ApiOperation({
    summary: 'Customers with un-invoiced payroll for a period',
    description: 'The month-end worklist for consolidated invoicing — one row per customer.',
  })
  @ApiQuery({ name: 'month', required: true })
  @ApiQuery({ name: 'year', required: true })
  consolidatedPending(
    @Query('month', ParseIntPipe) month: number,
    @Query('year', ParseIntPipe) year: number,
  ) {
    return this.consolidated.pendingForPeriod(month, year);
  }

  @Get('consolidated/preview')
  @ApiOperation({
    summary: 'What one customer’s consolidated invoice would contain',
    description:
      'Computes the document without writing it or consuming an invoice number. ' +
      '`missing_for_tax_invoice` lists anything still needed before it can be a Tax Invoice ' +
      'rather than a Bill of Supply.',
  })
  @ApiQuery({ name: 'customerId', required: true })
  @ApiQuery({ name: 'month', required: true })
  @ApiQuery({ name: 'year', required: true })
  consolidatedPreview(
    @Query('customerId') customerId: string,
    @Query('month', ParseIntPipe) month: number,
    @Query('year', ParseIntPipe) year: number,
  ) {
    return this.consolidated.preview(customerId, month, year);
  }

  @Post('consolidated/generate')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Issue one consolidated invoice for a customer and period',
    description:
      'Replaces the per-placement invoice: every staff member becomes a line-item group. ' +
      'Takes the next number from the customer’s own series inside the transaction, and links ' +
      'each payroll row to the invoice so the same work cannot be billed twice. ' +
      'Called again for the same period it amends the open DRAFT — someone who joined ' +
      'mid-month is folded into the existing invoice, keeping its number — and refuses ' +
      'once the invoice has been approved or sent.',
  })
  consolidatedGenerate(
    @Body() body: { customer_id: string; month: number; year: number; to_date?: string },
    @Req() req: { user?: { id?: string } },
  ) {
    // to_date: invoice up to that day (e.g. the 7th) — the next invoice of the
    // month then starts on the 8th. Omitted, it is the rest of the month.
    const till = parseTillDate(body.to_date, Number(body.month), Number(body.year));
    // generateOrAmend, not generate: this is the button on the unit-code
    // screen, and pressing it after a colleague joined mid-month has to extend
    // the draft rather than fail with "an invoice already exists".
    return this.consolidated.generateOrAmend(body.customer_id, Number(body.month), Number(body.year), req.user?.id, till);
  }

  @Post('billing-cycle/run')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Raise the DRAFT invoices of every client whose billing period ends on a date',
    description:
      'What the morning job does for yesterday, on demand: weekly clients on the 7th/14th/21st/month end, ' +
      'fortnightly on the 15th/month end, monthly at month end; MANUAL clients never. Already-invoiced ' +
      'periods are skipped, so running it twice bills nothing twice. Use it to catch up after downtime.',
  })
  runCycleBilling(@Body() body: { date?: string }, @Req() req: { user?: { id?: string } }) {
    const date = String(body?.date ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('date must be YYYY-MM-DD.');
    return this.consolidated.runCycleBilling(date, req.user?.id);
  }

  // Literal paths before ':id' — a literal after a parameter route is swallowed by it.
  @Get('attention')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'What is stuck: draft invoices holding salary, held slips, rate reviews, sent invoices to correct, arrears',
    description:
      'draft_invoices_waiting / slips_held: older than the 3-day grace. rate_reviews_open: placements waiting ' +
      'for their RM after a rejection. sent_invoices_needing_correction: a rate back-dated over a sent invoice, ' +
      'not corrected since. arrears_pending: owed to staff, waiting for their next payroll. counts summarises.',
  })
  attention() {
    return this.oversight.attention();
  }

  @Post('attention/notify')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Send the morning attention note now (it also runs daily at 09:30 IST)' })
  notifyAttention() {
    return this.oversight.notifyDaily();
  }

  @Get('summary')
  @ApiOperation({ summary: 'Invoice status summary for dashboard' })
  getSummary() {
    return this.service.getInvoiceSummary();
  }

  @Get(':id/salary-slips')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Salary slip for every staff member on this invoice, same days, one page each',
    description:
      'Built from the payroll rows the invoice billed, so the slips and the invoice cannot disagree. ' +
      'Printable HTML — one slip per page.',
  })
  async salarySlips(@Param('id') id: string, @Res() res: Response) {
    const html = await this.service.generateSalarySlipsHtml(id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="salary-slips-${id}.html"`);
    res.send(html);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Download invoice as HTML file' })
  async downloadInvoice(@Param('id') id: string, @Res() res: Response) {
    const html = await this.service.generateInvoiceHtml(id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${id}.html"`);
    res.send(html);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get invoice detail with line items' })
  getInvoice(@Param('id') id: string) {
    return this.service.getInvoice(id);
  }

  // Finance only. The class allows RM and BM to read invoices, and approve and
  // send used to inherit that — so the RM who typed a placement's rate could
  // approve the invoice built on it and send it to the client.
  @Post(':id/approve')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Approve an invoice — and release the salary slips on it',
    description:
      'Records who approved it and when. The payroll rows on the invoice become payslips in the ' +
      'staff app and become payable; each staff member gets an in-app note. Until then a DRAFT ' +
      "invoice's payroll is not visible to staff and cannot be approved or paid.",
  })
  approve(@Param('id') id: string, @Req() req: { user?: { id?: string } }) {
    return this.service.approveInvoice(id, req.user?.id);
  }

  @Post(':id/send')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Mark invoice as sent to client' })
  send(@Param('id') id: string) {
    return this.service.sendInvoice(id);
  }

  @Post(':id/recalculate')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Recompute an unsent invoice with the current GST settings',
    description:
      'For a DRAFT or APPROVED consolidated invoice: rebuilds its lines and tax from its payroll ' +
      'using today’s Company & GST settings, keeping the same number and status. This is how a ' +
      'Bill of Supply raised before the GSTIN was entered becomes a Tax Invoice. Refused once sent.',
  })
  recalculate(@Param('id') id: string, @Req() req: { user?: { id?: string } }) {
    return this.consolidated.recalculate(id, req.user?.id);
  }

  @Post(':id/cancel')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Cancel an invoice',
    description:
      'Requires a reason. An unsent (DRAFT/APPROVED) invoice: its payroll is voided, so the work ' +
      "is billed again at today's figures. A sent invoice: its payroll is handed back unchanged " +
      '(correct it with a credit note).',
  })
  cancel(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: { user?: { id?: string } }) {
    return this.correction.cancel(id, body?.reason, req.user?.id);
  }

  @Post(':id/reject')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Reject an unsent invoice — wrong rate, wrong days, anything',
    description:
      'DRAFT or APPROVED only, and only the latest invoice of the month for the client. Reason ' +
      'required (min 10 characters). The invoice is cancelled with the reason recorded; its payroll ' +
      'rows are voided (kept in payroll_records_voided); every placement on it is marked ' +
      'REVIEW_NEEDED and its RM is notified. The client cannot be invoiced again until the RM ' +
      'corrects the rate (PATCH /placements/:id/terms) or confirms it ' +
      '(POST /placements/:id/rate-review/confirm). 400 if any salary on it was already paid.',
  })
  reject(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: { user?: { id?: string } }) {
    return this.correction.rejectUnsent(id, body?.reason, req.user?.id);
  }

  @Get(':id/correction')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Correcting a sent invoice — what it should have said, and the difference (changes nothing)',
    description:
      'SENT, PARTIALLY_PAID, OVERDUE or PAID. Each payroll line recomputed at the rate in force for its ' +
      'days and the current attendance, net of earlier corrections. totals.client_delta (before GST) and ' +
      'staff deltas; actions says what applying it would do: credit note, supplementary invoice, ' +
      'arrears to pay, overpayment recorded (never deducted).',
  })
  correctionPreview(@Param('id') id: string) {
    return this.sentCorrection.preview(id);
  }

  @Post(':id/correct')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Correct a sent invoice: credit note / supplementary invoice / arrears',
    description:
      'Body { reason } (min 10). The sent invoice is never edited. Over-billed → a credit note for the ' +
      'difference incl. GST (partial allowed on PAID). Under-billed → a DRAFT supplementary invoice. ' +
      'Staff under-paid → arrears added to their next payroll row. Staff over-paid → recorded only. ' +
      '400 when there is nothing to correct (change the rate on the placement first, back-dated).',
  })
  correct(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: { user?: { id?: string } }) {
    return this.sentCorrection.apply(id, body?.reason, req.user?.id);
  }

  @Get(':id/corrections')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Corrections made to this invoice, with their lines, credit notes and supplementary invoices' })
  corrections(@Param('id') id: string) {
    return this.sentCorrection.history(id);
  }

  @Get(':id/history')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Everything that happened to this invoice: raised, approved (who), rejected (why), payroll voided, corrected, credit notes' })
  history(@Param('id') id: string) {
    return this.oversight.invoiceHistory(id);
  }

  @Get(':id/voided-payroll')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Payroll rows voided from this invoice (rejection, cancel, re-run), with the reason' })
  voidedPayroll(@Param('id') id: string) {
    return this.correction.voidedFor({ invoiceId: id });
  }
}
