import { Module } from '@nestjs/common';
import { EnterpriseCronService } from './enterprise-cron.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PayrollModule } from '../payroll/payroll.module';

@Module({
  imports: [PrismaModule, NotificationsModule, PayrollModule],
  providers: [EnterpriseCronService],
})
export class EnterpriseCronModule {}
