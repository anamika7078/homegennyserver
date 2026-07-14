import {
  Controller, Get, Post, Param, Query, Body, UseGuards,
  ParseIntPipe, DefaultValuePipe, Res,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
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

  @Get('lookup')
  @ApiOperation({ summary: 'Lookup EOR staff or internal employee by code' })
  @ApiQuery({ name: 'code', required: true })
  lookupByCode(@Query('code') code: string) {
    return this.service.lookupByCode(code);
  }

  @Get('attendance-preview')
  @ApiOperation({ summary: 'Preview attendance-based payroll / invoice by employee code' })
  @ApiQuery({ name: 'code', required: true })
  @ApiQuery({ name: 'month', required: true })
  @ApiQuery({ name: 'year', required: true })
  previewAttendanceByCode(
    @Query('code') code: string,
    @Query('month', ParseIntPipe) month: number,
    @Query('year', ParseIntPipe) year: number,
  ) {
    return this.service.previewAttendanceByCode(code, month, year);
  }

  @Post('attendance-generate')
  @ApiOperation({ summary: 'Generate attendance-based payroll / invoice by employee code' })
  generateAttendanceByCode(
    @Body() body: { code: string; month: number; year: number },
  ) {
    return this.service.generateAttendanceByCode(body.code, body.month, body.year);
  }

  @Get('attendance-preview/download')
  @ApiOperation({ summary: 'Download attendance payroll preview as HTML' })
  @ApiQuery({ name: 'code', required: true })
  @ApiQuery({ name: 'month', required: true })
  @ApiQuery({ name: 'year', required: true })
  async downloadAttendancePreview(
    @Query('code') code: string,
    @Query('month', ParseIntPipe) month: number,
    @Query('year', ParseIntPipe) year: number,
    @Res() res: Response,
  ) {
    const preview = await this.service.previewAttendanceByCode(code, month, year);
    const html = this.service.buildPreviewHtml(preview as Record<string, unknown>);
    const filename = `payroll-${code}-${month}-${year}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);
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
