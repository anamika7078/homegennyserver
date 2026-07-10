import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsService } from './notifications.service';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { NotificationLog } from './notification-log.entity';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [TypeOrmModule.forFeature([NotificationLog]), PrismaModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationDispatcherService],
  exports: [NotificationsService, NotificationDispatcherService],
})
export class NotificationsModule {}
