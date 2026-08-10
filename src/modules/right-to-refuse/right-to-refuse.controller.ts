import { Controller, Get, Post, Param, Body, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { RightToRefuseService } from './right-to-refuse.service';

interface AuthedRequest { user: { id: string; role: string } }

// Spec: Right to Refuse (Pillar 8) — RM logs invocation, BM handles disputes,
// Admin has audit visibility. No documented Staff/Client/Finance access.
@ApiTags('Right to Refuse')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller({ path: 'right-to-refuse', version: '1' })
export class RightToRefuseController {
  constructor(private readonly service: RightToRefuseService) {}

  @Post()
  @Roles(UserRole.RM, UserRole.ADMIN)
  @ApiOperation({ summary: 'RM logs a Right-to-Refuse invocation' })
  invoke(@Body() body: { staff_id: string; placement_id?: string; reason: string }, @Request() req: AuthedRequest) {
    return this.service.invoke({ staffId: body.staff_id, placementId: body.placement_id, reason: body.reason }, req.user.id);
  }

  @Get()
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'List right-to-refuse cases (latest status each)' })
  list() {
    return this.service.listOpenCases();
  }

  @Get(':refusalId')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'Full event history for one right-to-refuse case' })
  history(@Param('refusalId') refusalId: string) {
    return this.service.history(refusalId);
  }

  @Post(':refusalId/review')
  @Roles(UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'BM marks the case under review (disputed)' })
  review(@Param('refusalId') refusalId: string, @Request() req: AuthedRequest) {
    return this.service.markReviewing(refusalId, req.user.id);
  }

  @Post(':refusalId/decide')
  @Roles(UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'BM records the final decision — UPHELD or OVERTURNED' })
  decide(@Param('refusalId') refusalId: string, @Body() body: { outcome: 'UPHELD' | 'OVERTURNED'; notes?: string }, @Request() req: AuthedRequest) {
    return this.service.decide(refusalId, body.outcome, req.user.id, body.notes);
  }
}
