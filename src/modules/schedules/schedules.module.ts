import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';
import { AssessmentSchedule } from './entities/schedule.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AssessmentSchedule])],
  controllers: [SchedulesController],
  providers: [SchedulesService],
  exports: [SchedulesService, TypeOrmModule]
})
export class SchedulesModule {}
