import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PortalBootstrapService } from './portal-bootstrap.service';
import { SchemaBootstrapService } from './schema-bootstrap.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
  providers: [PortalBootstrapService, SchemaBootstrapService],
  exports: [PortalBootstrapService, SchemaBootstrapService],
})
export class HealthModule {}
