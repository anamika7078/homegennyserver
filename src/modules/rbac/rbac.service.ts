import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PERMISSIONS, ROLE_PERMISSION_MAP } from './permissions.constants';
import { UserRole } from '../auth/decorators/roles.decorator';

@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

  async seedPermissions(): Promise<void> {
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

  async getPermissionsForRole(role: string): Promise<string[]> {
    try {
      const rows = await this.prisma.rolePermission.findMany({
        where: { role: role as UserRole },
        include: { permission: true },
      });
      return rows.map((r) => r.permission.code);
    } catch {
      return ROLE_PERMISSION_MAP[role] ?? [];
    }
  }

  async hasPermission(role: string, permission: string): Promise<boolean> {
    const perms = await this.getPermissionsForRole(role);
    if (role === 'ADMIN') return true;
    return perms.includes(permission);
  }
}
