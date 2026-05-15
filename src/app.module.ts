import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuthModule } from './modules/auth/auth.module';
import { StaffModule } from './modules/staff/staff.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';
import { VerificationModule } from './modules/verification/verification.module';
import { VideoCertModule } from './modules/video-cert/video-cert.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { MatchingModule } from './modules/matching/matching.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RestrictedListModule } from './modules/restricted-list/restricted-list.module';
import { PlacementModule } from './modules/placement/placement.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { AlarmsModule } from './modules/alarms/alarms.module';
import { AgreementsModule } from './modules/agreements/agreements.module';
import { ClientsModule } from './modules/clients/clients.module';
import { ReportsModule } from './modules/reports/reports.module';
import databaseConfig from './config/database.config';
import appConfig from './config/app.config';

function parseRedisUrl(url: string): { host: string; port: number; password?: string } {
  try {
    const u = new URL(url);
    return {
      host: u.hostname || '127.0.0.1',
      port: u.port ? parseInt(u.port, 10) : 6379,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return { host: '127.0.0.1', port: 6379 };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.production', '.env.local', '.env'],
      load: [databaseConfig, appConfig],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('DATABASE_URL'),
        autoLoadEntities: true,
        synchronize: config.get('NODE_ENV') === 'development',
        logging: config.get('NODE_ENV') === 'development',
        ssl: config.get('NODE_ENV') === 'production' ? { rejectUnauthorized: false } : false,
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('REDIS_URL') ?? 'redis://127.0.0.1:6379';
        const redis = parseRedisUrl(redisUrl);
        return { redis };
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    AuthModule,
    StaffModule,
    PipelineModule,
    VerificationModule,
    VideoCertModule,
    PayrollModule,
    MatchingModule,
    NotificationsModule,
    RestrictedListModule,
    PlacementModule,
    MonitoringModule,
    DashboardModule,
    AlarmsModule,
    AgreementsModule,
    ClientsModule,
    ReportsModule,
  ],
})
export class AppModule { }
