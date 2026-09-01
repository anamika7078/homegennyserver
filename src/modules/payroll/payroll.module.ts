import { Module } from '@nestjs/common';
import { PayrollService } from './payroll.service';
import { PayrollController } from './payroll.controller';
import { EnterprisePayrollService } from './enterprise-payroll.service';
import { EnterprisePayrollController } from './enterprise-payroll.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { TaxModule } from '../finance/tax/tax.module';

@Module({
  // TaxModule is @Global, but imported explicitly so this module does not
  // depend on AppModule's import order to resolve StatutoryTaxService.
  imports: [PrismaModule, TaxModule],
  providers: [PayrollService, EnterprisePayrollService],
  controllers: [PayrollController, EnterprisePayrollController],
  exports: [PayrollService, EnterprisePayrollService],
})
export class PayrollModule {}
