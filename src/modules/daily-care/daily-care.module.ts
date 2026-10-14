import { Module } from '@nestjs/common';
import { RightToRefuseModule } from '../right-to-refuse/right-to-refuse.module';
import { CareAccessService } from './care-access.service';
import { CareFilesService } from './care-files.service';
import { CarePlanService } from './care-plan.service';
import { CookService } from './cook.service';
import { InstructionsService } from './instructions.service';
import { ClientUpdatesService } from './client-updates.service';
import { MenuCatalogService } from './menu-catalog.service';
import { CheckinsService } from './checkins.service';
import {
  CareFilesController,
  ClientCareController,
  DishesController,
  RmCheckinsController,
  PlacementCareController,
  RmCareController,
  StaffCareController,
} from './daily-care.controller';

/** Phases C–E of docs/CLIENT_REQUESTS_AND_DAILY_CARE_PLAN.md. */
@Module({
  imports: [RightToRefuseModule],
  controllers: [PlacementCareController, CareFilesController, ClientCareController, StaffCareController, RmCareController, DishesController, RmCheckinsController],
  providers: [CareAccessService, CareFilesService, CarePlanService, CookService, InstructionsService, ClientUpdatesService, MenuCatalogService, CheckinsService],
  exports: [CareAccessService],
})
export class DailyCareModule {}
