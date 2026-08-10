import { Controller, Get, Post, Param, Query, UseGuards, DefaultValuePipe, Res } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles, UserRole } from '../../auth/decorators/roles.decorator';
import { FinanceInvoiceService } from './invoice.service';

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
  constructor(private readonly service: FinanceInvoiceService) {}

  @Get()
  @ApiOperation({ summary: 'List client invoices with optional status filter' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'APPROVED', 'SENT', 'PAID', 'OVERDUE', 'CREDIT_NOTE'] })
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
