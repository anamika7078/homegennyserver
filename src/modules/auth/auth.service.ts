import {
  Injectable,
  HttpException,
  HttpStatus,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
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
import { assertStrongPassword, hashPassword, verifyPassword } from '../../common/utils/password.util';
import { hashRefreshToken, refreshTokenMatches } from '../../common/utils/refresh-token.util';

/**
 * Temporary hardcoded OTP gating the first-time password change for accounts
 * provisioned with the default password (mustChangePassword=true).
 * TODO: replace with a real OTP/SMS provider.
 */
const MOCK_OTP_FALLBACK = '123456';

/** Maximum admin session lifetime: 8 hours (in seconds) */
const ADMIN_SESSION_MAX_SECONDS = 8 * 60 * 60;

/** Default refresh-token lifetime, matching JWT_REFRESH_EXPIRES_IN's 7d default. */
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

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
  /** Present when the record came from findUserByIdentifier; absent on the
   *  registration paths, which build this object by hand. */
  metadata?:          unknown;
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

  // ────────────────────────────────────────────────────────────────────────────
  // Per-account attempt limiting
  //
  // The IP throttle on the controller bounds how fast ONE address can try, but
  // the demo accounts and their password are printed on the login page, so the
  // interesting attack is a slow grind against one known account. This counts
  // failures per account *per source address* rather than per account alone:
  // a shared demo login must not be lockable for everybody by one person
  // hammering it from somewhere else, which is exactly what an account-wide
  // counter would allow.
  //
  // In memory, so it is per process — good enough for one container, and it
  // deliberately forgets everything on restart rather than persisting lockouts.
  // ────────────────────────────────────────────────────────────────────────────

  private readonly failedAttempts = new Map<string, { count: number; firstAt: number }>();
  private static readonly MAX_FAILED_ATTEMPTS = 10;
  private static readonly ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

  private attemptKey(identifier: string, ip?: string): string {
    return `${identifier.toLowerCase()}|${ip ?? 'unknown'}`;
  }

  /** Throws 429 once this identifier+address pair has burned through its attempts. */
  assertAttemptsRemaining(identifier: string, ip?: string): void {
    const entry = this.failedAttempts.get(this.attemptKey(identifier, ip));
    if (!entry) return;
    if (Date.now() - entry.firstAt > AuthService.ATTEMPT_WINDOW_MS) {
      this.failedAttempts.delete(this.attemptKey(identifier, ip));
      return;
    }
    if (entry.count >= AuthService.MAX_FAILED_ATTEMPTS) {
      const minutesLeft = Math.ceil(
        (AuthService.ATTEMPT_WINDOW_MS - (Date.now() - entry.firstAt)) / 60_000,
      );
      throw new HttpException(
        `Too many failed sign-in attempts for this account. Try again in ${minutesLeft} minute(s).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private noteFailedAttempt(identifier: string, ip?: string): void {
    const key = this.attemptKey(identifier, ip);
    const entry = this.failedAttempts.get(key);
    if (!entry || Date.now() - entry.firstAt > AuthService.ATTEMPT_WINDOW_MS) {
      this.failedAttempts.set(key, { count: 1, firstAt: Date.now() });
      return;
    }
    entry.count += 1;
    if (entry.count === AuthService.MAX_FAILED_ATTEMPTS) {
      this.logger.warn(
        `[AUTH] ${AuthService.MAX_FAILED_ATTEMPTS} failed sign-ins for "${identifier}" from ${ip ?? 'unknown'} — locked for 15 minutes.`,
      );
    }
  }

  /** Called after a successful sign-in, so a good password clears the count. */
  clearFailedAttempts(identifier: string, ip?: string): void {
    this.failedAttempts.delete(this.attemptKey(identifier, ip));
  }

  async recordFailedLogin(
    phoneOrEmail: string,
    meta?: { ip?: string; userAgent?: string; failReason?: string },
  ): Promise<void> {
    try {
      const identifier = String(phoneOrEmail || '').trim();
      this.noteFailedAttempt(identifier, meta?.ip);
      const found = await this.findUserByIdentifier(identifier);
      if (found?.id) {
        await this.logLoginAttempt(found.id, false, meta);
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

  /**
   * Looks up the account behind whatever the user typed.
   *
   * The old query ORed phone against LOWER(email) in a single statement, which
   * no index can serve — every sign-in sequentially scanned the users table. An
   * identifier is either an email address or a phone number, never both, so
   * decide first and then run a query that can use idx_users_phone or
   * idx_users_email_lower.
   */
  private async findUserByIdentifier(identifier: string): Promise<UserRecord | undefined> {
    const COLUMNS = `id, phone, email, full_name, role, password_hash,
                     is_active, branch_id, refresh_token_hash, active_session_id,
                     last_login_at, metadata`;
    if (identifier.includes('@')) {
      const rows = await this.dataSource.query<UserRecord[]>(
        `SELECT ${COLUMNS} FROM users
          WHERE LOWER(email) = LOWER($1) AND email IS NOT NULL AND email <> ''
          LIMIT 1`,
        [identifier],
      );
      return rows[0];
    }
    // Phone numbers get typed with +91, spaces and dashes; compare both forms.
    const cleanPhone = identifier.replace(/\D/g, '');
    const rows = await this.dataSource.query<UserRecord[]>(
      `SELECT ${COLUMNS} FROM users
        WHERE phone = $1 OR ($2 <> '' AND phone = $2)
        LIMIT 1`,
      [identifier, cleanPhone],
    );
    return rows[0];
  }

  async validateUser(phoneOrEmail: string, password: string): Promise<UserRecord> {
    const identifier = String(phoneOrEmail || '').trim();
    const found = await this.findUserByIdentifier(identifier);
    const rows = found ? [found] : [];
    if (!rows.length)    throw new UnauthorizedException('Invalid credentials');
    const user = rows[0];
    if (!user.is_active) throw new UnauthorizedException('Account is inactive');
    if (!(await verifyPassword(password, user.password_hash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Login — with Admin-specific TOTP enforcement
  // ────────────────────────────────────────────────────────────────────────────

  async login(
    user: UserRecord,
    meta?: { ip?: string; userAgent?: string; deviceId?: string; totp?: string },
  ): Promise<LoginResponse | { requires_2fa: true; user_id: string } | TotpSetupRequired> {
    // validateUser already read this row, metadata included. Only the
    // registration paths, which assemble a UserRecord by hand, still need the
    // extra round trip.
    const metadata = parseUserMetadata(
      user.metadata !== undefined
        ? user.metadata
        : (
            await this.dataSource.query<{ metadata: unknown }[]>(
              `SELECT metadata FROM users WHERE id = $1`,
              [user.id],
            )
          )[0]?.metadata,
    );
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
    // Signing in no longer ends the session on other devices: each login gets
    // its own row in user_sessions. The legacy users.active_session_id still
    // tracks the most recent one so the previous build keeps working if this
    // is rolled back.
    if (user.active_session_id && user.refresh_token_hash) {
      this.logger.log(
        `[AUTH] Additional session for ${user.phone} (previous sid=${user.active_session_id})`,
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
    // `sid` matters for more than lookup: the payload used to be just
    // { sub, loginAt } with loginAt in whole seconds, so two logins to the same
    // account inside the same second produced byte-identical refresh tokens —
    // two sessions sharing one token, where signing out of one left the other
    // refreshable with the same string. The session id makes every refresh
    // token unique to its own session.
    const refreshToken = this.jwtService.sign(
      { sub: user.id, sid: sessionId, loginAt },
      { secret: refreshSecret, expiresIn: isAdmin ? '8h' : refreshExpiry },
    );

    const hash = hashRefreshToken(refreshToken);
    const refreshTtlMs = (isAdmin ? ADMIN_SESSION_MAX_SECONDS : SEVEN_DAYS_SECONDS) * 1000;
    try {
      await this.prisma.userSession.create({
        data: {
          id:               sessionId,
          userId:           user.id,
          refreshTokenHash: hash,
          ipAddress:        meta?.ip?.slice(0, 64),
          userAgent:        meta?.userAgent?.slice(0, 400),
          expiresAt:        new Date(Date.now() + refreshTtlMs),
        },
      });
      await this.dataSource.query(
        `UPDATE users SET refresh_token_hash = $1, active_session_id = $2, last_login_at = NOW() WHERE id = $3`,
        [hash, sessionId, user.id],
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[AUTH] Could not persist the session for ${user.phone}: ${msg}. ` +
          'Grant INSERT on public.user_sessions and UPDATE on public.users to your DB user, ' +
          'or refresh-token endpoints may fail.',
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
    // A refresh token counts as one only if it still verifies under the refresh
    // secret and was issued to the account being refreshed. This check used to
    // be missing entirely — the stored-hash comparison below was the only gate,
    // and it was a bcrypt compare, which stops at 72 bytes. Every refresh token
    // we issue has the same first 72 bytes for a given user id, and a user id
    // is not a secret, so a string assembled from a known user id was accepted
    // as that user's refresh token.
    const refreshSecret = this.config.get<string>('app.jwt.refreshSecret');
    if (!refreshSecret) {
      this.logger.error('[HomeGenny] app.jwt.refreshSecret is not set in environment.');
      throw new UnauthorizedException('Authentication service misconfigured. Contact support.');
    }
    let tokenPayload: { sub?: string; sid?: string };
    try {
      tokenPayload = this.jwtService.verify<{ sub?: string; sid?: string }>(refreshToken, {
        secret: refreshSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (!tokenPayload.sub || tokenPayload.sub !== userId) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Which of this account's devices is asking. Several can be signed in at
    // once, so the answer comes from the token itself rather than from the one
    // hash the user row used to hold.
    const presentedHash = hashRefreshToken(refreshToken);
    const session = await this.prisma.userSession.findFirst({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        // Tokens issued before sessions existed carry no sid; fall back to
        // matching on the digest so those users are not signed out by a deploy.
        ...(tokenPayload.sid
          ? { id: tokenPayload.sid }
          : { refreshTokenHash: presentedHash }),
      },
      select: { id: true, refreshTokenHash: true },
    });
    if (!session || !refreshTokenMatches(refreshToken, session.refreshTokenHash)) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const rows = await this.dataSource.query<UserRecord[]>(
      `SELECT id, phone, role, branch_id, refresh_token_hash, active_session_id, last_login_at
       FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (!rows.length) throw new UnauthorizedException('Invalid refresh token');

    const user = rows[0];

    // ── Enforce absolute 8-hour Admin session wall ─────────────────────────
    if (user.role === 'ADMIN') {
      const loginAt = user.last_login_at
        ? new Date(user.last_login_at).getTime() / 1000
        : 0;
      const elapsed = Math.floor(Date.now() / 1000) - loginAt;
      if (elapsed > ADMIN_SESSION_MAX_SECONDS) {
        // Ends this device's session only — other devices keep theirs.
        void this.prisma.userSession.update({
          where: { id: session.id },
          data:  { revokedAt: new Date() },
        }).catch(() => undefined);
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
      sid:      session.id,
      loginAt,
    };

    const signOptions = user.role === 'ADMIN' ? { expiresIn: '8h' } : undefined;
    const accessToken = signOptions
      ? this.jwtService.sign(payload, signOptions)
      : this.jwtService.sign(payload);

    void this.prisma.userSession
      .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return { access_token: accessToken };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Logout
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Logout driven by whatever access token the client still has, even an
   * expired one. Signing out is the one operation that must not require a
   * live session: when the access token had already expired, the old flow
   * answered 401, the client gave up, and the session row stayed alive in the
   * database — the user believed they were signed out while their refresh
   * token was still valid. The signature is still checked, so this can only
   * ever end a session for a token this server actually issued; only the
   * expiry is ignored.
   *
   * Never throws. A logout that fails is a session that stays open.
   */
  async logoutFromToken(rawToken: string | undefined): Promise<{ success: boolean }> {
    if (!rawToken) return { success: true };
    const secret = this.config.get<string>('app.jwt.secret');
    let sub: string | undefined;
    let sid: string | undefined;
    try {
      const claims = this.jwtService.verify<{ sub?: string; sid?: string }>(rawToken, {
        secret,
        ignoreExpiration: true,
      });
      sub = claims.sub;
      sid = claims.sid;
    } catch {
      return { success: true }; // not a token we issued — nothing of ours to end
    }
    if (!sub) return { success: true };
    try {
      // Only the session this token belongs to. Signing out of the web portal
      // must not sign the same person out of the mobile app.
      await this.logout(sub, sid);
    } catch (err) {
      this.logger.warn(`[AUTH] Logout cleanup failed for ${sub}: ${err}`);
    }
    return { success: true };
  }

  /**
   * Ends one device's session, or every session for the account when no
   * session id is given (deactivation, logout-all, admin eviction).
   */
  async logout(userId: string, sessionId?: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null, ...(sessionId ? { id: sessionId } : {}) },
      data:  { revokedAt: new Date() },
    });
    await this.syncLegacySessionColumns(userId);
    this.logger.log(`[AUTH] Logout: ${userId}${sessionId ? ` (sid=${sessionId})` : ' (all devices)'}`);
  }

  async logoutAllDevices(userId: string): Promise<void> {
    await this.logout(userId);
  }

  /**
   * users.active_session_id / refresh_token_hash are no longer what
   * authentication reads, but they are still written so that rolling back to
   * the previous build finds a coherent session. Keep them pointed at whatever
   * session is most recently used, or NULL once none are left.
   */
  private async syncLegacySessionColumns(userId: string): Promise<void> {
    const latest = await this.prisma.userSession.findFirst({
      where:   { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select:  { id: true, refreshTokenHash: true },
    });
    await this.dataSource.query(
      `UPDATE users SET active_session_id = $1, refresh_token_hash = $2 WHERE id = $3`,
      [latest?.id ?? null, latest?.refreshTokenHash ?? null, userId],
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
    // TEMPORARY: a fixed code, because there is no SMS provider yet. Nothing is
    // actually sent to the phone, so anyone who knows a registered number can
    // complete the reset. Kept deliberately (see app.config otp), rate-limited
    // at the controller, and recorded here at warn level so its use is visible
    // in the logs rather than silent.
    const otp = this.mockOtp();
    this.logger.warn(
      `[AUTH] FIXED-OTP password reset issued for ${phone} — no SMS was sent. ` +
        'Set AUTH_MOCK_OTP=off once a real provider is wired in.',
    );
    const expires = otpExpiresAt();
    const metadata = {
      ...((rows[0] as UserRecord & { metadata?: Record<string, unknown> }).metadata ?? {}),
      password_reset: { otp, expires_at: expires.toISOString() },
    };
    await this.dataSource.query(`UPDATE users SET metadata = $1::jsonb WHERE id = $2`, [
      JSON.stringify(metadata),
      rows[0].id,
    ]);
    return { sent: true, expires_at: expires.toISOString() };
  }

  /**
   * The stand-in OTP, or null when AUTH_MOCK_OTP=off.
   *
   * Reading it from configuration rather than a constant means the fixed code
   * can be switched off in an environment without a code change, and makes it
   * obvious in one place that this is not a real one-time password.
   */
  private mockOtp(): string {
    const enabled = this.config.get<boolean>('app.otp.mockEnabled');
    if (!enabled) {
      throw new BadRequestException(
        'OTP delivery is not configured. Ask an administrator to reset your password.',
      );
    }
    return this.config.get<string>('app.otp.mock') ?? MOCK_OTP_FALLBACK;
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
    const hash = await hashPassword(newPassword);
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
    // Lower risk than the reset flow — this one already requires a valid access
    // token — but it is the same fixed code, so it is logged the same way.
    if (otp !== this.mockOtp()) {
      throw new UnauthorizedException('Invalid OTP');
    }
    this.logger.warn(`[AUTH] FIXED-OTP password change accepted for user ${userId}.`);
    assertStrongPassword(newPassword);
    const hash = await hashPassword(newPassword);
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
