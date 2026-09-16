import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PERMISSIONS, ROLE_PERMISSION_MAP } from './permissions.constants';
import { UserRole } from '../auth/decorators/roles.decorator';

@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

  async seedPermissions(): Promise<void> {
    this.permissionCache.clear();
    for (const p of PERMISSIONS) {
      await this.prisma.permission.upsert({
        where: { code: p.code },
        create: p,
        update: { name: p.name, module: p.module },
      });
    }

    for (const [role, codes] of Object.entries(ROLE_PERMISSION_MAP)) {
      for (const code of codes) {
        const perm = await this.prisma.permission.findUnique({ where: { code } });
        if (!perm) continue;
        await this.prisma.rolePermission.upsert({
          where: {
            role_permissionId: {
              role: role as UserRole,
              permissionId: perm.id,
            },
          },
          create: { role: role as UserRole, permissionId: perm.id },
          update: {},
        });
      }
    }
  }

  /**
   * Cached per role for a minute.
   *
   * There are ten roles and their permission rows change only when someone
   * edits the RBAC seed, but this join ran on every /auth/me and on every
   * permission check — a two-table read to answer a question whose answer is
   * the same all day. seedPermissions() clears the cache, so an edit still
   * takes effect immediately for the process that made it; other processes
   * pick it up within the minute.
   */
  private readonly permissionCache = new Map<string, { codes: string[]; expiresAt: number }>();
  private static readonly PERMISSION_TTL_MS = 60_000;

  async getPermissionsForRole(role: string): Promise<string[]> {
    const cached = this.permissionCache.get(role);
    if (cached && cached.expiresAt > Date.now()) return cached.codes;

    try {
      const rows = await this.prisma.rolePermission.findMany({
        where: { role: role as UserRole },
        include: { permission: true },
      });
      const codes = rows.map((r) => r.permission.code);
      this.permissionCache.set(role, {
        codes,
        expiresAt: Date.now() + RbacService.PERMISSION_TTL_MS,
      });
      return codes;
    } catch {
      // Not cached: this is the "database is unhappy" path, and it should
      // recover as soon as the database does.
      return ROLE_PERMISSION_MAP[role] ?? [];
    }
  }

  async hasPermission(role: string, permission: string): Promise<boolean> {
    const perms = await this.getPermissionsForRole(role);
    if (role === 'ADMIN') return true;
    return perms.includes(permission);
  }
}
