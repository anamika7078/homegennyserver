import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { countPortalUsers, ensurePortalAdmin2fa, seedPortalUsers } from '../../database/seeds/portal-users.seed';
import { PORTAL_USERS } from '../../database/seeds/portal-users.constants';

@Injectable()
export class PortalBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(PortalBootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const autoSeed =
      process.env.AUTO_SEED_USERS === 'true' ||
      this.config.get<string>('app.env') === 'production';

    if (!autoSeed) return;

    try {
      const existing = await countPortalUsers(this.prisma);
      if (existing >= PORTAL_USERS.length) {
        const reset = await ensurePortalAdmin2fa(this.prisma);
        this.logger.log(
          `Portal users ready (${existing}/${PORTAL_USERS.length})` +
            (reset ? ' — demo Admin 2FA reset to bootstrap secret' : ''),
        );
        return;
      }

      const result = await seedPortalUsers(this.prisma, { force: true });
      this.logger.warn(
        `[BOOTSTRAP] Seeded ${result.seeded} portal login users (password: ${result.password})`,
      );
    } catch (err) {
      this.logger.error(
        `[BOOTSTRAP] Portal user seed failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async runSeed(force = false) {
    const existing = await countPortalUsers(this.prisma);
    if (!force && existing >= PORTAL_USERS.length) {
      return { seeded: 0, existing, total: PORTAL_USERS.length, message: 'Portal users already present' };
    }
    const result = await seedPortalUsers(this.prisma, { force: true });
    return {
      seeded: result.seeded,
      existing: await countPortalUsers(this.prisma),
      total: PORTAL_USERS.length,
      phones: result.phones,
      admin_2fa_reset: await ensurePortalAdmin2fa(this.prisma),
      message: `Seeded ${result.seeded} portal users`,
    };
  }
}
