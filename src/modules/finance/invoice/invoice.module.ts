import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinanceInvoiceController } from './invoice.controller';
import { FinanceInvoiceService } from './invoice.service';
import { ConsolidatedInvoiceService } from './consolidated-invoice.service';
import { NotificationsModule } from '../../notifications/notifications.module';

@Module({
  // NotificationsModule so sendInvoice can actually reach the client, rather
  // than only moving the status to SENT.
  imports: [TypeOrmModule.forFeature([]), NotificationsModule],
  controllers: [FinanceInvoiceController],
  providers: [FinanceInvoiceService, ConsolidatedInvoiceService],
  exports: [ConsolidatedInvoiceService],
})
export class InvoiceModule {}
