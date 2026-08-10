import { Controller, Post, Get, Put, Body, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { SchedulesService } from './schedules.service';

// Was fully unauthenticated. Training/scenario scheduling — same role set as
// the existing `training` module (RM, BM, Admin, Trainer).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.TRAINER)
@Controller('api/schedules')
export class SchedulesController {
  constructor(private readonly schedulesService: SchedulesService) {}

  @Post('create')
  async create(@Body() data: any) {
    return this.schedulesService.create(data);
  }

  @Get('upcoming')
  async getUpcoming() {
    return this.schedulesService.getUpcoming();
  }

  @Put('reschedule/:id')
  async reschedule(@Param('id') id: string, @Body() data: any) {
    return this.schedulesService.reschedule(id, data);
  }
}
