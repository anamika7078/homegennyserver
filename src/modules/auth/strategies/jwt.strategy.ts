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
    // effect until the access token naturally expired.
    //
    // This reads user_sessions rather than the old single
    // users.active_session_id column, so an account can hold several live
    // sessions at once (phone and web, or two people on a shared demo login)
    // and logging out of one leaves the others alone. One query: the account's
    // status comes back through the relation.
    if (!payload.sid) {
      throw new UnauthorizedException('Session is no longer active — please log in again');
    }
    const session = await this.prisma.userSession.findFirst({
      where: {
        id:        payload.sid,
        userId:    payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, user: { select: { isActive: true } } },
    });
    if (!session) {
      throw new UnauthorizedException('Session is no longer active — please log in again');
    }
    if (!session.user.isActive) {
      throw new UnauthorizedException('Account has been deactivated');
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
