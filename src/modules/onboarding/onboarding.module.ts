import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { StaffModule } from '../staff/staff.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { OnboardingService } from './onboarding.service';
import { MeOnboardingController, MetaCitiesController, StaffProfileController } from './onboarding.controller';

/** Mobile login → complete your profile — docs/REGISTRATION_ONBOARDING_PLAN.md. */
@Module({
  imports: [PrismaModule, StaffModule, PipelineModule],
  controllers: [MeOnboardingController, MetaCitiesController, StaffProfileController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
