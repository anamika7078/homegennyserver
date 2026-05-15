import { Controller, Post, Body, Request, UseGuards, Get } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@ApiTags('Auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @ApiOperation({ summary: 'Login with phone + password. Returns access_token, refresh_token, user.' })
  async login(@Body() body: { phone: string; password: string }) {
    const user = await this.authService.validateUser(body.phone, body.password);
    return this.authService.login(user);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token using userId + refresh_token' })
  async refresh(@Body() body: { userId: string; refresh_token: string }) {
    return this.authService.refreshTokens(body.userId, body.refresh_token);
  }

  @Post('logout')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async logout(@Request() req: any) {
    await this.authService.logout(req.user.id);
    return { success: true };
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get full user record from DB (includes full_name, email, branch_id)' })
  async getMe(@Request() req: any) {
    // FIX 2: call service.getMe(id) to get full record from DB
    // NOT req.user — that only has the JWT payload (no full_name)
    return this.authService.getMe(req.user.id);
  }
}
