import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';

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
}

export interface LoginResponse {
  access_token:  string;
  refresh_token: string;
  user: {
    id:        string;
    full_name: string;   // FIX 1: was "name" — must be "full_name" to match User type
    role:      string;
    phone:     string;
    is_active: boolean;
    branch_id: string | null;
  };
}

export interface RefreshResponse { access_token: string; }

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async validateUser(phone: string, password: string): Promise<UserRecord> {
    const rows = await this.dataSource.query<UserRecord[]>(
      `SELECT id, phone, email, full_name, role, password_hash,
              is_active, branch_id, refresh_token_hash, active_session_id
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

  async login(user: UserRecord): Promise<LoginResponse> {
    const sessionId = require('uuid').v4();

    const payload = {
      sub:      user.id,
      phone:    user.phone,
      role:     user.role,
      branchId: user.branch_id,
      sid:      sessionId,
    };

    const accessToken = this.jwtService.sign(payload);

    const refreshSecret = this.config.get<string>('app.jwt.refreshSecret');
    const refreshExpiry = this.config.get<string>('app.jwt.refreshExpiresIn') ?? '7d';
    if (!refreshSecret) {
      throw new Error('[HomeGenny] app.jwt.refreshSecret is not set in environment.');
    }
    const refreshToken = this.jwtService.sign(
      { sub: user.id },
      { secret: refreshSecret, expiresIn: refreshExpiry },
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
    return {
      access_token:  accessToken,
      refresh_token: refreshToken,
      user: {
        id:        user.id,
        full_name: user.full_name,  // FIX 1: correct field name
        role:      user.role,
        phone:     user.phone,
        is_active: user.is_active,
        branch_id: user.branch_id,
      },
    };
  }

  async refreshTokens(userId: string, refreshToken: string): Promise<RefreshResponse> {
    const rows = await this.dataSource.query<UserRecord[]>(
      `SELECT id, phone, role, branch_id, refresh_token_hash
       FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (!rows.length || !rows[0].refresh_token_hash) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const valid = await bcrypt.compare(refreshToken, rows[0].refresh_token_hash);
    if (!valid) throw new UnauthorizedException('Invalid refresh token');

    const user    = rows[0];
    const payload = { sub: user.id, phone: user.phone, role: user.role, branchId: user.branch_id };
    return { access_token: this.jwtService.sign(payload) };
  }

  async logout(userId: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE users SET refresh_token_hash = NULL WHERE id = $1`, [userId],
    );
    this.logger.log(`[AUTH] Logout: ${userId}`);
  }

  // FIX 2: getMe queries DB for full user record — not raw JWT payload
  async getMe(userId: string): Promise<Record<string, unknown>> {
    const rows = await this.dataSource.query<UserRecord[]>(
      `SELECT id, phone, email, full_name, role, is_active, branch_id
       FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (!rows.length) throw new UnauthorizedException('User not found');
    const u = rows[0];
    return {
      id:        u.id,
      full_name: u.full_name,
      phone:     u.phone,
      email:     u.email,
      role:      u.role,
      is_active: u.is_active,
      branch_id: u.branch_id,
    };
  }
}
