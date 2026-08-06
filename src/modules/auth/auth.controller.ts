import { Controller, Post, Body, Request, UseGuards, Get, Req } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RegisterCustomerDto } from './dto/register-customer.dto';
import { RegisterStaffDto } from './dto/register-staff.dto';

/** 5 attempts/min per IP on public, unauthenticated auth endpoints (register/login) */
const AUTH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@ApiTags('Auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private clientMeta(req: { ip?: string; headers?: Record<string, string | string[] | undefined> }) {
    return {
      ip: req.ip,
      userAgent: typeof req.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    };
  }

  @Post('register/customer')
  @UseGuards(ThrottlerGuard)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary:
      'Self-register as a Customer via the mobile app. Creates the login account AND a linked ' +
      'finance_customers record in one step (appears in Finance’s customer list immediately). ' +
      'Returns tokens — the app is logged in right after registering.',
  })
  registerCustomer(
    @Body() dto: RegisterCustomerDto,
    @Req() req: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    return this.authService.registerCustomer(dto, this.clientMeta(req));
  }

  @Post('register/staff')
  @UseGuards(ThrottlerGuard)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary:
      'Self-register as Staff via the mobile app. Creates the login account AND a linked ' +
      'employees record (status PENDING_HR_REVIEW) in one step (appears in HR’s employee list ' +
      'immediately, flagged for HR to complete branch/category/salary). Returns tokens.',
  })
  registerStaff(
    @Body() dto: RegisterStaffDto,
    @Req() req: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    return this.authService.registerStaff(dto, this.clientMeta(req));
  }

  @Post('login')
  @UseGuards(ThrottlerGuard)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({ summary: 'Login with phone or email + password. Returns access_token, refresh_token, user.' })
  async login(
    @Body() body: { phone?: string; email?: string; identifier?: string; password: string; totp?: string; remember_me?: boolean },
    @Req() req: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    const loginTarget = body.phone || body.email || body.identifier || '';
    try {
      const user = await this.authService.validateUser(loginTarget, body.password);
      return this.authService.login(user, { ...this.clientMeta(req), totp: body.totp });
    } catch (e) {
      await this.authService.recordFailedLogin(loginTarget, {
        ...this.clientMeta(req),
        failReason: 'INVALID_CREDENTIALS',
      });
      throw e;
    }
  }

  @Post('forgot-password')
  @ApiOperation({ summary: 'Send password reset OTP to registered phone' })
  forgotPassword(@Body() body: { phone: string }) {
    return this.authService.forgotPassword(body.phone);
  }

  @Post('verify-otp')
  @ApiOperation({ summary: 'Verify password reset OTP' })
  verifyOtp(@Body() body: { phone: string; otp: string }) {
    return this.authService.verifyOtp(body.phone, body.otp);
  }

  @Post('reset-password')
  @ApiOperation({ summary: 'Reset password with verified OTP' })
  resetPassword(@Body() body: { phone: string; otp: string; new_password: string }) {
    return this.authService.resetPassword(body.phone, body.otp, body.new_password);
  }

  @Post('2fa/reset-setup')
  @ApiOperation({ summary: 'Admin: generate a new TOTP secret during login setup (phone + password)' })
  async reset2faSetup(
    @Body() body: { phone: string; password: string },
    @Req() req: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    try {
      return this.authService.resetAdmin2faSetup(body.phone, body.password);
    } catch (e) {
      await this.authService.recordFailedLogin(body.phone, {
        ...this.clientMeta(req),
        failReason: 'INVALID_CREDENTIALS',
      });
      throw e;
    }
  }

  @Post('2fa/setup')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Generate TOTP secret for 2FA enrollment' })
  setup2fa(@Request() req: { user: { id: string } }) {
    return this.authService.setup2fa(req.user.id);
  }

  @Post('2fa/confirm')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Confirm 2FA with authenticator code' })
  confirm2fa(@Request() req: { user: { id: string } }, @Body() body: { code: string }) {
    return this.authService.confirm2fa(req.user.id, body.code);
  }

  @Post('logout-all')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Invalidate refresh tokens on all devices' })
  logoutAll(@Request() req: { user: { id: string } }) {
    return this.authService.logoutAllDevices(req.user.id);
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
