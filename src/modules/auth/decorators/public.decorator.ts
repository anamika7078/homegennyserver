import { SetMetadata } from '@nestjs/common';

/** Matches the literal 'isPublic' key JwtAuthGuard already reads via Reflector. */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks an endpoint as reachable with no JWT at all (login, register, refresh, health).
 * Skips both JwtAuthGuard and RolesGuard.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
