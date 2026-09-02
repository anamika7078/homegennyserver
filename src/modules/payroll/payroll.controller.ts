import { Controller, Post, Param, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { PayrollService } from './payroll.service';
import { QueuePayrollBatchDto } from './dto/queue-payroll-batch.dto';

@ApiTags('Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller({ path: 'payroll', version: '1' })
export class PayrollController {
  constructor(private readonly service: PayrollService) {}

  @Post('calculate')
  @Roles(UserRole.BM, UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Preview payroll calculation (no DB write)' })
  calculate(@Body() body: { gross_salary: number; management_fee_percent: number }) {
    return this.service.calculatePayroll(body.gross_salary, body.management_fee_percent);
  }

  @Post('queue-batch')
  @Roles(UserRole.BM, UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Queue monthly payroll batch + invoice generation (demo aggregate)' })
  async queueBatch(@Body() body: QueuePayrollBatchDto) {
    return this.service.queuePayrollBatch(body.month, body.year, body.series);
  }

  /**
   * Kept so anything still calling it gets an explanation rather than a 404.
   *
   * It used to run a second payroll path that counted approved `shift_logs`
   * while every other route counted `staff_daily_attendance` — the ledger both
   * the mobile check-in and HR's screen mirror into. Two answers for one
   * person and month, decided by whichever route happened to run.
   */
  @Post('run/:placementId')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Retired — payroll runs from attendance, see /finance/payroll/attendance-generate' })
  async runPayroll(@Param('placementId') placementId: string) {
    throw new BadRequestException(
      `This route is retired. Payroll runs from the attendance ledger — ` +
        `POST /finance/payroll/attendance-generate with the staff code. ` +
        `(placement ${placementId})`,
    );
  }

  @Post('invoice/:invoiceId/payment-order')
  @Roles(UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Create Razorpay payment order for invoice' })
  async createPaymentOrder(@Param('invoiceId') invoiceId: string, @Body() body: { amount: number }) {
    return this.service.createRazorpayOrder(invoiceId, body.amount);
  }
}
