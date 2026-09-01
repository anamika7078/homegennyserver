import {
  Controller, Get, Post, Param, Query, Body, Req, UseGuards,
  ParseIntPipe, DefaultValuePipe, Res,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles, UserRole } from '../../auth/decorators/roles.decorator';
import { FinancePayrollService } from './payroll.service';

// Spec: EOR Payroll — RM=Y, BM=Y, Finance=Y, Admin=Y, Staff/Client=no access.
// Confirmed live in the audit: GET /finance/payroll returned 200 for STAFF and CLIENT.
@ApiTags('Finance — Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.BM, UserRole.FINANCE, UserRole.ADMIN)
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

  @Get('payout-readiness')
  @ApiOperation({
    summary: 'Whether real payouts can be made',
    description:
      'Returns `{ configured, hint }`. When false, disbursement still runs but records a ' +
      'SIMULATED result — no money moves. Lets the UI say so before anyone clicks Disburse.',
  })
  payoutReadiness() {
    return this.service.payoutReadiness();
  }

  @Get('staff/:staffId/bank-account')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: "A staff member's payout account",
    description: 'The account number comes back masked — only the last four digits.',
  })
  getBankAccount(@Param('staffId') staffId: string) {
    return this.service.getStaffBankAccount(staffId);
  }

  @Post('staff/:staffId/bank-account')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Add or replace the account salary is paid into',
    description:
      'Validates the IFSC shape and account number before saving. Replacing the details clears ' +
      'the cached RazorpayX fund account, which was bound to the old ones.',
  })
  upsertBankAccount(
    @Param('staffId') staffId: string,
    @Body() body: { account_holder_name: string; account_number: string; ifsc: string; bank_name?: string },
    @Req() req: { user?: { id?: string } },
  ) {
    return this.service.upsertStaffBankAccount(staffId, body, req.user?.id);
  }

  @Post(':id/approve')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Approve an EOR payroll record so it can be paid',
    description:
      'The EOR path had no approval step — disbursement would pay whatever a cron had written. ' +
      'Approving locks the record; only an APPROVED record can be disbursed.',
  })
  approve(@Param('id') id: string, @Req() req: { user?: { id?: string } }) {
    return this.service.approvePayrollRecord(id, req.user?.id);
  }

  @Post(':id/disburse')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Pay a payroll record out to the staff member',
    description:
      'Uses RazorpayX Payouts. Requires the record to be APPROVED and the staff member to have ' +
      'a bank account on file. `disbursed_at` is stamped only when the payout actually settles — ' +
      'a PROCESSING or SIMULATED result leaves it null.',
  })
  disburse(@Param('id') id: string, @Req() req: { user?: { id?: string } }) {
    return this.service.triggerDisbursement(id, req.user?.id);
  }
}
