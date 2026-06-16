import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ScenarioService } from './scenario.service';
import { EvaluateScenarioDto } from './dto/evaluate-scenario.dto';

@ApiTags('Scenario Engine')
@ApiBearerAuth()
@Controller({ path: 'scenarios', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class ScenarioController {
  constructor(private readonly scenarios: ScenarioService) {}

  @Post('evaluate')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.ASSESSOR)
  evaluate(
    @Body() dto: EvaluateScenarioDto,
    @Req() req: { user: { id: string } },
  ) {
    return this.scenarios.evaluate(
      dto.series,
      dto.flags ?? {},
      dto.staffId,
      req.user.id,
    );
  }

  @Get('staff/:staffId/history')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
  history(@Param('staffId') staffId: string) {
    return this.scenarios.getStaffScenarioHistory(staffId);
  }
}
