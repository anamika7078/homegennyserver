import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { RmService } from './rm.service';
import { AuthUser } from '../../common/guards/branch-scope.util';

@ApiTags('RM Operations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
@Controller({ path: 'rm', version: '1' })
export class RmController {
  constructor(private readonly rm: RmService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'RM dashboard KPIs, funnel, and series distribution' })
  dashboard(@Req() req: { user: AuthUser }) {
    return this.rm.getDashboard(req.user);
  }

  @Get('kanban')
  @ApiOperation({ summary: 'Pipeline kanban columns (branch/RM scoped)' })
  kanban(
    @Req() req: { user: AuthUser },
    @Query('search') search?: string,
    @Query('series') series?: string,
    @Query('limit') limit?: string,
  ) {
    return this.rm.getKanban(req.user, {
      search,
      series,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Post('pipeline/:staffId/advance')
  @ApiOperation({ summary: 'FSM-validated stage transition (immutable event log)' })
  advance(
    @Req() req: { user: AuthUser },
    @Param('staffId') staffId: string,
    @Body() body: { to_stage: string; reason_code?: string; payload?: Record<string, unknown> },
  ) {
    return this.rm.advanceStage(
      req.user,
      staffId,
      body.to_stage,
      body.reason_code,
      body.payload,
    );
  }

  @Get('trials')
  @ApiOperation({ summary: 'Active trial placements for RM' })
  trials(@Req() req: { user: AuthUser }) {
    return this.rm.listTrials(req.user);
  }

  @Get('deferred')
  @ApiOperation({ summary: 'Deferred cases with aging' })
  deferred(@Req() req: { user: AuthUser }) {
    return this.rm.listDeferred(req.user);
  }

  @Post('deferred/:staffId/resume')
  @ApiOperation({ summary: 'Resume deferred staff to target stage' })
  resumeDeferred(
    @Req() req: { user: AuthUser },
    @Param('staffId') staffId: string,
    @Body() body: { to_stage: string },
  ) {
    return this.rm.resumeDeferred(req.user, staffId, body.to_stage);
  }

  @Get('terminal')
  @ApiOperation({ summary: 'Terminal outcome staff list' })
  terminal(@Req() req: { user: AuthUser }) {
    return this.rm.listTerminal(req.user);
  }

  @Get('incidents')
  @ApiOperation({ summary: 'Incident inbox' })
  incidents(@Req() req: { user: AuthUser }, @Query('status') status?: string) {
    return this.rm.listIncidents(req.user, status);
  }

  @Post('incidents')
  @ApiOperation({ summary: 'Raise new incident' })
  createIncident(@Req() req: { user: AuthUser }, @Body() body: Record<string, unknown>) {
    return this.rm.createIncident(req.user, body);
  }

  @Get('shifts')
  @ApiOperation({ summary: 'Shift logs pending approval' })
  shifts(@Req() req: { user: AuthUser }, @Query('status') status?: string) {
    return this.rm.listShiftLogs(req.user, status);
  }

  @Patch('shifts/:id/review')
  @ApiOperation({ summary: 'Approve / reject / flag shift log' })
  reviewShift(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { action: 'APPROVED' | 'REJECTED' | 'FLAGGED'; notes?: string },
  ) {
    return this.rm.reviewShift(req.user, id, body.action, body.notes);
  }

  @Get('upgrades')
  @ApiOperation({ summary: 'Upgrade path tracker (Maid→UC, UC→SC)' })
  upgrades(@Req() req: { user: AuthUser }) {
    return this.rm.listUpgrades(req.user);
  }

  @Post('intake')
  @ApiOperation({
    summary: 'S1 intake with restricted-list check, deposit, and optional S2 advance',
  })
  intake(@Req() req: { user: AuthUser }, @Body() body: Record<string, unknown>) {
    return this.rm.processIntake(req.user, body);
  }
}
