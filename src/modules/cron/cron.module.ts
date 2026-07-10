import { Module } from '@nestjs/common';
import { EnterpriseCronService } from './enterprise-cron.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, NotificationsModule],
  providers: [EnterpriseCronService],
})
export class EnterpriseCronModule {}
