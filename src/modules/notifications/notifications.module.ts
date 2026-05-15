import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsService } from './notifications.service';
import { NotificationLog } from './notification-log.entity';

@Module({
  imports: [TypeOrmModule.forFeature([NotificationLog])],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule { }