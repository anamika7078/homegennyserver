import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PipelineStage } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FinanceCustomerService } from '../finance/customer/customer.service';
import { staffProfileMissing } from '../staff/staff-profile.rules';

/**
 * Until a CLIENT or STAFF login has finished its profile, it can read but not
 * act — docs/REGISTRATION_ONBOARDING_PLAN.md §A7. Every GET goes through (the
 * app's home still renders); every write is refused with 403
 * PROFILE_INCOMPLETE, except the ones needed to finish the profile or to stay
 * signed in. Registered after JwtAuthGuard/RolesGuard, so `req.user` is set;
 * a new endpoint is gated without anyone having to remember to.
 *
 * Staff: complete once out of S1. Client: complete once the self-registered
 * profile has name, address, city and pincode (customers made by Finance or
 * an RM are never held).
 */
const ALLOWED_WRITES: RegExp[] = [
  /^\/auth\//,
  /^\/user\//,
  /^\/me\//,
  /^\/staff\/profile(\/submit)?$/,
  /^\/client\/profile$/,
  /^\/notifications\//,
  /^\/client\/notifications/,
];

@Injectable()
export class ProfileGateGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<{ method: string; originalUrl?: string; url: string; user?: { id: string; role: string } }>();
    const user = req.user;
    if (!user || (user.role !== 'STAFF' && user.role !== 'CLIENT')) return true;
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) return true;

    const path = (req.originalUrl ?? req.url).split('?')[0].replace(/^\/api(\/v\d+)?/, '');
    if (ALLOWED_WRITES.some((r) => r.test(path))) return true;

    let missing: string[] = [];
    if (user.role === 'STAFF') {
      const s = await this.prisma.staffApplicant.findFirst({ where: { userId: user.id, deletedAt: null } });
      if (s && s.pipelineStage === PipelineStage.S1_INTAKE) missing = staffProfileMissing(s);
      if (s && s.pipelineStage === PipelineStage.S1_INTAKE && !missing.length) missing = ['submit'];
    } else {
      const c = await this.prisma.financeCustomer.findFirst({
        where: { userId: user.id },
        select: { customerName: true, address: true, city: true, pincode: true, metadata: true },
      });
      if (c) {
        missing = FinanceCustomerService.missingProfileFields({
          customer_name: c.customerName, address: c.address, city: c.city, pincode: c.pincode, metadata: c.metadata,
        });
      }
    }
    if (!missing.length) return true;
    throw new ForbiddenException({
      statusCode: 403,
      error: 'PROFILE_INCOMPLETE',
      message:
        missing[0] === 'submit'
          ? 'Submit your profile first (Profile → Submit).'
          : `Complete your profile first — ${missing.join(', ')} missing.`,
      missing,
    });
  }
}
