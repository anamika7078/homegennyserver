import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinancePayrollController } from './payroll.controller';
import { FinancePayrollService } from './payroll.service';
import { PayoutService } from './payout.service';
import { PayrollModule as CorePayrollModule } from '../../payroll/payroll.module';

@Module({
  imports: [TypeOrmModule.forFeature([]), CorePayrollModule],
  controllers: [FinancePayrollController],
  providers: [FinancePayrollService, PayoutService],
  exports: [PayoutService],
})
export class FinancePayrollModule {}
