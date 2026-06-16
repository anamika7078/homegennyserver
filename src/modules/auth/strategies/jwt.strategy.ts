import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

/** Admin sessions must not exceed 8 hours from loginAt (in seconds). */
const ADMIN_SESSION_MAX_SECONDS = 8 * 60 * 60;

interface JwtPayload {
  sub:      string;
  phone:    string;
  role:     string;
  branchId: string | null;
  sid?:     string;
  loginAt?: number; // Unix epoch (seconds) when the original login occurred
  iat:      number;
  exp:      number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly config: ConfigService) {
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
    // ── Hard 8-hour session wall for Admin accounts ──────────────────────────
    if (payload.role === 'ADMIN' && payload.loginAt !== undefined) {
      const elapsed = Math.floor(Date.now() / 1000) - payload.loginAt;
      if (elapsed > ADMIN_SESSION_MAX_SECONDS) {
        throw new UnauthorizedException(
          'Admin session has expired (8-hour limit). Please log in again.',
        );
      }
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
