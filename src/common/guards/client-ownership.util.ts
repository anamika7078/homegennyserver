import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Resolves a CLIENT-role JWT to their own ClientProfile row.
 *
 * ClientProfile has no user_id column linking it back to `users` — the same
 * situation StaffApplicant was in for Phase 1's video-cert ownership check,
 * resolved the same way here: match on phone (both tables have a unique
 * phone column). RM-created ClientProfile rows and self-registered CLIENT
 * `users` rows share the same phone number for the same real person, so this
 * is a reliable, no-schema-change link — not a coincidental match.
 */
export async function resolveClientProfile(prisma: PrismaService, phone: string) {
  const client = await prisma.clientProfile.findFirst({ where: { phone } });
  if (!client) {
    throw new ForbiddenException('No client profile is linked to this account yet — contact your RM.');
  }
  return client;
}

/** Throws if the resolved client doesn't own the given placement/record's clientId. */
export function assertClientOwns(clientId: string, resourceClientId: string | null | undefined): void {
  if (!resourceClientId || resourceClientId !== clientId) {
    throw new ForbiddenException('You do not have access to this record');
  }
}
