import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Resolves a CLIENT-role JWT to their own FinanceCustomer row.
 *
 * FinanceCustomer.userId is the FK every real CLIENT login is actually
 * linked to (via UserProvisioningService.linkClientAccount / registerCustomer
 * — see finance/admin onboarding flows). Placement.clientId, Invoice.clientId,
 * and ScopeOfWork/ClientIndemnity.clientId are all written using this same
 * FinanceCustomer id space.
 *
 * Previously this resolved against ClientProfile (matched by phone) — but
 * ClientProfile has no user_id column at all and is a *different* table with
 * no relation to FinanceCustomer, so no real CLIENT login ever had a matching
 * ClientProfile row. That made every caller of this function (SOW acknowledge,
 * Indemnity acknowledge/contest, client-filed Incidents) unreachable for any
 * real client — confirmed live against the dev DB before this fix.
 */
export async function resolveFinanceCustomer(prisma: PrismaService, userId: string) {
  const client = await prisma.financeCustomer.findFirst({ where: { userId } });
  if (!client) {
    throw new ForbiddenException('No customer account is linked to this login yet — contact Finance/Admin.');
  }
  return client;
}

/** Throws if the resolved client doesn't own the given placement/record's clientId. */
export function assertClientOwns(clientId: string, resourceClientId: string | null | undefined): void {
  if (!resourceClientId || resourceClientId !== clientId) {
    throw new ForbiddenException('You do not have access to this record');
  }
}
