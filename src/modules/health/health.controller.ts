import { Controller, Get, Post, Headers, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { PortalBootstrapService } from './portal-bootstrap.service';
import { SchemaBootstrapService } from './schema-bootstrap.service';
import { countPortalUsers } from '../../database/seeds/portal-users.seed';
import { PORTAL_USERS } from '../../database/seeds/portal-users.constants';

@ApiTags('Health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly portalBootstrap: PortalBootstrapService,
    private readonly schemaBootstrap: SchemaBootstrapService,
  ) {}

  @Get()
  async check() {
    let db = 'unknown';
    let portalUsers = 0;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'ok';
      portalUsers = await countPortalUsers(this.prisma);
    } catch {
      db = 'error';
    }
    return {
      status: db === 'ok' ? 'healthy' : 'degraded',
      database: db,
      portal_users: portalUsers,
      portal_users_expected: PORTAL_USERS.length,
      timestamp: new Date().toISOString(),
      version: '2.0.0',
    };
  }

  /** One-time bootstrap: POST with header x-seed-secret matching SEED_SECRET env */
  @Post('seed-portal-users')
  async seedPortalUsers(@Headers('x-seed-secret') secret?: string) {
    const expected = process.env.SEED_SECRET;
    if (!expected || secret !== expected) {
      throw new UnauthorizedException('Invalid seed secret');
    }
    return this.portalBootstrap.runSeed(true);
  }

  /** Ensure training/finance module tables exist (fixes /training/* 500 on fresh DBs) */
  @Post('ensure-module-tables')
  async ensureModuleTables(@Headers('x-seed-secret') secret?: string) {
    const expected = process.env.SEED_SECRET;
    if (!expected || secret !== expected) {
      throw new UnauthorizedException('Invalid seed secret');
    }
    await this.schemaBootstrap.ensureModuleTables();
    return { ok: true, message: 'training_batches, batch_enrollments, payroll_records, client_invoices verified' };
  }
}
