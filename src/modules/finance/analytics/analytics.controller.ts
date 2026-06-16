import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { FinanceAnalyticsService } from './analytics.service';

@ApiTags('Finance — Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'finance/analytics', version: '1' })
export class FinanceAnalyticsController {
  constructor(private readonly service: FinanceAnalyticsService) {}

  @Get()
  @ApiOperation({ summary: 'Finance analytics dashboard summary' })
  getDashboardSummary() {
    return this.service.getDashboardSummary();
  }

  @Get('revenue')
  @ApiOperation({ summary: 'Monthly revenue trend (management fee income)' })
  getRevenue() {
    return this.service.getRevenueDashboard();
  }

  @Get('gst')
  @ApiOperation({ summary: 'GST output liability summary' })
  getGst() {
    return this.service.getGstSummary();
  }

  @Get('esic-pf')
  @ApiOperation({ summary: 'Monthly ESIC + PF outflow summary' })
  getEsicPf() {
    return this.service.getEsicPfOutflow();
  }

  @Get('branch-pnl')
  @ApiOperation({ summary: 'Per-branch P&L overview' })
  getBranchPnl() {
    return this.service.getBranchPnl();
  }

  @Get('invoice-aging')
  @ApiOperation({ summary: 'Invoice aging report (overdue buckets)' })
  getInvoiceAging() {
    return this.service.getInvoiceAging();
  }
}
