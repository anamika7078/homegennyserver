import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AttendanceApprovalService } from './attendance-approval.service';
import { ClientAttendanceApprovalController, RmAttendanceApprovalController } from './attendance-approval.controller';

/** The client confirming staff-app attendance; the RM resolving disputes. */
@Module({
  imports: [PrismaModule],
  controllers: [ClientAttendanceApprovalController, RmAttendanceApprovalController],
  providers: [AttendanceApprovalService],
  exports: [AttendanceApprovalService],
})
export class AttendanceApprovalModule {}
