import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { RbacService } from '../rbac/rbac.service';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FinanceCustomerService } from '../finance/customer/customer.service';
import { EmployeesService } from '../employees/employees.service';
import { UserProvisioningService } from './user-provisioning.service';
import { RegisterCustomerDto } from './dto/register-customer.dto';
import { RegisterStaffDto } from './dto/register-staff.dto';
import {
  generateTotpSecret,
  buildOtpauthUrl,
  verifyTotp,
  otpExpiresAt,
  isOtpExpired,
} from './auth-otp.util';
import { PORTAL_ADMIN_PHONE } from '../../database/seeds/portal-users.constants';
import { assertStrongPassword } from '../../common/utils/password.util';

/** bcrypt cost factor for self-serve (app) account passwords */
const APP_PASSWORD_BCRYPT_ROUNDS = 12;

/**
 * Temporary hardcoded OTP gating the first-time password change for accounts
 * provisioned with the default password (mustChangePassword=true).
 * TODO: replace with a real OTP/SMS provider.
 */
const MOCK_OTP = '123456';

/** Maximum admin session lifetime: 8 hours (in seconds) */
const ADMIN_SESSION_MAX_SECONDS = 8 * 60 * 60;

export interface UserRecord {
  id:                 string;
  phone:              string;
  email:              string | null;
  full_name:          string;
  role:               string;
  password_hash:      string | null;
  is_active:          boolean;
  branch_id:          string | null;
  refresh_token_hash: string | null;
  active_session_id:  string | null;
  last_login_at:      string | null;
}

export interface LoginResponse {
  access_token:  string;
  refresh_token: string;
  must_change_password: boolean;
  user: {
    id:        string;
    full_name: string;
    role:      string;
    phone:     string;
    is_active: boolean;
    branch_id: string | null;
  };
}

/**
 * Returned when an Admin account has no TOTP secret yet.
 * The frontend should show a QR-code enrollment wizard.
 */
export interface TotpSetupRequired {
  requires_totp_setup: true;
  user_id:             string;
  totp_secret:         string;
  otpauth_url:         string;
}

export interface RefreshResponse { access_token: string; }

function parseUserMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return raw as Record<string, unknown>;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly prisma: PrismaService,
    private readonly financeCustomer: FinanceCustomerService,
    private readonly employees: EmployeesService,
    private readonly userProvisioning: UserProvisioningService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────────
  // App self-registration — Customer (CLIENT) and Staff (STAFF)
  //
  // Both paths write straight into the same tables the Admin Panel uses
  // (finance_customers / employees) so the person shows up in Finance's
  // customer list / HR's employee list immediately — no separate "app user"
  // table. Each is linked back to `users` via the new nullable `user_id` FK.
  // ────────────────────────────────────────────────────────────────────────────

  private async assertPhoneAndEmailAvailable(phone: string, email?: string): Promise<void> {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ phone }, ...(email ? [{ email }] : [])] },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('An account with this phone number or email already exists');
    }
  }

  private toUserRecord(u: {
    id: string;
    phone: string;
    email: string | null;
    fullName: string;
    role: string;
    passwordHash: string | null;
    isActive: boolean;
    branchId: string | null;
    refreshTokenHash: string | null;
    activeSessionId: string | null;
    lastLoginAt: Date | null;
  }): UserRecord {
    return {
      id: u.id,
      phone: u.phone,
      email: u.email,
      full_name: u.fullName,
      role: u.role,
      password_hash: u.passwordHash,
      is_active: u.isActive,
      branch_id: u.branchId,
      refresh_token_hash: u.refreshTokenHash,
      active_session_id: u.activeSessionId,
      last_login_at: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    };
  }

  /**
   * Public self-registration for a Customer. Creates the login account (role
   * CLIENT) AND a linked `finance_customers` row in the same flow, so the
   * customer appears in Finance's customer list right away. If the finance
   * record fails to create (e.g. duplicate PAN), the just-created user is
   * rolled back so we never leave an orphaned login with no business record.
   */
  async registerCustomer(
    dto: RegisterCustomerDto,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<LoginResponse | { requires_2fa: true; user_id: string } | TotpSetupRequired> {
    await this.assertPhoneAndEmailAvailable(dto.phone, dto.email);

    const customer = await this.financeCustomer.createCustomer({
      customer_name: dto.business_name?.trim() || dto.full_name,
      address:       dto.address,
      pan_card:      dto.pan_card,
      gstn:          dto.gstn,
      city:          dto.city,
      state:         dto.state,
      pincode:       dto.pincode,
    });
    const user = await this.userProvisioning.linkClientAccount({
      financeCustomerId: customer.id,
      fullName:           dto.full_name,
      phone:              dto.phone,
      email:              dto.email,
      password:           dto.password, // self-registered — always explicit, never the default
    });
    if (!user) {
      throw new BadRequestException('A phone number is required to register.');
    }

    this.logger.log(`[AUTH] Registered CLIENT ${user.phone} — linked to finance_customers`);
    return this.login(this.toUserRecord(user), meta);
  }

  /**
   * Public self-registration for Staff. Creates the login account (role
   * STAFF) AND a linked `employees` row with placeholder branch/category and
   * status PENDING_HR_REVIEW — so the person shows up in HR's employee list
   * immediately, flagged for HR to fill in branch/category/salary/designation.
   * Rolled back the same way as registerCustomer if the employee row fails.
   */
  async registerStaff(
    dto: RegisterStaffDto,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<LoginResponse | { requires_2fa: true; user_id: string } | TotpSetupRequired> {
    await this.assertPhoneAndEmailAvailable(dto.phone, dto.email);

    const employee = await this.employees.create({
      fullName:         dto.full_name,
      mobile:           dto.phone,
      alternateMobile:  dto.alternate_phone,
      email:            dto.email,
      dateOfBirth:      dto.date_of_birth,
      gender:           dto.gender,
      address:          dto.address,
      city:             dto.city,
      state:            dto.state,
      pincode:          dto.pincode,
      emergencyContact: {},
      joiningDate:      new Date().toISOString(),
      department:       'Not Assigned',
      designation:      'Not Assigned',
      employmentType:   'Not Assigned',
      salary:           0,
      status:           'PENDING_HR_REVIEW',
    });
    const user = await this.userProvisioning.linkStaffAccount({
      employeeId: employee.id,
      mobile:     dto.phone,
      fullName:   dto.full_name,
      email:      dto.email,
      password:   dto.password, // self-registered — always explicit, never the default
    });

    this.logger.log(`[AUTH] Registered STAFF ${user.phone} — linked to employees (PENDING_HR_REVIEW)`);
    return this.login(this.toUserRecord(user), meta);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Login audit helpers
  // ────────────────────────────────────────────────────────────────────────────

  async recordFailedLogin(
    phoneOrEmail: string,
    meta?: { ip?: string; userAgent?: string; failReason?: string },
  ): Promise<void> {
    try {
      const identifier = String(phoneOrEmail || '').trim();
      const cleanPhone = identifier.replace(/\D/g, '');
      const rows = await this.dataSource.query<{ id: string }[]>(
        `SELECT id FROM users 
         WHERE phone = $1 
            OR (LOWER(email) = LOWER($1) AND email IS NOT NULL AND email != '')
            OR ($2 != '' AND phone = $2)
         LIMIT 1`,
        [identifier, cleanPhone],
      );
      if (rows[0]?.id) {
        await this.logLoginAttempt(rows[0].id, false, meta);
      }
    } catch (err) {
      this.logger.warn(`Failed-login audit write failed: ${err}`);
    }
  }

  async logLoginAttempt(
    userId: string,
    success: boolean,
    meta?: { ip?: string; userAgent?: string; deviceId?: string; failReason?: string },
  ): Promise<void> {
    try {
      await this.prisma.loginAudit.create({
        data: {
          userId,
          ipAddress: meta?.ip,
          userAgent: meta?.userAgent,
          deviceId: meta?.deviceId,
          success,
          failReason: meta?.failReason,
        },
      });
    } catch (err) {
      this.logger.warn(`Login audit write failed: ${err}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Credentials validation
  // ────────────────────────────────────────────────────────────────────────────

  async validateUser(phoneOrEmail: string, password: string): Promise<UserRecord> {
    const identifier = String(phoneOrEmail || '').trim();
    const cleanPhone = identifier.replace(/\D/g, '');

    const rows = await this.dataSource.query<UserRecord[]>(
      `SELECT id, phone, email, full_name, role, password_hash,
              is_active, branch_id, refresh_token_hash, active_session_id, last_login_at
       FROM users 
       WHERE phone = $1 
          OR (LOWER(email) = LOWER($1) AND email IS NOT NULL AND email != '')
          OR ($2 != '' AND phone = $2)
       LIMIT 1`,
      [identifier, cleanPhone],
    );
    if (!rows.length)    throw new UnauthorizedException('Invalid credentials');
    const user = rows[0];
    if (!user.is_active) throw new UnauthorizedException('Account is inactive');
    if (!user.password_hash?.startsWith('$2')) {
      throw new UnauthorizedException('Invalid credentials');
    }
    let valid = false;
    try {
      valid = await bcrypt.compare(password, user.password_hash);
    } catch {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!valid) throw new UnauthorizedException('Invalid credentials');
    return user;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Login — with Admin-specific TOTP enforcement
  // ────────────────────────────────────────────────────────────────────────────

  async login(
    user: UserRecord,
    meta?: { ip?: string; userAgent?: string; deviceId?: string; totp?: string },
  ): Promise<LoginResponse | { requires_2fa: true; user_id: string } | TotpSetupRequired> {
    const rows = await this.dataSource.query<{ metadata: unknown }[]>(
      `SELECT metadata FROM users WHERE id = $1`,
      [user.id],
    );
    const metadata = parseUserMetadata(rows[0]?.metadata);
    const isAdmin = user.role === 'ADMIN';

    // ── ADMIN: mandatory hardware/TOTP 2FA ──────────────────────────────────
    if (isAdmin) {
      if (!metadata.totp_secret) {
        // First-time Admin login: auto-provision TOTP secret (base32) and ask UI to show QR setup wizard
        const secret = generateTotpSecret();
        const newMeta = { ...metadata, totp_secret: secret, totp_enabled: false };
        await this.dataSource.query(
          `UPDATE users SET metadata = $1::jsonb WHERE id = $2`,
          [JSON.stringify(newMeta), user.id],
        );
        this.logger.warn(`[ADMIN-2FA] Generated new TOTP secret for Admin ${user.phone}`);
        return {
          requires_totp_setup: true,
          user_id:       user.id,
          totp_secret:   secret,
          otpauth_url:   buildOtpauthUrl(secret, user.phone, `HomeGenny Admin:${user.phone}`),
        };
      }

      if (!meta?.totp) {
        // Setup not finished — show QR wizard again with the stored secret
        if (!metadata.totp_enabled) {
          const secret = String(metadata.totp_secret);
          return {
            requires_totp_setup: true,
            user_id:     user.id,
            totp_secret: secret,
            otpauth_url: buildOtpauthUrl(secret, user.phone, `HomeGenny Admin:${user.phone}`),
          };
        }
        return { requires_2fa: true, user_id: user.id };
      }

      const totpSecret = String(metadata.totp_secret).trim();
      if (!verifyTotp(totpSecret, String(meta.totp).trim())) {
        await this.logLoginAttempt(user.id, false, { ...meta, failReason: 'INVALID_2FA' });
        const hint =
          user.phone === PORTAL_ADMIN_PHONE
            ? ' Scan the QR on login or add the setup key in your authenticator app.'
            : '';
        throw new UnauthorizedException(`Invalid 2FA code.${hint}`);
      }

      // Mark TOTP as confirmed if this is their first successful use
      if (!metadata.totp_enabled) {
        const confirmedMeta = { ...metadata, totp_enabled: true };
        await this.dataSource.query(
          `UPDATE users SET metadata = $1::jsonb WHERE id = $2`,
          [JSON.stringify(confirmedMeta), user.id],
        );
      }
    } else {
      // ── Non-admin: optional TOTP (existing behaviour) ─────────────────────
      if (metadata.totp_enabled && metadata.totp_secret) {
        if (!meta?.totp) {
          return { requires_2fa: true, user_id: user.id };
        }
        if (!verifyTotp(String(metadata.totp_secret), meta.totp)) {
          await this.logLoginAttempt(user.id, false, { ...meta, failReason: 'INVALID_2FA' });
          throw new UnauthorizedException('Invalid 2FA code');
        }
      }
    }

    // ── Evict stale session ──────────────────────────────────────────────────
    if (user.active_session_id && user.refresh_token_hash) {
      this.logger.warn(
        `[AUTH] Evicting stale session for ${user.phone} (sid=${user.active_session_id})`,
      );
    }

    const sessionId = randomUUID();
    const loginAt   = Math.floor(Date.now() / 1000);

    // ── Admin gets shorter-lived access token, loginAt embedded in payload ──
    const adminExpiresIn = isAdmin ? '8h' : undefined;
    const payload = {
      sub:      user.id,
      phone:    user.phone,
      role:     user.role,
      branchId: user.branch_id,
      sid:      sessionId,
      loginAt,  // absolute session start for Admin 8-hour enforcement
    };

    const signOptions = adminExpiresIn
      ? { expiresIn: adminExpiresIn }
      : undefined;

    const accessToken = signOptions
      ? this.jwtService.sign(payload, signOptions)
      : this.jwtService.sign(payload);

    const refreshSecret = this.config.get<string>('app.jwt.refreshSecret');
    const refreshExpiry = this.config.get<string>('app.jwt.refreshExpiresIn') ?? '7d';
    if (!refreshSecret) {
      this.logger.error('[HomeGenny] app.jwt.refreshSecret is not set in environment.');
      throw new UnauthorizedException('Authentication service misconfigured. Contact support.');
    }
    const refreshToken = this.jwtService.sign(
      { sub: user.id, loginAt },                  // loginAt carried in refresh token too
      { secret: refreshSecret, expiresIn: isAdmin ? '8h' : refreshExpiry },
    );

    const hash = await bcrypt.hash(refreshToken, 10);
    try {
      await this.dataSource.query(
        `UPDATE users SET refresh_token_hash = $1, active_session_id = $2, last_login_at = NOW() WHERE id = $3`,
        [hash, sessionId, user.id],
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[AUTH] Could not persist refresh_token_hash for ${user.phone}: ${msg}. ` +
          'Grant UPDATE on public.users to your DB user, or refresh-token endpoints may fail.',
      );
    }

    let roleMeta: Record<string, any> = {};
    if (user.role === 'STAFF') {
      const staffApplicant = await this.prisma.staffApplicant.findFirst({
        where: { OR: [{ id: user.id }, { mobile: user.phone }] },
      });
      roleMeta = {
        staffCode: staffApplicant?.staffCode || 'STF-1029',
        pipelineStage: staffApplicant?.pipelineStage || 'S2_VERIFY',
        series: staffApplicant?.series || 'MAID',
        assignedRm: {
          name: 'Amit Gupta (RM)',
          phone: '+919800000001',
        },
      };
    } else if (user.role === 'CLIENT') {
      const customer = await this.prisma.financeCustomer.findFirst({
        where: { userId: user.id },
      });
      roleMeta = {
        customerCode: customer?.id || 'CL-881',
        customerName: customer?.customerName || user.full_name,
        activePlacements: 1,
      };
    }

    this.logger.log(`[AUTH] Login: ${user.phone} (${user.role})`);
    void this.logLoginAttempt(user.id, true, meta);
    void this.audit.log({
      actorId:    user.id,
      action:     AuditAction.LOGIN,
      entityType: 'user',
      entityId:   user.id,
      metadata:   { role: user.role, sessionId, loginAt },
    });

    return {
      access_token:  accessToken,
      refresh_token: refreshToken,
      must_change_password: metadata.mustChangePassword === true,
      user: {
        id:        user.id,
        full_name: user.full_name,
        role:      user.role,
        phone:     user.phone,
        is_active: user.is_active,
        branch_id: user.branch_id,
        ...roleMeta,
      },
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Refresh tokens — hard 8-hour wall for Admin
  // ────────────────────────────────────────────────────────────────────────────

  async refreshTokens(userId: string, refreshToken: string): Promise<RefreshResponse> {
    const rows = await this.dataSource.query<UserRecord[]>(
      `SELECT id, phone, role, branch_id, refresh_token_hash, active_session_id, last_login_at
       FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (!rows.length || !rows[0].refresh_token_hash) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const valid = await bcrypt.compare(refreshToken, rows[0].refresh_token_hash);
    if (!valid) throw new UnauthorizedException('Invalid refresh token');

    const user = rows[0];

    // ── Enforce absolute 8-hour Admin session wall ─────────────────────────
    if (user.role === 'ADMIN') {
      const loginAt = user.last_login_at
        ? new Date(user.last_login_at).getTime() / 1000
        : 0;
      const elapsed = Math.floor(Date.now() / 1000) - loginAt;
      if (elapsed > ADMIN_SESSION_MAX_SECONDS) {
        // Evict the session
        void this.dataSource.query(
          `UPDATE users SET refresh_token_hash = NULL, active_session_id = NULL WHERE id = $1`,
          [userId],
        );
        throw new ForbiddenException(
          'Admin session has expired (8-hour limit). Please log in again.',
        );
      }
    }

    const loginAt = user.last_login_at
      ? Math.floor(new Date(user.last_login_at).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    const payload = {
      sub:      user.id,
      phone:    user.phone,
      role:     user.role,
      branchId: user.branch_id,
      // Carry the current session forward so the reissued access token still
      // matches active_session_id in JwtStrategy.validate() — without this,
      // every refreshed token would immediately fail the session check below.
      sid:      user.active_session_id,
      loginAt,
    };

    const signOptions = user.role === 'ADMIN' ? { expiresIn: '8h' } : undefined;
    const accessToken = signOptions
      ? this.jwtService.sign(payload, signOptions)
      : this.jwtService.sign(payload);

    return { access_token: accessToken };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Logout
  // ────────────────────────────────────────────────────────────────────────────

  async logout(userId: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE users SET refresh_token_hash = NULL, active_session_id = NULL WHERE id = $1`,
      [userId],
    );
    this.logger.log(`[AUTH] Logout: ${userId}`);
  }

  async logoutAllDevices(userId: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE users SET refresh_token_hash = NULL, active_session_id = NULL WHERE id = $1`,
      [userId],
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Password reset flow
  // ────────────────────────────────────────────────────────────────────────────

  async forgotPassword(phone: string): Promise<{ sent: boolean; expires_at: string }> {
    const rows = await this.dataSource.query<UserRecord[]>(
      `SELECT id, metadata FROM users WHERE phone = $1 LIMIT 1`,
      [phone],
    );
    if (!rows.length) {
      return { sent: true, expires_at: otpExpiresAt().toISOString() };
    }
    // TEMPORARY: hardcoded to MOCK_OTP (same as /auth/change-password) until a real
    // OTP/SMS provider is wired in — was `generateOtp()` (real, random) before this.
    const otp = MOCK_OTP;
    const expires = otpExpiresAt();
    const metadata = {
      ...((rows[0] as UserRecord & { metadata?: Record<string, unknown> }).metadata ?? {}),
      password_reset: { otp, expires_at: expires.toISOString() },
    };
    await this.dataSource.query(`UPDATE users SET metadata = $1::jsonb WHERE id = $2`, [
      JSON.stringify(metadata),
      rows[0].id,
    ]);
    this.logger.log(`[AUTH] Password reset OTP for ${phone}: ${otp} (dev log)`);
    return { sent: true, expires_at: expires.toISOString() };
  }

  async verifyOtp(phone: string, otp: string): Promise<{ valid: boolean }> {
    const rows = await this.dataSource.query<{ metadata: Record<string, unknown> }[]>(
      `SELECT metadata FROM users WHERE phone = $1 LIMIT 1`,
      [phone],
    );
    if (!rows.length) return { valid: false };
    const reset = (rows[0].metadata?.password_reset ?? {}) as {
      otp?: string;
      expires_at?: string;
    };
    if (reset.otp !== otp || isOtpExpired(reset.expires_at)) {
      return { valid: false };
    }
    return { valid: true };
  }

  async resetPassword(phone: string, otp: string, newPassword: string): Promise<{ success: boolean }> {
    const valid = await this.verifyOtp(phone, otp);
    if (!valid.valid) throw new BadRequestException('Invalid or expired OTP');
    const hash = await bcrypt.hash(newPassword, 12);
    await this.dataSource.query(
      `UPDATE users SET password_hash = $1,
        metadata = metadata - 'password_reset',
        refresh_token_hash = NULL, active_session_id = NULL
       WHERE phone = $2`,
      [hash, phone],
    );
    return { success: true };
  }

  /**
   * Authenticated password change — used to clear `mustChangePassword` after
   * a user provisioned with the default password (Finance/HR/Admin onboarding)
   * logs in for the first time. Gated by a temporary hardcoded OTP until a
   * real OTP/SMS provider is wired in.
   */
  async changePassword(userId: string, otp: string, newPassword: string): Promise<{ success: boolean }> {
    if (otp !== MOCK_OTP) {
      throw new UnauthorizedException('Invalid OTP');
    }
    assertStrongPassword(newPassword);
    const hash = await bcrypt.hash(newPassword, 12);
    const rows = await this.dataSource.query<{ metadata: unknown }[]>(
      `SELECT metadata FROM users WHERE id = $1`,
      [userId],
    );
    if (!rows.length) throw new UnauthorizedException('Account not found');
    const metadata = { ...parseUserMetadata(rows[0].metadata), mustChangePassword: false };
    await this.dataSource.query(
      `UPDATE users SET password_hash = $1, metadata = $2::jsonb WHERE id = $3`,
      [hash, JSON.stringify(metadata), userId],
    );
    return { success: true };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // TOTP management
  // ────────────────────────────────────────────────────────────────────────────

  /** Admin-only: issue a fresh TOTP secret (e.g. wrong authenticator entry scanned). */
  async resetAdmin2faSetup(phone: string, password: string): Promise<TotpSetupRequired> {
    const user = await this.validateUser(phone, password);
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Only Admin accounts use this setup flow');
    }

    const secret = generateTotpSecret();
    const rows = await this.dataSource.query<{ metadata: unknown }[]>(
      `SELECT metadata FROM users WHERE id = $1`,
      [user.id],
    );
    const metadata = parseUserMetadata(rows[0]?.metadata);
    const newMeta = { ...metadata, totp_secret: secret, totp_enabled: false };
    await this.dataSource.query(
      `UPDATE users SET metadata = $1::jsonb WHERE id = $2`,
      [JSON.stringify(newMeta), user.id],
    );
    this.logger.warn(`[ADMIN-2FA] Reset TOTP secret for Admin ${user.phone}`);

    return {
      requires_totp_setup: true,
      user_id:       user.id,
      totp_secret:   secret,
      otpauth_url:   buildOtpauthUrl(secret, user.phone, `HomeGenny Admin:${user.phone}`),
    };
  }

  async setup2fa(userId: string): Promise<{ secret: string; otpauth_url: string }> {
    const secret = generateTotpSecret();
    const rows = await this.dataSource.query<{ phone: string; metadata: Record<string, unknown> }[]>(
      `SELECT phone, metadata FROM users WHERE id = $1`,
      [userId],
    );
    if (!rows.length) throw new UnauthorizedException('User not found');
    const metadata = { ...(rows[0].metadata ?? {}), totp_secret: secret, totp_enabled: false };
    await this.dataSource.query(`UPDATE users SET metadata = $1::jsonb WHERE id = $2`, [
      JSON.stringify(metadata),
      userId,
    ]);
    return {
      secret,
      otpauth_url: buildOtpauthUrl(secret, rows[0].phone),
    };
  }

  async confirm2fa(userId: string, code: string): Promise<{ enabled: boolean }> {
    const rows = await this.dataSource.query<{ metadata: Record<string, unknown> }[]>(
      `SELECT metadata FROM users WHERE id = $1`,
      [userId],
    );
    const secret = rows[0]?.metadata?.totp_secret;
    if (!secret || !verifyTotp(String(secret), code)) {
      throw new BadRequestException('Invalid authenticator code');
    }
    const metadata = { ...(rows[0]?.metadata ?? {}), totp_enabled: true };
    await this.dataSource.query(`UPDATE users SET metadata = $1::jsonb WHERE id = $2`, [
      JSON.stringify(metadata),
      userId,
    ]);
    return { enabled: true };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Get current user
  // ────────────────────────────────────────────────────────────────────────────

  async getMe(userId: string): Promise<Record<string, unknown>> {
    const rows = await this.dataSource.query<UserRecord[]>(
      `SELECT id, phone, email, full_name, role, is_active, branch_id
       FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (!rows.length) throw new UnauthorizedException('User not found');
    const u = rows[0];
    const permissions = await this.rbac.getPermissionsForRole(u.role);

    const [customer, employee] = await Promise.all([
      this.prisma.financeCustomer.findUnique({
        where:  { userId },
        select: { id: true, unitCode: true, status: true },
      }),
      this.prisma.employee.findFirst({
        where:  { userId },
        select: { id: true, employeeId: true, status: true },
      }),
    ]);

    return {
      id:        u.id,
      full_name: u.full_name,
      phone:     u.phone,
      email:     u.email,
      role:      u.role,
      is_active: u.is_active,
      branch_id: u.branch_id,
      permissions,
      customer_profile: customer
        ? { id: customer.id, unit_code: customer.unitCode, status: customer.status }
        : null,
      employee_profile: employee
        ? { id: employee.id, employee_id: employee.employeeId, status: employee.status }
        : null,
    };
  }
}
