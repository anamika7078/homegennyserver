import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, ROLE_NEUTRAL_KEY, UserRole } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Fail-closed authorization.
 *
 * An endpoint is only reachable if it is explicitly one of:
 *   - @Public()              — no auth at all (login, register, refresh, health)
 *   - @AnyAuthenticatedRole() — any logged-in user (own-account self-service)
 *   - @Roles(...)             — only the listed roles
 *
 * Anything with none of the three is denied by default. This replaces the previous
 * "if (!requiredRoles) return true" fail-open behavior that left every controller
 * without an explicit @Roles() open to any authenticated role.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const { user } = context.switchToHttp().getRequest();

    if (requiredRoles && requiredRoles.length > 0) {
      if (!user) throw new ForbiddenException('Authentication required');
      if (!requiredRoles.some((role) => user.role === role)) {
        throw new ForbiddenException(
          `Role '${user.role}' is not permitted to access this resource`,
        );
      }
      return true;
    }

    const isRoleNeutral = this.reflector.getAllAndOverride<boolean>(ROLE_NEUTRAL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isRoleNeutral) {
      if (!user) throw new ForbiddenException('Authentication required');
      return true;
    }

    // Fail closed: no @Roles, not @Public, not @AnyAuthenticatedRole.
    const req = context.switchToHttp().getRequest();
    this.logger.warn(
      `[AUTHZ] Denied — no authorization policy declared for ${req.method} ${req.url}. ` +
        'Add @Roles(...), @AnyAuthenticatedRole(), or @Public() to this handler.',
    );
    throw new ForbiddenException('This endpoint has no authorization policy defined');
  }
}
