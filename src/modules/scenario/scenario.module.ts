import { Module } from '@nestjs/common';
import { ScenarioEngine } from './scenario.engine';
import { ScenarioService } from './scenario.service';
import { ScenarioController } from './scenario.controller';

@Module({
  controllers: [ScenarioController],
  providers: [ScenarioEngine, ScenarioService],
  exports: [ScenarioEngine, ScenarioService],
})
export class ScenarioModule {}
