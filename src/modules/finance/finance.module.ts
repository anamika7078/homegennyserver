import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { FinancePayrollModule } from './payroll/payroll.module';
import { InvoiceModule } from './invoice/invoice.module';
import { SettlementModule } from './settlement/settlement.module';
import { EsicModule } from './esic/esic.module';
import { PfModule } from './pf/pf.module';
import { DepositModule } from './deposit/deposit.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { FinanceCustomerModule } from './customer/customer.module';

@Module({
  controllers: [FinanceController],
  providers: [FinanceService],
  imports: [
    FinancePayrollModule,
    InvoiceModule,
    SettlementModule,
    EsicModule,
    PfModule,
    DepositModule,
    AnalyticsModule,
    FinanceCustomerModule,
  ],
})
export class FinanceModule {}
