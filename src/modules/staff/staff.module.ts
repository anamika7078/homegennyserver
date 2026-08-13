import { Module } from '@nestjs/common';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';
import { StaffMobileController } from './staff-mobile.controller';

@Module({
  providers: [StaffService],
  // StaffMobileController MUST come first: both controllers mount at path
  // 'staff', and StaffController's generic `@Get(':id')` would otherwise
  // shadow StaffMobileController's literal routes (`/staff/dashboard`,
  // `/staff/pipeline-status`, etc — Express matches route order, not
  // specificity), locking STAFF-role users out with a 403 from the wrong
  // controller's stricter @Roles(RM, BM, ADMIN).
  controllers: [StaffMobileController, StaffController],
  exports: [StaffService],
})
export class StaffModule {}
