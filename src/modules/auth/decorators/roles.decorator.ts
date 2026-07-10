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
