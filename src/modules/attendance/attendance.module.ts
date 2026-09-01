import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { AttendanceRepository } from './attendance.repository';
import { StaffAttendanceMirrorService } from './staff-attendance-mirror.service';
import { PipelineAttendanceProjectionService } from './pipeline-attendance-projection.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { PayrollModule } from '../payroll/payroll.module';

@Module({
  imports: [PrismaModule, PayrollModule],
  controllers: [AttendanceController],
  providers: [
    AttendanceService,
    AttendanceRepository,
    StaffAttendanceMirrorService,
    PipelineAttendanceProjectionService,
  ],
  exports: [
    AttendanceService,
    AttendanceRepository,
    StaffAttendanceMirrorService,
    PipelineAttendanceProjectionService,
  ],
})
export class AttendanceModule {}
