import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinanceSettlementController } from './settlement.controller';
import { FinanceSettlementService } from './settlement.service';
import { ExitSettlementService } from './exit-settlement.service';
import { ExitSettlementController } from './exit-settlement.controller';
import { CreditNoteService } from './credit-note.service';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [FinanceSettlementController, ExitSettlementController],
  providers: [FinanceSettlementService, ExitSettlementService, CreditNoteService],
  exports: [ExitSettlementService, CreditNoteService],
})
export class SettlementModule {}
