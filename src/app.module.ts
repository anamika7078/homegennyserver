import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
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
import { PrismaModule } from './prisma/prisma.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { AuditModule } from './modules/audit/audit.module';
import { ScenarioModule } from './modules/scenario/scenario.module';
import { EnterpriseCronModule } from './modules/cron/cron.module';
import { SeriesModule } from './modules/series/series.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { HealthModule } from './modules/health/health.module';
import { RmModule } from './modules/rm/rm.module';
import { TrainingModule } from './modules/training/training.module';
import { FinanceModule } from './modules/finance/finance.module';
import { AssessorsModule } from './modules/assessors/assessors.module';
import { AssessmentsModule } from './modules/assessments/assessments.module';
import { DriverTestsModule } from './modules/driver-tests/driver-tests.module';
import { CompetencyModule } from './modules/competency/competency.module';
import { SchedulesModule } from './modules/schedules/schedules.module';
import { AdminModule } from './modules/admin/admin.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { QueuesModule } from './modules/queues/queues.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { SystemHealthModule } from './modules/system-health/system-health.module';
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
        url: config.get<string>('database.url'),
        autoLoadEntities: true,
        synchronize: config.get<boolean>('database.synchronize'),
        logging: config.get('app.env') === 'development',
        ssl: config.get('app.env') === 'production' ? { rejectUnauthorized: false } : false,
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('app.redis.url') ?? 'redis://127.0.0.1:6379';
        const redis = parseRedisUrl(redisUrl);
        return { redis };
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    PrismaModule,
    RbacModule,
    AuditModule,
    ScenarioModule,
    EnterpriseCronModule,
    SeriesModule,
    RealtimeModule,
    HealthModule,
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
    RmModule,
    TrainingModule,
    FinanceModule,
    AssessorsModule,
    AssessmentsModule,
    DriverTestsModule,
    CompetencyModule,
    SchedulesModule,
    AdminModule,
    PrivacyModule,
    QueuesModule,
    ComplianceModule,
    SystemHealthModule,
  ],
  controllers: [AppController],
})
export class AppModule { }
