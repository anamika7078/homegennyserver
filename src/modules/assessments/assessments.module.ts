import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssessmentsController } from './assessments.controller';
import { AssessmentsService } from './assessments.service';
import { Assessment } from './entities/assessment.entity';
import { AssessmentAuditLog } from './entities/assessment-audit-log.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Assessment, AssessmentAuditLog])],
  controllers: [AssessmentsController],
  providers: [AssessmentsService],
  exports: [AssessmentsService, TypeOrmModule]
})
export class AssessmentsModule {}
