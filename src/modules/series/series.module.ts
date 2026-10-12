import { Module } from '@nestjs/common';
import { SeriesService } from './series.service';
import { SeriesController } from './series.controller';
import { MetaController } from './meta.controller';
import { ScenarioModule } from '../scenario/scenario.module';

@Module({
  imports: [ScenarioModule],
  controllers: [SeriesController, MetaController],
  providers: [SeriesService],
  exports: [SeriesService],
})
export class SeriesModule {}
