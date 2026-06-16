import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
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
import {
  generateOtp,
  generateTotpSecret,
  buildOtpauthUrl,
  verifyTotp,
  totpCode,
  otpExpiresAt,
  isOtpExpired,
} from './auth-otp.util';

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
  ) {}

  // ────────────────────────────────────────────────────────────────────────────
  // Login audit helpers
  // ────────────────────────────────────────────────────────────────────────────

  async recordFailedLogin(
    phone: string,
    meta?: { ip?: string; userAgent?: string; failReason?: string },
  ): Promise<void> {
    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
      [phone],
    );
    if (rows[0]?.id) {
      await this.logLoginAttempt(rows[0].id, false, meta);
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

  async validateUser(phone: string, password: string): Promise<UserRecord> {
    const rows = await this.dataSource.query<UserRecord[]>(
      `SELECT id, phone, email, full_name, role, password_hash,
              is_active, branch_id, refresh_token_hash, active_session_id, last_login_at
       FROM users WHERE phone = $1 LIMIT 1`,
      [phone],
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
    const rows = await this.dataSource.query<{ metadata: Record<string, unknown> }[]>(
      `SELECT metadata FROM users WHERE id = $1`,
      [user.id],
    );
    const metadata = (rows[0]?.metadata ?? {}) as Record<string, unknown>;
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
          otpauth_url:   buildOtpauthUrl(secret, user.phone),
        };
      }

      if (!meta?.totp) {
        // Admin has a TOTP secret but no code provided — prompt for 2FA
        return { requires_2fa: true, user_id: user.id };
      }

      if (!verifyTotp(String(metadata.totp_secret), meta.totp)) {
        await this.logLoginAttempt(user.id, false, { ...meta, failReason: 'INVALID_2FA' });
        throw new UnauthorizedException('Invalid 2FA code');
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
      throw new Error('[HomeGenny] app.jwt.refreshSecret is not set in environment.');
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
      user: {
        id:        user.id,
        full_name: user.full_name,
        role:      user.role,
        phone:     user.phone,
        is_active: user.is_active,
        branch_id: user.branch_id,
      },
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Refresh tokens — hard 8-hour wall for Admin
  // ────────────────────────────────────────────────────────────────────────────

  async refreshTokens(userId: string, refreshToken: string): Promise<RefreshResponse> {
    const rows = await this.dataSource.query<UserRecord[]>(
      `SELECT id, phone, role, branch_id, refresh_token_hash, last_login_at
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
    const otp = generateOtp();
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

  // ────────────────────────────────────────────────────────────────────────────
  // TOTP management
  // ────────────────────────────────────────────────────────────────────────────

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
    return {
      id:        u.id,
      full_name: u.full_name,
      phone:     u.phone,
      email:     u.email,
      role:      u.role,
      is_active: u.is_active,
      branch_id: u.branch_id,
      permissions,
    };
  }
}
