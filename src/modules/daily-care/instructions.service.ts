import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClientInstruction, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/guards/branch-scope.util';
import { RightToRefuseService } from '../right-to-refuse/right-to-refuse.service';
import { CareAccessService, istNow } from './care-access.service';
import { CareFilesService } from './care-files.service';

/**
 * Phase E — the client tells their staff what to do, in text or a voice note.
 *
 *   SENT → ACKNOWLEDGED ("samjha") → DONE ("ho gaya")
 *        ↘ REFUSED ("ye mera kaam nahi") → RM decides:
 *              UPHELD     — the staff was right; it stays refused
 *              OVERTURNED — it is part of the job; back to ACKNOWLEDGED
 *   SENT/ACKNOWLEDGED → CANCELLED (client)
 *
 * A refusal is a real Right-to-Refuse case (Pillar 8), so it shows up wherever
 * those are reviewed, and the RM sees the placement's scope of work next to it.
 * RECURRING instructions are standing orders: acknowledged, never "done".
 */
@Injectable()
export class InstructionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CareAccessService,
    private readonly files: CareFilesService,
    private readonly refusals: RightToRefuseService,
  ) {}

  dto(i: ClientInstruction) {
    return {
      id: i.id,
      placement_id: i.placementId,
      kind: i.kind,
      text: i.text,
      voice_file_id: i.voiceFileId,
      voice_url: i.voiceFileId ? `/api/v1/care-files/${i.voiceFileId}` : null,
      due_at: i.dueAt,
      recurrence: i.recurrence,
      status: i.status,
      staff_note: i.staffNote,
      acknowledged_at: i.acknowledgedAt,
      done_at: i.doneAt,
      refused_at: i.refusedAt,
      refusal_id: i.refusalId,
      rm_decision: i.rmDecision,
      rm_note: i.rmNote,
      decided_at: i.decidedAt,
      created_at: i.createdAt,
    };
  }

  async create(user: AuthUser, placementId: string, body: Record<string, unknown>) {
    const ctx = await this.access.resolve(user, placementId, { write: true });
    if (ctx.role !== 'CLIENT') throw new BadRequestException('Only the client gives instructions to their staff.');
    const text = String(body.text ?? '').trim();
    const [voice] = body.voice_file_id ? await this.files.assertOwned(placementId, body.voice_file_id, 'VOICE') : [undefined];
    if (!text && !voice) throw new BadRequestException('Write the instruction or attach a voice note (voice_file_id).');
    const kind = String(body.kind ?? 'ONE_TIME').toUpperCase();
    if (!['ONE_TIME', 'RECURRING'].includes(kind)) throw new BadRequestException('kind must be ONE_TIME or RECURRING.');
    let dueAt: Date | null = null;
    if (body.due_at) {
      dueAt = new Date(String(body.due_at));
      if (Number.isNaN(dueAt.getTime())) throw new BadRequestException('due_at must be a date-time (ISO 8601).');
    }
    let recurrence: Record<string, unknown> | null = null;
    if (kind === 'RECURRING') {
      const r = (body.recurrence ?? {}) as Record<string, unknown>;
      const times = (Array.isArray(r.times) ? r.times : []).map(String).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
      const days = (Array.isArray(r.days) ? r.days : []).map((d) => String(d).toUpperCase()).filter((d) => ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].includes(d));
      recurrence = { times, days: days.length ? days : ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] };
    }
    const row = await this.prisma.clientInstruction.create({
      data: {
        placementId,
        clientId: ctx.client.id,
        staffId: ctx.staff.id,
        kind,
        text: text || null,
        voiceFileId: voice ?? null,
        dueAt,
        recurrence: recurrence as Prisma.InputJsonValue,
        createdBy: user.id,
      },
    });
    await this.access.notify(
      [ctx.staff.userId],
      voice && !text ? 'Voice instruction from the family' : 'New instruction from the family',
      text ? text.slice(0, 140) : 'Tap to listen.',
      'INSTRUCTION_NEW',
      { placement_id: placementId, instruction_id: row.id },
    );
    return this.dto(row);
  }

  async list(user: AuthUser, placementId: string, status?: string) {
    await this.access.resolve(user, placementId);
    const rows = await this.prisma.clientInstruction.findMany({
      where: { placementId, ...(status ? { status: { in: status.split(',').map((x) => x.trim().toUpperCase()) } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { placement_id: placementId, items: rows.map((r) => this.dto(r)) };
  }

  async cancel(user: AuthUser, id: string) {
    const ins = await this.load(id);
    const ctx = await this.access.resolve(user, ins.placementId);
    if (ctx.role !== 'CLIENT') throw new BadRequestException('Only the client cancels an instruction.');
    if (!['SENT', 'ACKNOWLEDGED'].includes(ins.status)) throw new BadRequestException(`This instruction is ${ins.status}.`);
    const row = await this.prisma.clientInstruction.update({ where: { id }, data: { status: 'CANCELLED', updatedAt: new Date() } });
    await this.access.notify([ctx.staff.userId], 'Instruction withdrawn', (ins.text ?? 'Voice note').slice(0, 140), 'INSTRUCTION_CANCELLED', { placement_id: ins.placementId, instruction_id: id });
    return this.dto(row);
  }

  private async load(id: string) {
    const ins = await this.prisma.clientInstruction.findUnique({ where: { id } });
    if (!ins) throw new NotFoundException('Instruction not found.');
    return ins;
  }

  /** Staff: everything sent to them on their active placements. */
  async listForStaff(user: AuthUser, status?: string) {
    const staff = await this.access.staffForUser(user.id);
    const placements = await this.access.activePlacementsForStaff(staff.id);
    const rows = await this.prisma.clientInstruction.findMany({
      where: {
        staffId: staff.id,
        placementId: { in: placements.map((p) => p.placement.id) },
        ...(status ? { status: { in: status.split(',').map((x) => x.trim().toUpperCase()) } } : { status: { not: 'CANCELLED' } }),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const names = new Map(placements.map((p) => [p.placement.id, p.client?.customerName ?? null]));
    return { items: rows.map((r) => ({ ...this.dto(r), client_name: names.get(r.placementId) ?? null })) };
  }

  private async forStaff(user: AuthUser, id: string) {
    const ins = await this.load(id);
    const ctx = await this.access.resolve(user, ins.placementId, { write: true });
    if (ctx.role !== 'STAFF') throw new BadRequestException('Only the staff member answers an instruction.');
    return { ins, ctx };
  }

  async acknowledge(user: AuthUser, id: string) {
    const { ins, ctx } = await this.forStaff(user, id);
    if (ins.status !== 'SENT') throw new BadRequestException(`This instruction is ${ins.status}.`);
    const row = await this.prisma.clientInstruction.update({ where: { id }, data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), updatedAt: new Date() } });
    await this.access.notify([ctx.client.userId], `${ctx.staff.fullName.split(' ')[0]} read your instruction`, (ins.text ?? 'Voice note').slice(0, 140), 'INSTRUCTION_ACKNOWLEDGED', { placement_id: ins.placementId, instruction_id: id });
    return this.dto(row);
  }

  async done(user: AuthUser, id: string, body: Record<string, unknown>) {
    const { ins, ctx } = await this.forStaff(user, id);
    if (ins.kind === 'RECURRING') throw new BadRequestException('A recurring instruction is a standing order — acknowledge it, it is never "done".');
    if (!['SENT', 'ACKNOWLEDGED'].includes(ins.status)) throw new BadRequestException(`This instruction is ${ins.status}.`);
    const row = await this.prisma.clientInstruction.update({
      where: { id },
      data: { status: 'DONE', acknowledgedAt: ins.acknowledgedAt ?? new Date(), doneAt: new Date(), staffNote: String(body.note ?? '').trim() || ins.staffNote, updatedAt: new Date() },
    });
    await this.access.notify([ctx.client.userId], 'Done ✓', (ins.text ?? 'Voice note').slice(0, 140), 'INSTRUCTION_DONE', { placement_id: ins.placementId, instruction_id: id });
    return this.dto(row);
  }

  /** "Ye mera kaam nahi" — opens a Right-to-Refuse case and puts it in front of the RM. */
  async refuse(user: AuthUser, id: string, body: Record<string, unknown>) {
    const { ins, ctx } = await this.forStaff(user, id);
    if (!['SENT', 'ACKNOWLEDGED'].includes(ins.status)) throw new BadRequestException(`This instruction is ${ins.status}.`);
    if (ins.rmDecision === 'OVERTURNED') throw new BadRequestException('Your RM already decided this is part of the job.');
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Say why it is not part of your work — your RM will look at it.');
    const event = await this.refusals.invoke(
      { staffId: ctx.staff.id, placementId: ins.placementId, reason: `Instruction: "${(ins.text ?? 'voice note').slice(0, 200)}" — ${reason}` },
      user.id,
    );
    const row = await this.prisma.clientInstruction.update({
      where: { id },
      data: { status: 'REFUSED', refusedAt: new Date(), refusalId: event.refusalId, staffNote: reason, updatedAt: new Date() },
    });
    await this.access.notify(
      [await this.access.rmOf(ctx), ctx.client.userId],
      'Instruction refused — RM to decide',
      `${ctx.staff.fullName} at ${ctx.client.customerName}: "${reason}"`,
      'INSTRUCTION_REFUSED',
      { placement_id: ins.placementId, instruction_id: id },
    );
    return this.dto(row);
  }

  /** RM: refused instructions waiting for a decision, with the scope of work beside each. */
  async refusedQueue(user: AuthUser) {
    const where: Prisma.ClientInstructionWhereInput = { status: 'REFUSED', rmDecision: null };
    if (user.role === 'RM') where.placement = { OR: [{ rmId: user.id }] };
    if (user.role === 'BM' && user.branchId) where.placement = { branchId: user.branchId };
    const rows = await this.prisma.clientInstruction.findMany({ where, orderBy: { refusedAt: 'asc' }, take: 100 });
    const out: Record<string, unknown>[] = [];
    for (const r of rows) {
      const ctx = await this.access.resolve({ id: '', role: 'ADMIN' }, r.placementId);
      const sow = await this.prisma.scopeOfWork.findFirst({
        where: { placementId: r.placementId, status: { in: ['SENT', 'ACKNOWLEDGED'] } },
        orderBy: { version: 'desc' },
        select: { content: true, version: true, status: true },
      });
      out.push({ ...this.dto(r), staff_name: ctx.staff.fullName, client_name: ctx.client.customerName, scope_of_work: sow });
    }
    return { items: out };
  }

  async decide(user: AuthUser, id: string, body: Record<string, unknown>) {
    const ins = await this.load(id);
    const ctx = await this.access.resolve(user, ins.placementId);
    if (!['RM', 'BM', 'ADMIN'].includes(ctx.role)) throw new ForbiddenException('Only the RM decides a refusal.');
    if (ins.status !== 'REFUSED' || ins.rmDecision) throw new BadRequestException('There is no open refusal on this instruction.');
    const decision = String(body.decision ?? '').toUpperCase();
    if (!['UPHELD', 'OVERTURNED'].includes(decision)) throw new BadRequestException('decision must be UPHELD (staff was right) or OVERTURNED (it is part of the job).');
    const note = String(body.note ?? '').trim();
    if (!note) throw new BadRequestException('note is required — both the client and the staff see it.');
    if (ins.refusalId) await this.refusals.decide(ins.refusalId, decision as 'UPHELD' | 'OVERTURNED', user.id, note);
    const row = await this.prisma.clientInstruction.update({
      where: { id },
      data: {
        rmDecision: decision,
        rmNote: note,
        decidedAt: new Date(),
        decidedBy: user.id,
        status: decision === 'OVERTURNED' ? 'ACKNOWLEDGED' : 'REFUSED',
        updatedAt: new Date(),
      },
    });
    await this.access.notify(
      [ctx.staff.userId, ctx.client.userId],
      decision === 'UPHELD' ? 'RM: this is outside the job' : 'RM: this is part of the job',
      note,
      'INSTRUCTION_DECIDED',
      { placement_id: ins.placementId, instruction_id: id, decision },
    );
    return this.dto(row);
  }

  /** Recurring orders due today, for the staff home screen. */
  todaysStanding(rows: ClientInstruction[]) {
    const dow = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][new Date(`${istNow().date}T00:00:00Z`).getUTCDay()];
    return rows.filter((r) => r.kind === 'RECURRING' && ['SENT', 'ACKNOWLEDGED'].includes(r.status) && ((r.recurrence as { days?: string[] })?.days ?? []).includes(dow));
  }
}
