import { Module } from '@nestjs/common';
import { PipelineFsmService } from './pipeline-fsm.service';
import { PipelineController } from './pipeline.controller';

@Module({
  providers: [PipelineFsmService],
  controllers: [PipelineController],
  exports: [PipelineFsmService],
})
export class PipelineModule {}
