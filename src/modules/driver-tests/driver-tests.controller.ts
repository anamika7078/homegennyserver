import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { DriverTestsService } from './driver-tests.service';

// Was fully unauthenticated (DR-series practical test — Pillar 2, max 3 attempts).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.ASSESSOR, UserRole.ADMIN)
@Controller('api/driver-tests')
export class DriverTestsController {
  constructor(private readonly driverTestsService: DriverTestsService) {}

  @Post('start')
  async start(@Body() data: any) {
    return this.driverTestsService.start(data);
  }

  @Post('score')
  async score(@Body() data: any) {
    return this.driverTestsService.score(data);
  }

  @Post('complete')
  async complete(@Body() data: any) {
    return this.driverTestsService.complete(data);
  }
}
