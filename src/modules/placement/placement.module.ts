import { Module } from '@nestjs/common';
import { PlacementService } from './placement.service';
import { PlacementController } from './placement.controller';
import { StaffRequestsModule } from '../staff-requests/staff-requests.module';

@Module({
  imports: [StaffRequestsModule],
  providers: [PlacementService],
  controllers: [PlacementController],
  exports: [PlacementService],
})
export class PlacementModule {}
