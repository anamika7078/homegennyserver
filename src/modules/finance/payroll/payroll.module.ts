import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinancePayrollController } from './payroll.controller';
import { FinancePayrollService } from './payroll.service';
import { PayrollModule as CorePayrollModule } from '../../payroll/payroll.module';

@Module({
  imports: [TypeOrmModule.forFeature([]), CorePayrollModule],
  controllers: [FinancePayrollController],
  providers: [FinancePayrollService],
})
export class FinancePayrollModule {}
