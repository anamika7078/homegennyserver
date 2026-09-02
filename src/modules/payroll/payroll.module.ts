import { Module } from '@nestjs/common';
import { PayrollService } from './payroll.service';
import { PayrollController } from './payroll.controller';
import { EnterprisePayrollService } from './enterprise-payroll.service';
import { EnterprisePayrollController } from './enterprise-payroll.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { TaxModule } from '../finance/tax/tax.module';
import { InvoiceModule } from '../finance/invoice/invoice.module';

@Module({
  // TaxModule is @Global, but imported explicitly so this module does not
  // depend on AppModule's import order to resolve StatutoryTaxService.
  // InvoiceModule supplies ConsolidatedInvoiceService: payroll is per staff,
  // but the invoice it feeds belongs to the client.
  imports: [PrismaModule, TaxModule, InvoiceModule],
  providers: [PayrollService, EnterprisePayrollService],
  controllers: [PayrollController, EnterprisePayrollController],
  exports: [PayrollService, EnterprisePayrollService],
})
export class PayrollModule {}
