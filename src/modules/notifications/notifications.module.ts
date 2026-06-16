import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsService } from './notifications.service';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { NotificationLog } from './notification-log.entity';

@Module({
  imports: [TypeOrmModule.forFeature([NotificationLog])],
  providers: [NotificationsService, NotificationDispatcherService],
  exports: [NotificationsService, NotificationDispatcherService],
})
export class NotificationsModule {}
