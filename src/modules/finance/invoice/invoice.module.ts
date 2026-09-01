import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinanceInvoiceController } from './invoice.controller';
import { FinanceInvoiceService } from './invoice.service';
import { ConsolidatedInvoiceService } from './consolidated-invoice.service';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [FinanceInvoiceController],
  providers: [FinanceInvoiceService, ConsolidatedInvoiceService],
  exports: [ConsolidatedInvoiceService],
})
export class InvoiceModule {}
