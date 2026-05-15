import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { MonitoringService } from './monitoring.service';
import { MonitoringController } from './monitoring.controller';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'notifications' }),
  ],
  controllers: [MonitoringController],
  providers: [MonitoringService],
  exports:   [MonitoringService],
})
export class MonitoringModule {}
