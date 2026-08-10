import { Controller, Get, Post, Patch, Param, Body, UseGuards, Request, Version } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { PipelineFsmService, StageTransitionInput } from './pipeline-fsm.service';

// Spec: Pipeline FSM — RM=Y, BM=read-only (no read endpoint exists on this
// controller today, so BM has nothing to gain access to here), Admin=Y,
// Staff/Client/Finance=no access. Confirmed live in the audit: a STAFF token
// drove S1_INTAKE -> S5_DEPLOY unopposed before this fix.
@ApiTags('Pipeline')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.ADMIN)
@Controller({ path: 'pipeline', version: '1' })
export class PipelineController {
  constructor(private readonly fsmService: PipelineFsmService) {}

  @Post(':staffId/advance')
  @ApiOperation({ summary: 'Advance pipeline stage (FSM-validated + business/deployment gates)' })
  async advanceStage(@Param('staffId') staffId: string, @Body() body: StageTransitionInput, @Request() req: any) {
    const { scenarioCode } = await this.fsmService.advanceStage({ ...body, staffId, actorId: req.user.id });
    return {
      success: true,
      message: `Stage advanced to ${body.toStage}`,
      ...(scenarioCode ? { scenario_code: scenarioCode } : {}),
    };
  }

  @Post(':staffId/route')
  @ApiOperation({ summary: 'Evaluate scenario flags and return scenario code' })
  async routeScenario(@Param('staffId') staffId: string, @Body() body: { series: any; flags: Record<string, any> }) {
    const code = this.fsmService.routeScenario(body.series, body.flags);
    return { scenario_code: code };
  }
}
