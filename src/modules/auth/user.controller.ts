import { Controller, Get, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AnyAuthenticatedRole } from './decorators/roles.decorator';
import { AuthService } from './auth.service';

@ApiTags('User Profile')
@Controller({ path: 'user', version: '1' })
export class UserController {
  constructor(private readonly authService: AuthService) {}

  @Get('profile')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @AnyAuthenticatedRole()
  @ApiTags('User Profile', 'Mobile App Auth APIs')
  @ApiOperation({
    summary: 'Get full user profile from DB',
    description:
      'Used by the mobile app right after login. Same record shape as GET /auth/me (which the web portal uses ' +
      'instead), wrapped both under `user` and spread at the top level for convenience.',
  })
  @ApiResponse({ status: 200, description: 'Full user record.' })
  async getProfile(@Request() req: any) {
    const me = await this.authService.getMe(req.user.id);
    return {
      user: me,
      ...me,
    };
  }
}
