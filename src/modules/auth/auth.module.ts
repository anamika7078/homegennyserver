import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    // Must use registerAsync: JwtModule.register() ran before ConfigModule loaded .env → secret was undefined → login 500
    JwtModule.registerAsync({
      imports:    [ConfigModule],
      inject:     [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:      config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn:
            config.get<string>('JWT_EXPIRES_IN')
            ?? config.get<string>('JWT_EXPIRY')
            ?? '15m',
        },
      }),
    }),
  ],
  providers:   [AuthService, JwtStrategy, JwtAuthGuard],
  controllers: [AuthController],
  exports:     [AuthService, JwtAuthGuard],
})
export class AuthModule {}
