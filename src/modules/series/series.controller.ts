import { Body, Controller, Param, Post, UseGuards, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { SeriesService } from './series.service';

@ApiTags('Staff Series (SC/UC/DR)')
@ApiBearerAuth()
@Controller({ path: 'series', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class SeriesController {
  constructor(private readonly series: SeriesService) {}

  @Post('sc/:staffId/care-types')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
  assignScCare(
    @Param('staffId') staffId: string,
    @Body() body: { care_types: string[] },
    @Req() req: { user: { id: string } },
  ) {
    return this.series.assignScCareTypes(staffId, body.care_types, req.user.id);
  }

  @Post('uc/:staffId/role-types')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
  assignUcRoles(
    @Param('staffId') staffId: string,
    @Body() body: { role_types: string[] },
    @Req() req: { user: { id: string } },
  ) {
    return this.series.assignUcRoleTypes(staffId, body.role_types, req.user.id);
  }

  @Post('uc/:staffId/upgrade-to-sc')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
  upgradeUcToSc(
    @Param('staffId') staffId: string,
    @Body() body: { notes?: string },
    @Req() req: { user: { id: string } },
  ) {
    return this.series.requestUcToScUpgrade(staffId, req.user.id, body.notes);
  }

  @Post('dr/:staffId/verify-apis')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
  driverApis(
    @Param('staffId') staffId: string,
    @Body() body: { dl_number: string },
    @Req() req: { user: { id: string } },
  ) {
    return this.series.runDriverApiChecks(staffId, body.dl_number, req.user.id);
  }

  @Post('scope-check')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.ASSESSOR)
  async scopeCheck(@Body() body: { series: string; duty_code: string }) {
    const { mapSeriesFromShort } = await import('../../common/mappers/staff.mapper');
    this.series.assertNoMedicalDuty(mapSeriesFromShort(body.series), body.duty_code);
    return { allowed: true };
  }
}
