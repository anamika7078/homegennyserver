import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssessorsController } from './assessors.controller';
import { AssessorsService } from './assessors.service';
import { Assessor } from './entities/assessor.entity';
import { Assessment } from '../assessments/entities/assessment.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Assessor, Assessment])],
  controllers: [AssessorsController],
  providers: [AssessorsService],
  exports: [AssessorsService, TypeOrmModule],
})
export class AssessorsModule {}
