import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

interface JwtPayload {
  sub:      string;
  phone:    string;
  role:     string;
  branchId: string | null;
  iat:      number;
  exp:      number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly config: ConfigService) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error(
        '[HomeGenny] JWT_SECRET environment variable is not set. ' +
        'Add JWT_SECRET to your .env.production file and restart.',
      );
    }
    super({
      jwtFromRequest:   ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:      secret,
    });
  }

  async validate(payload: JwtPayload): Promise<Record<string, unknown>> {
    return {
      id:       payload.sub,
      phone:    payload.phone,
      role:     payload.role,
      branchId: payload.branchId,
    };
  }
}
