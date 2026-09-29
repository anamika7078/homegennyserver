import { Module } from '@nestjs/common';
import { TrainingController } from './training.controller';
import { TrainingService } from './training.service';
import { TrainerController } from './trainer.controller';
import { TrainerService } from './trainer.service';
import { TrainingMaterialsController } from './training-materials.controller';
import { TrainingMaterialsService } from './training-materials.service';
import { TrainingQuizController } from './training-quiz.controller';
import { TrainingQuizService } from './training-quiz.service';
import { TrainingStaffController } from './training-staff.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { HealthModule } from '../health/health.module';
import { VideoCertModule } from '../video-cert/video-cert.module';

@Module({
  imports: [PrismaModule, HealthModule, VideoCertModule],
  controllers: [TrainingController, TrainerController, TrainingMaterialsController, TrainingQuizController, TrainingStaffController],
  providers: [TrainingService, TrainerService, TrainingMaterialsService, TrainingQuizService],
  exports: [TrainingService, TrainerService, TrainingMaterialsService, TrainingQuizService],
})
export class TrainingModule {}
