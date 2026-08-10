import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';

const VALID_EVENTS = ['INVOKED', 'BM_REVIEWING', 'UPHELD', 'OVERTURNED'] as const;
type EventType = (typeof VALID_EVENTS)[number];

/**
 * Pillar 8 — Right to Refuse. Pure append-only event log (see the schema
 * comment on RightToRefuseLog) — a BM decision is always a new row
 * referencing the original invocation via refusalId, never an UPDATE. The
 * DB trigger (apply_security_triggers.js) makes UPDATE/DELETE fail even for
 * the app's own connection, matching the explicit Phase 2 append-only
 * requirement this pillar calls out.
 */
@Injectable()
export class RightToRefuseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async invoke(dto: { staffId: string; placementId?: string; reason: string }, actorId: string) {
    const staff = await this.prisma.staffApplicant.findUnique({ where: { id: dto.staffId } });
    if (!staff) throw new NotFoundException(`Staff ${dto.staffId} not found`);

    const refusalId = randomUUID();
    const event = await this.prisma.rightToRefuseLog.create({
      data: {
        refusalId,
        staffId: dto.staffId,
        placementId: dto.placementId,
        eventType: 'INVOKED',
        actorId,
        reason: dto.reason,
      },
    });
    await this.audit.log({
      actorId, action: AuditAction.DENIAL, entityType: 'right_to_refuse', entityId: refusalId,
      metadata: { event: 'RIGHT_TO_REFUSE_INVOKED', staffId: dto.staffId, reason: dto.reason },
    });
    return event;
  }

  private async latestEvent(refusalId: string) {
    const latest = await this.prisma.rightToRefuseLog.findFirst({
      where: { refusalId },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) throw new NotFoundException(`Right-to-refuse case ${refusalId} not found`);
    return latest;
  }

  async history(refusalId: string) {
    const rows = await this.prisma.rightToRefuseLog.findMany({ where: { refusalId }, orderBy: { createdAt: 'asc' } });
    if (!rows.length) throw new NotFoundException(`Right-to-refuse case ${refusalId} not found`);
    return { refusalId, currentStatus: rows[rows.length - 1].eventType, events: rows };
  }

  async listOpenCases() {
    // "Open" = every refusalId whose latest event isn't a terminal decision.
    const all = await this.prisma.rightToRefuseLog.findMany({ orderBy: { createdAt: 'asc' } });
    const latestByRefusal = new Map<string, (typeof all)[number]>();
    for (const row of all) latestByRefusal.set(row.refusalId, row);
    return Array.from(latestByRefusal.values()).filter(
      (row) => row.eventType !== 'UPHELD' && row.eventType !== 'OVERTURNED',
    );
  }

  private async appendEvent(refusalId: string, eventType: EventType, actorId: string, notes?: string) {
    const latest = await this.latestEvent(refusalId);
    const event = await this.prisma.rightToRefuseLog.create({
      data: {
        refusalId,
        staffId: latest.staffId,
        placementId: latest.placementId,
        eventType,
        actorId,
        notes,
      },
    });
    await this.audit.log({
      actorId, action: AuditAction.DENIAL, entityType: 'right_to_refuse', entityId: refusalId,
      metadata: { event: `RIGHT_TO_REFUSE_${eventType}`, notes },
    });
    return event;
  }

  async markReviewing(refusalId: string, actorId: string) {
    return this.appendEvent(refusalId, 'BM_REVIEWING', actorId);
  }

  async decide(refusalId: string, outcome: 'UPHELD' | 'OVERTURNED', actorId: string, notes?: string) {
    const latest = await this.latestEvent(refusalId);
    if (latest.eventType === 'UPHELD' || latest.eventType === 'OVERTURNED') {
      throw new BadRequestException(`This case is already decided (${latest.eventType})`);
    }
    return this.appendEvent(refusalId, outcome, actorId, notes);
  }
}
