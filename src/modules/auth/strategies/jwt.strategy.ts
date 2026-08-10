import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';

/** Admin sessions must not exceed 8 hours from loginAt (in seconds). */
const ADMIN_SESSION_MAX_SECONDS = 8 * 60 * 60;

interface JwtPayload {
  sub:      string;
  phone:    string;
  role:     string;
  branchId: string | null;
  sid?:     string | null;
  loginAt?: number; // Unix epoch (seconds) when the original login occurred
  iat:      number;
  exp:      number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const secret = config.get<string>('app.jwt.secret');
    if (!secret) {
      throw new Error(
        '[HomeGenny] app.jwt.secret configuration is not set. ' +
        'Check your environment variables.',
      );
    }
    super({
      jwtFromRequest:   ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:      secret,
    });
  }

  async validate(payload: JwtPayload): Promise<Record<string, unknown>> {
    // ── Hard 8-hour session wall for Admin accounts (cheap, payload-only check
    // first, before hitting the DB) ──────────────────────────────────────────
    if (payload.role === 'ADMIN' && payload.loginAt !== undefined) {
      const elapsed = Math.floor(Date.now() / 1000) - payload.loginAt;
      if (elapsed > ADMIN_SESSION_MAX_SECONDS) {
        throw new UnauthorizedException(
          'Admin session has expired (8-hour limit). Please log in again.',
        );
      }
    }

    // ── Live revocation check — every previously-issued JWT is only as good
    // as the account/session it was issued for right now, not at issue time.
    // Without this, deactivating a user or calling logout/logout-all had no
    // effect until the 15-minute access token naturally expired.
    const user = await this.prisma.user.findUnique({
      where:  { id: payload.sub },
      select: { isActive: true, activeSessionId: true },
    });
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('Account has been deactivated');
    }
    // Single-active-session enforcement: a new login (or logout/logout-all,
    // which clears active_session_id to NULL) changes this value, so any
    // token minted for the previous session — including one already handed
    // out — stops validating on its very next request.
    if (payload.sid !== user.activeSessionId) {
      throw new UnauthorizedException('Session is no longer active — please log in again');
    }

    return {
      id:       payload.sub,
      phone:    payload.phone,
      role:     payload.role,
      branchId: payload.branchId,
      sid:      payload.sid,
      loginAt:  payload.loginAt,
    };
  }
}
