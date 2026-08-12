import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinanceCustomerController } from './customer.controller';
import { FinanceCustomerService } from './customer.service';
import { UserProvisioningModule } from '../../auth/user-provisioning.module';

@Module({
  imports: [TypeOrmModule.forFeature([]), UserProvisioningModule],
  controllers: [FinanceCustomerController],
  providers: [FinanceCustomerService],
  exports: [FinanceCustomerService],
})
export class FinanceCustomerModule {}
