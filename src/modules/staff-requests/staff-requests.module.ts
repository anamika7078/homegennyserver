import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { DailyCareModule } from '../daily-care/daily-care.module';
import { StaffRequestsService } from './staff-requests.service';
import { ClientStaffRequestsController, RmStaffRequestsController } from './staff-requests.controller';

@Module({
  imports: [PrismaModule, AuditModule, DailyCareModule],
  controllers: [ClientStaffRequestsController, RmStaffRequestsController],
  providers: [StaffRequestsService],
  exports: [StaffRequestsService],
})
export class StaffRequestsModule {}
