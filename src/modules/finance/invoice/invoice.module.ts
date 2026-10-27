import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinanceInvoiceController } from './invoice.controller';
import { FinanceInvoiceService } from './invoice.service';
import { ConsolidatedInvoiceService } from './consolidated-invoice.service';
import { InvoiceCorrectionService } from './invoice-correction.service';
import { SentInvoiceCorrectionService } from './sent-invoice-correction.service';
import { FinanceOversightService } from './finance-oversight.service';
import { SettlementModule } from '../settlement/settlement.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { PayrollModule } from '../../payroll/payroll.module';

@Module({
  // NotificationsModule so sendInvoice can actually reach the client, rather
  // than only moving the status to SENT.
  // PayrollModule: an invoice for part of a month runs that part's payroll first.
  // SettlementModule: correcting a sent invoice issues a credit note.
  imports: [TypeOrmModule.forFeature([]), NotificationsModule, PayrollModule, SettlementModule],
  controllers: [FinanceInvoiceController],
  providers: [
    FinanceInvoiceService, ConsolidatedInvoiceService, InvoiceCorrectionService, SentInvoiceCorrectionService,
    FinanceOversightService,
  ],
  // FinanceInvoiceService is exported so the client app can download the very
  // same document Finance sees. A second renderer would mean two versions of
  // one invoice.
  exports: [
    ConsolidatedInvoiceService, FinanceInvoiceService, InvoiceCorrectionService, SentInvoiceCorrectionService,
    FinanceOversightService,
  ],
})
export class InvoiceModule {}
