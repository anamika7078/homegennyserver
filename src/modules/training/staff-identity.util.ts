import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * A STAFF login's `users.id` (the JWT `sub`) is a different row from their
 * `staff_applicants.id` — the two are linked only by phone number. Anything
 * matching batch_enrollments / quiz_attempts needs the staff_applicants id.
 */
export async function resolveStaffApplicantId(prisma: PrismaService, userId: string, phone: string): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id FROM staff_applicants WHERE (id = $1::uuid OR mobile = $2) AND deleted_at IS NULL LIMIT 1`,
    userId, phone ?? '',
  );
  if (!rows.length) throw new NotFoundException('No staff_applicants record found for this account');
  return rows[0].id;
}
