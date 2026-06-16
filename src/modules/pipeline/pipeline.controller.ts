import { Controller, Get, Post, Patch, Param, Body, UseGuards, Request, Version } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PipelineFsmService, StageTransitionInput } from './pipeline-fsm.service';

@ApiTags('Pipeline')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'pipeline', version: '1' })
export class PipelineController {
  constructor(private readonly fsmService: PipelineFsmService) {}

  @Post(':staffId/advance')
  @ApiOperation({ summary: 'Advance pipeline stage (FSM-validated)' })
  async advanceStage(@Param('staffId') staffId: string, @Body() body: StageTransitionInput, @Request() req: any) {
    await this.fsmService.advanceStage({ ...body, staffId, actorId: req.user.id });
    return { success: true, message: `Stage advanced to ${body.toStage}` };
  }

  @Post(':staffId/route')
  @ApiOperation({ summary: 'Evaluate scenario flags and return scenario code' })
  async routeScenario(@Param('staffId') staffId: string, @Body() body: { series: any; flags: Record<string, any> }) {
    const code = this.fsmService.routeScenario(body.series, body.flags);
    return { scenario_code: code };
  }
}
