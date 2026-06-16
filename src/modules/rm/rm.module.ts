import { Module } from '@nestjs/common';
import { RmController } from './rm.controller';
import { RmService } from './rm.service';
import { PipelineModule } from '../pipeline/pipeline.module';
import { StaffModule } from '../staff/staff.module';

@Module({
  imports: [PipelineModule, StaffModule],
  controllers: [RmController],
  providers: [RmService],
  exports: [RmService],
})
export class RmModule {}
