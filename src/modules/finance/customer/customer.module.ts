import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinanceCustomerController } from './customer.controller';
import { FinanceCustomerService } from './customer.service';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [FinanceCustomerController],
  providers: [FinanceCustomerService],
  exports: [FinanceCustomerService],
})
export class FinanceCustomerModule {}
