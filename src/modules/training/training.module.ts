import { Module } from '@nestjs/common';
import { TrainingController } from './training.controller';
import { TrainingService } from './training.service';
import { TrainerController } from './trainer.controller';
import { TrainerService } from './trainer.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { HealthModule } from '../health/health.module';
import { VideoCertModule } from '../video-cert/video-cert.module';

@Module({
  imports: [PrismaModule, HealthModule, VideoCertModule],
  controllers: [TrainingController, TrainerController],
  providers: [TrainingService, TrainerService],
  exports: [TrainingService, TrainerService],
})
export class TrainingModule {}
