import { Injectable, Logger } from '@nestjs/common';
import { PipelineStage, Prisma, TerminalOutcome, UserRole } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { StaffService } from '../staff/staff.service';
import { staffProfileMissing, OTHER_CITY } from '../staff/staff-profile.rules';
import { PipelineFsmService, PipelineStage as FsmStage } from '../pipeline/pipeline-fsm.service';
import { FinanceCustomerService } from '../finance/customer/customer.service';

export type NextStep = 'COMPLETE_PROFILE' | 'WAIT_FOR_RM' | 'VERIFICATION' | 'READY';

/**
 * Mobile login, then "complete your profile" — docs/REGISTRATION_ONBOARDING_PLAN.md.
 *
 * Staff: the profile IS S1. Submitting it moves them to S2 and gives them an
 * RM (branch from the city, the RM with the fewest staff there). Client: the
 * profile unlocks staff requests. Until then the app shows the home but every
 * action is refused (ProfileGateGuard).
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly staff: StaffService,
    private readonly fsm: PipelineFsmService,
    private readonly events: EventEmitter2,
  ) {}

  // ── Status ───────────────────────────────────────────────────────────────

  /**
   * What the app should show next. A staff member's profile is complete once
   * S1 is done (staff moved on by an RM-run intake count as complete too); a
   * client's once name, address, city and pincode are in.
   */
  async status(user: { id: string; role: string }) {
    if (user.role === UserRole.STAFF) {
      const s = await this.prisma.staffApplicant.findFirst({
        where: { userId: user.id, deletedAt: null },
        include: { assignedRm: { select: { fullName: true, phone: true } } },
      });
      if (!s) return { role: user.role, profile_complete: false, missing: [], next_step: 'COMPLETE_PROFILE' as NextStep, rm: null };
      const inS1 = s.pipelineStage === PipelineStage.S1_INTAKE;
      const next: NextStep = inS1
        ? 'COMPLETE_PROFILE'
        : !s.assignedRmId && s.pipelineStage !== PipelineStage.TERMINAL
          ? 'WAIT_FOR_RM'
          : ['S2_VERIFY', 'S2_5_ASSESS', 'S3_TRAIN', 'S4_AGREEMENTS', 'DEFERRED'].includes(s.pipelineStage)
            ? 'VERIFICATION'
            : 'READY';
      return {
        role: user.role,
        profile_complete: !inS1,
        missing: inS1 ? staffProfileMissing(s) : [],
        next_step: next,
        pipeline_stage: s.pipelineStage,
        rm: s.assignedRm ? { name: s.assignedRm.fullName, phone: s.assignedRm.phone } : null,
      };
    }
    if (user.role === UserRole.CLIENT) {
      const c = await this.prisma.financeCustomer.findFirst({
        where: { userId: user.id },
        select: { customerName: true, address: true, city: true, pincode: true, metadata: true },
      });
      const missing = c
        ? FinanceCustomerService.missingProfileFields({
            customer_name: c.customerName, address: c.address, city: c.city, pincode: c.pincode, metadata: c.metadata,
          })
        : ['name', 'address', 'city', 'pincode'];
      return {
        role: user.role,
        profile_complete: missing.length === 0,
        missing,
        next_step: (missing.length ? 'COMPLETE_PROFILE' : 'READY') as NextStep,
        rm: null,
      };
    }
    return { role: user.role, profile_complete: true, missing: [], next_step: 'READY' as NextStep, rm: null };
  }

  /** Cities for the profile dropdown — one per active branch, plus "Other". */
  async cities() {
    const cities = await this.staff.cities();
    return {
      cities: [
        ...cities.map((c) => ({ city: c.city, areas: c.areas })),
        { city: OTHER_CITY, areas: [] as string[] },
      ],
    };
  }

  // ── Staff ────────────────────────────────────────────────────────────────

  async staffProfile(userId: string) {
    const s = await this.staff.forUser(userId);
    const m = (s.metadata ?? {}) as Record<string, unknown>;
    const inS1 = s.pipelineStage === PipelineStage.S1_INTAKE;
    return {
      id: userId,
      staffApplicantId: s.id,
      staffCode: s.staffCode,
      fullName: s.fullName,
      mobile: s.mobile,
      email: s.email,
      series: s.series,
      pipelineStage: s.pipelineStage,
      address: s.address,
      dateOfBirth: s.dateOfBirth ? s.dateOfBirth.toISOString().slice(0, 10) : null,
      gender: (m.gender as string | undefined) ?? null,
      city: (m.city as string | undefined) ?? null,
      area: (m.area as string | undefined) ?? null,
      pincode: (m.pincode as string | undefined) ?? null,
      emergencyContactName: s.emergencyContactName,
      emergencyContactMobile: s.emergencyContactMobile,
      languages: Array.isArray(m.languages) ? m.languages : [],
      alternatePhone: (m.alternate_phone as string | undefined) ?? null,
      experienceYears: (m.experience_years as number | undefined) ?? null,
      /** Printed on the muster roll (Form XVI). Optional. */
      fatherOrHusbandName: (m.father_or_husband_name as string | undefined) ?? null,
      profile_complete: !inS1,
      missing: inS1 ? staffProfileMissing(s) : [],
      /** Name, DOB, gender and category can't be changed in the app once S2 has started. */
      locked_fields: inS1 ? [] : ['full_name', 'date_of_birth', 'gender', 'series'],
    };
  }

  async saveStaffProfile(userId: string, body: Record<string, unknown>) {
    const s = await this.staff.forUser(userId);
    await this.staff.saveProfile(s.id, body);
    return this.staffProfile(userId);
  }

  /**
   * "Submit" in the staff app: S1 done → S2, then an RM. A restricted-list
   * hit ends the case instead, the same as an RM-run intake.
   */
  async submitStaffProfile(userId: string, body: Record<string, unknown>) {
    const s = await this.staff.forUser(userId);
    const { staff, restricted } = await this.staff.completeIntake(s.id, body, userId);

    if (restricted.found) {
      await this.fsm.advanceStage({
        staffId: staff.id,
        toStage: 'TERMINAL' as FsmStage,
        actorId: userId,
        reasonCode: restricted.reason ?? 'RESTRICTED',
        terminalOutcome: 'DENIED' as TerminalOutcome,
      });
      await this.prisma.staffApplicant.update({ where: { id: staff.id }, data: { currentScenarioCode: 'RESTRICTED' } });
      this.events.emit('scenario.triggered', { staffId: staff.id, code: 'RESTRICTED', effect: { notify: 'BM' } });
      return { outcome: 'RESTRICTED', message: 'We could not complete your registration. Please contact HomeGenny.', ...(await this.status({ id: userId, role: 'STAFF' })) };
    }

    await this.fsm.advanceStage({
      staffId: staff.id,
      toStage: 'S2_VERIFY' as FsmStage,
      actorId: userId,
      reasonCode: 'SELF_COMPLETED',
      payload: { self_registered: true },
    });
    this.events.emit('realtime.broadcast', {
      channel: 'pipeline',
      event: 'pipeline.stage_changed',
      data: { staffId: staff.id, toStage: 'S2_VERIFY', fromStage: 'S1_INTAKE' },
    });
    const rm = staff.assignedRmId ? null : await this.autoAssignRm(staff.id, userId);
    return { outcome: 'ADVANCE_S2', assigned: rm, ...(await this.status({ id: userId, role: 'STAFF' })) };
  }

  /**
   * The branch comes from the staff's city (set by the profile); the RM there
   * with the fewest active staff gets them, ties to the one assigned least
   * recently. No branch, or no RM in it → left unassigned (RM web → Leads)
   * and the branch's BMs, or the Admins, are told.
   */
  async autoAssignRm(staffId: string, actorId: string): Promise<{ id: string; name: string } | null> {
    const s = await this.prisma.staffApplicant.findUnique({ where: { id: staffId } });
    if (!s || s.assignedRmId) return null;
    const name = s.fullName ?? s.mobile;
    const rms = s.branchId
      ? await this.prisma.user.findMany({
          where: { role: UserRole.RM, isActive: true, branchId: s.branchId },
          select: { id: true, fullName: true },
        })
      : [];

    if (!rms.length) {
      const bms = s.branchId
        ? await this.prisma.user.findMany({ where: { role: UserRole.BM, isActive: true, branchId: s.branchId }, select: { id: true } })
        : [];
      const to = bms.length
        ? bms
        : await this.prisma.user.findMany({ where: { role: UserRole.ADMIN, isActive: true }, select: { id: true } });
      const city = ((s.metadata ?? {}) as Record<string, unknown>).city ?? OTHER_CITY;
      await this.notify(
        to.map((u) => u.id),
        'New staff without an RM',
        `${name} (${s.mobile}) finished their profile in ${city} — no RM there to assign. Claim them under Leads.`,
        'STAFF_NEEDS_RM',
        { staff_id: staffId },
      );
      return null;
    }

    const ids = rms.map((r) => r.id);
    const [loads, last] = await Promise.all([
      this.prisma.staffApplicant.groupBy({
        by: ['assignedRmId'],
        where: { assignedRmId: { in: ids }, deletedAt: null, pipelineStage: { not: PipelineStage.TERMINAL } },
        _count: true,
      }),
      this.prisma.$queryRaw<{ rm: string; at: Date }[]>`
        SELECT payload->>'rm_id' AS rm, max(occurred_at) AS at FROM pipeline_events
         WHERE event_type = 'STAFF_AUTO_ASSIGNED' AND payload->>'rm_id' = ANY(${ids})
         GROUP BY 1`,
    ]);
    const load = new Map(loads.map((l) => [l.assignedRmId, l._count]));
    const lastAt = new Map(last.map((l) => [l.rm, l.at.getTime()]));
    const pick = [...rms].sort(
      (a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || (lastAt.get(a.id) ?? 0) - (lastAt.get(b.id) ?? 0),
    )[0];

    // Only if still unassigned: an RM may have claimed them a moment ago.
    const { count } = await this.prisma.staffApplicant.updateMany({
      where: { id: staffId, assignedRmId: null },
      data: { assignedRmId: pick.id },
    });
    if (!count) return null;
    await this.prisma.pipelineEvent.create({
      data: {
        staffId,
        eventType: 'STAFF_AUTO_ASSIGNED',
        fromStage: s.pipelineStage,
        toStage: s.pipelineStage,
        actorId,
        payload: { rm_id: pick.id, branch_id: s.branchId, load: load.get(pick.id) ?? 0 } as Prisma.InputJsonValue,
      },
    });
    await this.notify(
      [pick.id],
      'New staff assigned to you',
      `${name} (${s.mobile}) finished their profile and is ready for verification. Please call them.`,
      'STAFF_AUTO_ASSIGNED',
      { staff_id: staffId },
    );
    this.logger.log(`[ONBOARDING] staff ${staffId} → RM ${pick.id} (load ${load.get(pick.id) ?? 0})`);
    return { id: pick.id, name: pick.fullName };
  }

  private async notify(userIds: string[], title: string, body: string, template: string, payload: Record<string, unknown>) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    await this.prisma.notification
      .createMany({
        data: ids.map((userId) => ({
          userId,
          title,
          body,
          template,
          payload: payload as Prisma.InputJsonValue,
          channel: 'IN_APP' as const,
          status: 'SENT',
          sentAt: new Date(),
        })),
      })
      .catch((e) => this.logger.warn(`notify ${template} failed: ${e.message}`));
  }
}
