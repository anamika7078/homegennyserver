import { Controller, Get, Post, Body, UseGuards, Req, Put, Param } from '@nestjs/common';
import { TrainerService } from './trainer.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';

@Controller({ path: 'trainer', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.TRAINER, UserRole.ADMIN) // Admin can also access trainer APIs
export class TrainerController {
  constructor(private readonly trainerService: TrainerService) {}

  @Get('dashboard')
  async getDashboard(@Req() req: any) {
    return this.trainerService.getDashboardStats(req.user);
  }

  @Get('batches')
  async getBatches(@Req() req: any) {
    return this.trainerService.getAssignedBatches(req.user);
  }

  @Put('assessment/:traineeId')
  async updateAssessment(
    @Req() req: any,
    @Param('traineeId') traineeId: string,
    @Body() data: any
  ) {
    return this.trainerService.updateAssessment(req.user.id, traineeId, data);
  }
}
