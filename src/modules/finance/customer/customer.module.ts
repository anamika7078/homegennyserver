import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { FinanceCustomerController } from './customer.controller';
import { FinanceCustomerService } from './customer.service';
import { UserProvisioningModule } from '../../auth/user-provisioning.module';

@Module({
  imports: [TypeOrmModule.forFeature([]), UserProvisioningModule, HttpModule],
  controllers: [FinanceCustomerController],
  providers: [FinanceCustomerService],
  exports: [FinanceCustomerService],
})
export class FinanceCustomerModule {}
