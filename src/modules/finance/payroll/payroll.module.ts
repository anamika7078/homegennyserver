import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinancePayrollController } from './payroll.controller';
import { FinancePayrollService } from './payroll.service';
import { PayoutService } from './payout.service';
import { PayrollModule as CorePayrollModule } from '../../payroll/payroll.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { InvoiceModule } from '../invoice/invoice.module';

@Module({
  imports: [TypeOrmModule.forFeature([]), CorePayrollModule, NotificationsModule, InvoiceModule],
  controllers: [FinancePayrollController],
  providers: [FinancePayrollService, PayoutService],
  exports: [PayoutService],
})
export class FinancePayrollModule {}
