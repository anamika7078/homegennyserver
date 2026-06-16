import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinanceSettlementController } from './settlement.controller';
import { FinanceSettlementService } from './settlement.service';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [FinanceSettlementController],
  providers: [FinanceSettlementService],
})
export class SettlementModule {}
