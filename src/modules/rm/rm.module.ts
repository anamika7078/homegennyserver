import { Module } from '@nestjs/common';
import { RmController } from './rm.controller';
import { RmService } from './rm.service';
import { PipelineModule } from '../pipeline/pipeline.module';
import { StaffModule } from '../staff/staff.module';
import { PayrollModule } from '../payroll/payroll.module';

@Module({
  imports: [PipelineModule, StaffModule, PayrollModule],
  controllers: [RmController],
  providers: [RmService],
  exports: [RmService],
})
export class RmModule {}
