import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompetencyController } from './competency.controller';
import { CompetencyService } from './competency.service';
import { CompetencyScore } from './entities/competency-score.entity';

@Module({
  imports: [TypeOrmModule.forFeature([CompetencyScore])],
  controllers: [CompetencyController],
  providers: [CompetencyService],
  exports: [CompetencyService, TypeOrmModule]
})
export class CompetencyModule {}
