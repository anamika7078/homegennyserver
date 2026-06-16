import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { RbacService } from './rbac.service';

@ApiTags('RBAC')
@ApiBearerAuth()
@Controller({ path: 'rbac', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @Get('me/permissions')
  async myPermissions(@Req() req: { user: { role: string } }) {
    const permissions = await this.rbac.getPermissionsForRole(req.user.role);
    return { role: req.user.role, permissions };
  }

  @Post('seed')
  @Roles(UserRole.ADMIN)
  async seed() {
    await this.rbac.seedPermissions();
    return { message: 'Permissions seeded' };
  }
}
