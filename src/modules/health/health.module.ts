import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { AppVersionController } from './app-version.controller';
import { PortalBootstrapService } from './portal-bootstrap.service';
import { SchemaBootstrapService } from './schema-bootstrap.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HealthController, AppVersionController],
  providers: [PortalBootstrapService, SchemaBootstrapService],
  exports: [PortalBootstrapService, SchemaBootstrapService],
})
export class HealthModule {}
