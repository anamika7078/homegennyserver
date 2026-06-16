import { Controller, Get, Post, Param, Query, UseGuards, DefaultValuePipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { FinanceInvoiceService } from './invoice.service';

@ApiTags('Finance — Invoices')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
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
