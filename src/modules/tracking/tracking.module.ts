import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { TrackingService } from './tracking.service';

/**
 * Check-in/out, location during the shift, and the client's view of the staff
 * in their home. Used by the staff app controller and the client app controller.
 */
@Module({
  imports: [DocumentsModule],
  providers: [TrackingService],
  exports: [TrackingService],
})
export class TrackingModule {}
