import { Module } from '@nestjs/common';
import { PlacementService } from './placement.service';
import { PlacementController } from './placement.controller';
import { StaffRequestsModule } from '../staff-requests/staff-requests.module';
import { InvoiceModule } from '../finance/invoice/invoice.module';

@Module({
  // InvoiceModule: a rate change that reaches back over payroll already run
  // voids and re-runs it (InvoiceCorrectionService).
  imports: [StaffRequestsModule, InvoiceModule],
  providers: [PlacementService],
  controllers: [PlacementController],
  exports: [PlacementService],
})
export class PlacementModule {}
