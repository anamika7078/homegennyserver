import { Module } from '@nestjs/common';
import { DriverTestsController } from './driver-tests.controller';
import { DriverTestsService } from './driver-tests.service';

@Module({
  controllers: [DriverTestsController],
  providers: [DriverTestsService]
})
export class DriverTestsModule {}
