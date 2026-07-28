import { Module } from '@nestjs/common';
import { PayrollService } from './payroll.service';
import { PayrollController } from './payroll.controller';
import { EnterprisePayrollService } from './enterprise-payroll.service';
import { EnterprisePayrollController } from './enterprise-payroll.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [PayrollService, EnterprisePayrollService],
  controllers: [PayrollController, EnterprisePayrollController],
  exports: [PayrollService, EnterprisePayrollService],
})
export class PayrollModule {}
