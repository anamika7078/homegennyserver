import { Module } from '@nestjs/common';
import { AssessmentsController } from './assessments.controller';
import { AssessmentsService } from './assessments.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

// Previously registered TypeOrmModule.forFeature([Assessment, AssessmentAuditLog])
// against entities whose columns didn't match the live table and a table
// (assessment_audit_logs) that didn't exist at all — see assessments.service.ts.
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AssessmentsController],
  providers: [AssessmentsService],
  exports: [AssessmentsService],
})
export class AssessmentsModule {}
