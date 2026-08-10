import { Controller, Get, Post, Put, Body, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { AssessmentsService } from './assessments.service';

// Was fully unauthenticated (Pillar 2 — Competency Proven touches this). Gated
// to the roles that record/oversee assessments per spec.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.ASSESSOR, UserRole.ADMIN)
@Controller({ path: 'assessments', version: '1' })
export class AssessmentsController {
  constructor(private readonly assessmentsService: AssessmentsService) {}

  @Get()
  async findAll() {
    return this.assessmentsService.findAll();
  }

  @Post('create')
  async create(@Body() data: any) {
    return this.assessmentsService.create(data);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.assessmentsService.findOne(id);
  }

  @Put('update/:id')
  async update(@Param('id') id: string, @Body() data: any) {
    return this.assessmentsService.update(id, data);
  }

  @Post('submit')
  async submit(@Body() data: any) {
    return this.assessmentsService.submit(data);
  }
}
