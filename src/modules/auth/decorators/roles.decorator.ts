import { SetMetadata } from '@nestjs/common';

export enum UserRole {
  STAFF = 'STAFF',
  CLIENT = 'CLIENT',
  RM = 'RM',
  BM = 'BM',
  FINANCE = 'FINANCE',
  ADMIN = 'ADMIN',
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
