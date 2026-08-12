import { Controller, Post, Body, Request, UseGuards, Get, Req, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody, ApiResponse } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RegisterCustomerDto } from './dto/register-customer.dto';
import { RegisterStaffDto } from './dto/register-staff.dto';
import { Public } from './decorators/public.decorator';
import { AnyAuthenticatedRole } from './decorators/roles.decorator';

/** 5 attempts/min per IP on public, unauthenticated auth endpoints (register/login) */
const AUTH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

const LOGIN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    access_token: { type: 'string' },
    refresh_token: { type: 'string' },
    must_change_password: {
      type: 'boolean',
      description:
        'true when the account was provisioned with the default password (Finance/HR/Admin onboarding) ' +
        'and has not been changed yet. The app should route to a change-password flow instead of the dashboard.',
    },
    user: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        full_name: { type: 'string' },
        role: { type: 'string', enum: ['STAFF', 'CLIENT', 'RM', 'BM', 'FINANCE', 'ADMIN', 'TRAINER', 'ASSESSOR', 'SUPPORT', 'HR'] },
        phone: { type: 'string' },
        is_active: { type: 'boolean' },
        branch_id: { type: 'string', nullable: true },
      },
    },
  },
};

const TOTP_SETUP_RESPONSE_SCHEMA = {
  type: 'object',
  description: 'Returned instead of tokens when an ADMIN account needs to (re-)enroll its authenticator app.',
  properties: {
    requires_totp_setup: { type: 'boolean', enum: [true] },
    user_id: { type: 'string' },
    totp_secret: { type: 'string', description: 'Base32 secret — show as a manual entry key' },
    otpauth_url: { type: 'string', description: 'otpauth:// URL — render as a QR code' },
  },
};

const REQUIRES_2FA_RESPONSE_SCHEMA = {
  type: 'object',
  description: 'Returned instead of tokens when a TOTP code is required to complete login.',
  properties: {
    requires_2fa: { type: 'boolean', enum: [true] },
    user_id: { type: 'string' },
  },
};

// Web (Next.js admin/RM/BM/Finance/HR portal) and the Flutter mobile app share
// this same backend auth API. Each endpoint is tagged for whichever client(s)
// actually call it today (verified against both frontends' source), so each
// team's Swagger view only shows what's relevant to them — endpoints used by
// both get both tags and appear under both headings.
const TAG_SHARED = ['Auth', 'Mobile App Auth APIs'];
const TAG_WEB_ONLY = ['Auth'];
const TAG_MOBILE_ONLY = ['Mobile App Auth APIs'];

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private clientMeta(req: { ip?: string; headers?: Record<string, string | string[] | undefined> }) {
    return {
      ip: req.ip,
      userAgent: typeof req.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    };
  }

  // ── SPEC CONFLICT (flagged, not resolved here — Phase 1 is auth/authz only) ──
  // HomeGenny Platform v1.0 — User Roles & Permissions Reference states Staff do
  // NOT self-register (RM-created) and Clients are RM-created at placement setup.
  // These two endpoints contradict that. Left public and unchanged per instruction
  // not to silently remove them; needs a product decision before Phase 2+.
  @Post('register/customer')
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle(AUTH_THROTTLE)
  @ApiTags(...TAG_MOBILE_ONLY)
  @ApiOperation({
    summary: 'Self-register as a Customer (CLIENT)',
    description:
      'Creates the login account AND a linked finance_customers record in one step (appears in Finance’s ' +
      'customer list immediately). Returns tokens — the app is logged in right after registering. ' +
      'Rate-limited to 5 requests/min per IP.',
  })
  @ApiResponse({ status: 201, description: 'Registered and logged in.', schema: LOGIN_RESPONSE_SCHEMA })
  @ApiResponse({ status: 409, description: 'Phone or email already registered.' })
  registerCustomer(
    @Body() dto: RegisterCustomerDto,
    @Req() req: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    return this.authService.registerCustomer(dto, this.clientMeta(req));
  }

  @Post('register/staff')
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle(AUTH_THROTTLE)
  @ApiTags(...TAG_MOBILE_ONLY)
  @ApiOperation({
    summary: 'Staff self-registration — ALWAYS BLOCKED (400)',
    description:
      'Staff Applicants do NOT self-register via the mobile app per HomeGenny Platform v1.0 spec. Accounts are ' +
      'onboarded exclusively by Admin, HR, or RM (see POST /employees or POST /admin/users/create). This route ' +
      'exists only to return a clear 400 explaining that — do not build a staff sign-up screen against it.',
  })
  @ApiResponse({ status: 400, description: 'Always returned — staff self-registration is disabled by design.' })
  registerStaff(
    @Body() dto: RegisterStaffDto,
    @Req() req: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    throw new BadRequestException(
      'Staff Applicants do NOT self-register via the mobile app per HomeGenny Platform v1.0 specifications. ' +
      'Staff accounts are onboarded by an Admin, HR, or Relationship Manager (RM) who assigns their staff code. Please log in using your assigned credentials.',
    );
  }

  @Post('login')
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle(AUTH_THROTTLE)
  @ApiTags(...TAG_SHARED)
  @ApiOperation({
    summary: 'Login with phone/email + password',
    description:
      'Returns access_token, refresh_token, and user on success. ' +
      'ADMIN accounts additionally require TOTP: if no `totp` is supplied and 2FA isn’t set up yet, this returns ' +
      'a TOTP-setup payload (show a QR code) instead of tokens; if set up but no code was sent, it returns ' +
      '`{ requires_2fa: true, user_id }` — resubmit the same request with `totp` filled in. Non-admin roles only ' +
      'need `totp` if they have 2FA enabled. Rate-limited to 5 requests/min per IP.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['password'],
      properties: {
        phone: { type: 'string', example: '9811100001', description: 'Provide phone OR email OR identifier' },
        email: { type: 'string', example: 'user@example.com' },
        identifier: { type: 'string', description: 'Generic phone-or-email field, checked if phone/email are omitted' },
        password: { type: 'string', example: 'HomeGenny@2024' },
        totp: { type: 'string', example: '123456', description: '6-digit authenticator code, only when 2FA is active' },
        remember_me: { type: 'boolean' },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'One of three shapes: normal login success, ADMIN 2FA-setup-required, or 2FA-code-required — see each sub-schema.',
    schema: { oneOf: [LOGIN_RESPONSE_SCHEMA, TOTP_SETUP_RESPONSE_SCHEMA, REQUIRES_2FA_RESPONSE_SCHEMA] },
  })
  @ApiResponse({ status: 401, description: 'Invalid credentials, invalid 2FA code, or inactive account.' })
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
  @Public()
  @ApiTags(...TAG_SHARED)
  @ApiOperation({
    summary: 'Send password-reset OTP',
    description:
      'Sends a 6-digit OTP to the phone (10 min TTL) for the forgot-password flow. This is unrelated to login — ' +
      'it does not issue tokens. Always returns `{ sent: true }` even for an unknown phone (no user enumeration). ' +
      '⚠️ TEMPORARY: hardcoded to `123456` (same as /auth/change-password) until a real OTP/SMS provider is wired in.',
  })
  @ApiBody({ schema: { type: 'object', required: ['phone'], properties: { phone: { type: 'string', example: '9811100001' } } } })
  @ApiResponse({
    status: 200,
    schema: { type: 'object', properties: { sent: { type: 'boolean' }, expires_at: { type: 'string', format: 'date-time' } } },
  })
  forgotPassword(@Body() body: { phone: string }) {
    return this.authService.forgotPassword(body.phone);
  }

  @Post('verify-otp')
  @Public()
  @ApiTags(...TAG_SHARED)
  @ApiOperation({
    summary: 'Verify password-reset OTP',
    description:
      'Verifies the OTP from POST /auth/forgot-password (⚠️ TEMPORARY: hardcoded to `123456` until a real OTP/SMS ' +
      'provider is wired in). Returns only `{ valid: boolean }` — no tokens are issued here. This is NOT a ' +
      'login/OTP-login endpoint; do not use it to authenticate a session. Follow a valid result with POST /auth/reset-password.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['phone', 'otp'],
      properties: { phone: { type: 'string', example: '9811100001' }, otp: { type: 'string', example: '123456' } },
    },
  })
  @ApiResponse({ status: 200, schema: { type: 'object', properties: { valid: { type: 'boolean' } } } })
  verifyOtp(@Body() body: { phone: string; otp: string }) {
    return this.authService.verifyOtp(body.phone, body.otp);
  }

  @Post('reset-password')
  @Public()
  @ApiTags(...TAG_WEB_ONLY)
  @ApiOperation({
    summary: 'Reset password with a verified OTP (forgot-password flow)',
    description:
      'Requires the OTP from POST /auth/forgot-password (⚠️ TEMPORARY: hardcoded to `123456` until a real OTP/SMS ' +
      'provider is wired in).',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['phone', 'otp', 'new_password'],
      properties: {
        phone: { type: 'string', example: '9811100001' },
        otp: { type: 'string', example: '123456' },
        new_password: { type: 'string', example: 'NewStr0ng@Pass' },
      },
    },
  })
  @ApiResponse({ status: 200, schema: { type: 'object', properties: { success: { type: 'boolean' } } } })
  @ApiResponse({ status: 400, description: 'Invalid or expired OTP.' })
  resetPassword(@Body() body: { phone: string; otp: string; new_password: string }) {
    return this.authService.resetPassword(body.phone, body.otp, body.new_password);
  }

  @Post('2fa/reset-setup')
  @Public()
  @ApiTags(...TAG_WEB_ONLY)
  @ApiOperation({ summary: 'Admin: re-issue a TOTP secret during login setup (phone + password)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['phone', 'password'],
      properties: { phone: { type: 'string', example: '9800000003' }, password: { type: 'string' } },
    },
  })
  @ApiResponse({ status: 200, schema: TOTP_SETUP_RESPONSE_SCHEMA })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
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
  @AnyAuthenticatedRole()
  @ApiTags(...TAG_WEB_ONLY)
  @ApiOperation({ summary: 'Generate a TOTP secret for 2FA enrollment (authenticated, any role)' })
  @ApiResponse({ status: 200, schema: TOTP_SETUP_RESPONSE_SCHEMA })
  setup2fa(@Request() req: { user: { id: string } }) {
    return this.authService.setup2fa(req.user.id);
  }

  @Post('2fa/confirm')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @AnyAuthenticatedRole()
  @ApiTags(...TAG_WEB_ONLY)
  @ApiOperation({ summary: 'Confirm 2FA enrollment with a code from the authenticator app' })
  @ApiBody({ schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', example: '123456' } } } })
  @ApiResponse({ status: 200, schema: { type: 'object', properties: { success: { type: 'boolean' } } } })
  confirm2fa(@Request() req: { user: { id: string } }, @Body() body: { code: string }) {
    return this.authService.confirm2fa(req.user.id, body.code);
  }

  @Post('logout-all')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @AnyAuthenticatedRole()
  @ApiTags(...TAG_WEB_ONLY)
  @ApiOperation({ summary: 'Invalidate refresh tokens on all devices for the current user' })
  @ApiResponse({ status: 200, schema: { type: 'object', properties: { success: { type: 'boolean' } } } })
  logoutAll(@Request() req: { user: { id: string } }) {
    return this.authService.logoutAllDevices(req.user.id);
  }

  @Post('refresh')
  @Public()
  @ApiTags(...TAG_SHARED)
  @ApiOperation({
    summary: 'Refresh the access token',
    description: 'Both `userId` and `refresh_token` are required — the refresh token alone is not enough to look up the account.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['userId', 'refresh_token'],
      properties: {
        userId: { type: 'string', description: 'The `user.id` from the login response' },
        refresh_token: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 200, schema: { type: 'object', properties: { access_token: { type: 'string' } } } })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token.' })
  async refresh(@Body() body: { userId: string; refresh_token: string }) {
    return this.authService.refreshTokens(body.userId, body.refresh_token);
  }

  @Post('change-password')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @AnyAuthenticatedRole()
  @ApiTags(...TAG_MOBILE_ONLY)
  @ApiOperation({
    summary: 'Change your own password (authenticated, any role)',
    description:
      'Used for the forced first-login password change when an account was provisioned with the default ' +
      'password by Finance/HR/Admin (see `must_change_password` on the login response). ' +
      '⚠️ TEMPORARY: OTP verification is currently hardcoded to `123456` server-side until a real OTP/SMS ' +
      'provider is wired in — do not treat this as production-grade OTP verification yet.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['otp', 'newPassword'],
      properties: {
        otp: { type: 'string', example: '123456', description: 'Hardcoded to 123456 for now — see description.' },
        newPassword: {
          type: 'string',
          example: 'NewStr0ng@Pass',
          description: '8-72 chars, upper+lower+digit+special symbol',
        },
      },
    },
  })
  @ApiResponse({ status: 200, schema: { type: 'object', properties: { success: { type: 'boolean' } } } })
  @ApiResponse({ status: 401, description: 'Invalid OTP.' })
  @ApiResponse({ status: 400, description: 'Password does not meet strength requirements.' })
  changePassword(@Request() req: { user: { id: string } }, @Body() body: { otp: string; newPassword: string }) {
    return this.authService.changePassword(req.user.id, body.otp, body.newPassword);
  }

  @Post('logout')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @AnyAuthenticatedRole()
  @ApiTags(...TAG_SHARED)
  @ApiOperation({ summary: 'Logout the current session' })
  @ApiResponse({ status: 200, schema: { type: 'object', properties: { success: { type: 'boolean' } } } })
  async logout(@Request() req: any) {
    await this.authService.logout(req.user.id);
    return { success: true };
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @AnyAuthenticatedRole()
  @ApiTags(...TAG_WEB_ONLY)
  @ApiOperation({
    summary: 'Get the full user record from DB (includes full_name, email, branch_id)',
    description: 'Used by the web portal. The mobile app uses GET /user/profile instead (same underlying data, different envelope).',
  })
  @ApiResponse({ status: 200, description: 'Full user record.' })
  async getMe(@Request() req: any) {
    // FIX 2: call service.getMe(id) to get full record from DB
    // NOT req.user — that only has the JWT payload (no full_name)
    return this.authService.getMe(req.user.id);
  }
}
