import { Module } from '@nestjs/common';
import { RmController } from './rm.controller';
import { RmService } from './rm.service';
import { PipelineModule } from '../pipeline/pipeline.module';
import { StaffModule } from '../staff/staff.module';
import { PayrollModule } from '../payroll/payroll.module';
import { UserProvisioningModule } from '../auth/user-provisioning.module';
import { FinanceCustomerModule } from '../finance/customer/customer.module';

@Module({
  imports: [PipelineModule, StaffModule, PayrollModule, UserProvisioningModule, FinanceCustomerModule],
  controllers: [RmController],
  providers: [RmService],
  exports: [RmService],
})
export class RmModule {}
