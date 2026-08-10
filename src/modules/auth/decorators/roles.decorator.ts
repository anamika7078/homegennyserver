import { SetMetadata } from '@nestjs/common';

export enum UserRole {
  STAFF = 'STAFF',
  CLIENT = 'CLIENT',
  RM = 'RM',
  BM = 'BM',
  FINANCE = 'FINANCE',
  ADMIN = 'ADMIN',
  TRAINER = 'TRAINER',
  ASSESSOR = 'ASSESSOR',
  SUPPORT = 'SUPPORT',
  HR = 'HR',
}

/** Super Admin maps to ADMIN in JWT / DB */
export const SUPER_ADMIN_ROLE = UserRole.ADMIN;

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Marks an endpoint as "authenticated, but not role-restricted" — e.g. /auth/me,
 * /auth/logout, 2FA setup — anything a logged-in user manages about their own
 * account regardless of role. Distinct from @Public(): a valid JWT is still required.
 *
 * RolesGuard fails closed for any endpoint that has neither @Roles(...) nor this
 * decorator, so genuinely role-neutral endpoints must be marked explicitly.
 */
export const ROLE_NEUTRAL_KEY = 'roleNeutral';
export const AnyAuthenticatedRole = () => SetMetadata(ROLE_NEUTRAL_KEY, true);
