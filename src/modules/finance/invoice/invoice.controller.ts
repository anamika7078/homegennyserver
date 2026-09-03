import {
  Controller, Get, Post, Param, Query, Body, Req, UseGuards,
  DefaultValuePipe, ParseIntPipe, Res,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles, UserRole } from '../../auth/decorators/roles.decorator';
import { FinanceInvoiceService } from './invoice.service';
import { ConsolidatedInvoiceService } from './consolidated-invoice.service';

// Spec: Client Invoicing — RM=R, BM=R, Finance=Y, Admin=Y. (Client=Y refers to a
// client-facing "view my invoices" capability that has no endpoint in this
// controller today — see audit §NOT IMPLEMENTED; not added here, Phase 1 is
// authz-only.) Staff has no access.
@ApiTags('Finance — Invoices')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.BM, UserRole.FINANCE, UserRole.ADMIN)
@Controller({ path: 'finance/invoices', version: '1' })
export class FinanceInvoiceController {
  constructor(
    private readonly service: FinanceInvoiceService,
    private readonly consolidated: ConsolidatedInvoiceService,
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
    @Body() body: { customer_id: string; month: number; year: number },
    @Req() req: { user?: { id?: string } },
  ) {
    // generateOrAmend, not generate: this is the button on the unit-code
    // screen, and pressing it after a colleague joined mid-month has to extend
    // the draft rather than fail with "an invoice already exists".
    return this.consolidated.generateOrAmend(body.customer_id, body.month, body.year, req.user?.id);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Invoice status summary for dashboard' })
  getSummary() {
    return this.service.getInvoiceSummary();
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

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve an invoice' })
  approve(@Param('id') id: string) {
    return this.service.approveInvoice(id);
  }

  @Post(':id/send')
  @ApiOperation({ summary: 'Mark invoice as sent to client' })
  send(@Param('id') id: string) {
    return this.service.sendInvoice(id);
  }
}
