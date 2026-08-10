import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { CompetencyService } from './competency.service';

// Was fully unauthenticated (Pillar 2 — Competency Proven).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.ASSESSOR, UserRole.ADMIN)
@Controller('api/competency')
export class CompetencyController {
  constructor(private readonly competencyService: CompetencyService) {}

  @Post('evaluate')
  async evaluate(@Body() data: any) {
    return this.competencyService.evaluate(data);
  }

  @Get('history/:id')
  async getHistory(@Param('id') candidateId: string) {
    return this.competencyService.getHistory(candidateId);
  }
}
