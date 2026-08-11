import { Module } from '@nestjs/common';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';
import { StaffMobileController } from './staff-mobile.controller';

@Module({
  providers: [StaffService],
  controllers: [StaffController, StaffMobileController],
  exports: [StaffService],
})
export class StaffModule {}
