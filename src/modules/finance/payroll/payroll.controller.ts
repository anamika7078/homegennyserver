import { Controller, Get, Post, Param, Query, Body, UseGuards, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { FinancePayrollService } from './payroll.service';

@ApiTags('Finance — Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'finance/payroll', version: '1' })
export class FinancePayrollController {
  constructor(private readonly service: FinancePayrollService) {}

  @Get()
  @ApiOperation({ summary: 'List payroll records with optional month/year filter' })
  @ApiQuery({ name: 'month', required: false })
  @ApiQuery({ name: 'year',  required: false })
  listPayrollRuns(
    @Query('month', new DefaultValuePipe(0), ParseIntPipe) month: number,
    @Query('year',  new DefaultValuePipe(0), ParseIntPipe) year:  number,
  ) {
    return this.service.listPayrollRuns(month || undefined, year || undefined);
  }

  @Post('preview')
  @ApiOperation({ summary: 'Preview payroll calculation for a placement (no DB write)' })
  previewPayroll(
    @Body() body: { placement_id: string; month: number; year: number },
  ) {
    return this.service.previewPayroll(body.placement_id, body.month, body.year);
  }

  @Post('confirm-batch')
  @ApiOperation({ summary: 'Confirm and post payroll batch for all CONFIRMED placements' })
  confirmBatch(@Body() body: { month: number; year: number }) {
    return this.service.confirmPayrollBatch(body.month, body.year);
  }

  @Post(':id/disburse')
  @ApiOperation({ summary: 'Trigger Razorpay disbursement for a payroll record' })
  disburse(@Param('id') id: string) {
    return this.service.triggerDisbursement(id);
  }
}
