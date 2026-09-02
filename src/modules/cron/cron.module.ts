import { Module } from '@nestjs/common';
import { EnterpriseCronService } from './enterprise-cron.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PayrollModule } from '../payroll/payroll.module';
import { InvoiceModule } from '../finance/invoice/invoice.module';

@Module({
  // InvoiceModule exports ConsolidatedInvoiceService, which the month-end cron
  // uses to issue one invoice per client rather than one per placement.
  imports: [PrismaModule, NotificationsModule, PayrollModule, InvoiceModule],
  providers: [EnterpriseCronService],
})
export class EnterpriseCronModule {}
