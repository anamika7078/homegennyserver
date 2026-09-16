import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, IncidentType } from '@prisma/client';

/**
 * Pillar 9 — Incident Trail. The DB model (Incident/IncidentComment) already
 * existed in the schema with no controller/service ever built on it — this
 * is that missing layer, not a schema change.
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Client can only file against staff actually (or previously) placed with them. */
  async assertClientDeployedStaff(clientId: string, staffId: string): Promise<void> {
    const placement = await this.prisma.placement.findFirst({ where: { clientId, staffId } });
    if (!placement) {
      throw new ForbiddenException('You may only file an incident against staff deployed to your own placement');
    }
  }

  /**
   * Which RM owns this incident — i.e. whose inbox it has to land in.
   *
   * Placement.rmId is the natural answer but it is very often NULL (every
   * placement in the dev database has it unset), and listForRm()/GET
   * /rm/incidents filter on Incident.rmId. So a client complaint was written
   * with rmId = null and then belonged to nobody: the client got a ticket
   * number, the row existed, and no RM inbox ever showed it. Confirmed live
   * before this fix — the assigned RM's inbox did not contain the row.
   *
   * StaffApplicant.assignedRmId is the fallback, and is the field that is
   * actually populated (7/7 staff in the same database), because it is set at
   * intake and carried through the whole pipeline.
   */
  private async resolveOwningRm(staffId: string | null | undefined, placementRmId?: string | null): Promise<string | null> {
    if (placementRmId) return placementRmId;
    if (!staffId) return null;
    const staff = await this.prisma.staffApplicant.findUnique({
      where: { id: staffId },
      select: { assignedRmId: true },
    });
    return staff?.assignedRmId ?? null;
  }

  async fileByClient(
    dto: { staffId: string; type: IncidentType; title: string; description?: string; evidenceUrls?: string[] },
    clientId: string,
    actorUserId: string,
  ) {
    await this.assertClientDeployedStaff(clientId, dto.staffId);
    // Prefer a live placement over a closed one — a client with both an ended
    // and a current engagement should have the complaint attached to the
    // current one.
    const placement =
      (await this.prisma.placement.findFirst({
        where: { clientId, staffId: dto.staffId, status: { in: ['TRIAL', 'CONFIRMED'] } },
        orderBy: { createdAt: 'desc' },
      })) ??
      (await this.prisma.placement.findFirst({
        where: { clientId, staffId: dto.staffId },
        orderBy: { createdAt: 'desc' },
      }));

    const incident = await this.prisma.incident.create({
      data: {
        staffId: dto.staffId,
        clientId,
        placementId: placement?.id,
        branchId: placement?.branchId,
        rmId: await this.resolveOwningRm(dto.staffId, placement?.rmId),
        type: dto.type,
        title: dto.title,
        description: dto.description,
        evidenceUrls: dto.evidenceUrls ?? [],
        status: 'OPEN',
      },
    });
    await this.audit.log({
      actorId: actorUserId, action: AuditAction.STAGE_TRANSITION, entityType: 'incident', entityId: incident.id,
      metadata: { event: 'INCIDENT_FILED', clientId, staffId: dto.staffId, type: dto.type },
    });
    return incident;
  }

  async findOne(id: string) {
    const incident = await this.prisma.incident.findUnique({
      where: { id },
      include: {
        comments: { orderBy: { createdAt: 'asc' } },
        staff: { select: { id: true, staffCode: true, fullName: true, series: true, pipelineStage: true } },
      },
    });
    if (!incident) throw new NotFoundException(`Incident ${id} not found`);
    return incident;
  }

  /**
   * Every list returns the same shape, including the staff member's name/code
   * and a comment count — a list row that shows only a title and a status is
   * not enough for anyone to triage from, and the clients were each having to
   * make a second request per row to get it.
   */
  private readonly listShape = {
    orderBy: { createdAt: 'desc' } as const,
    include: {
      staff: { select: { id: true, staffCode: true, fullName: true, series: true } },
      _count: { select: { comments: true } },
    },
  };

  async listForClient(clientId: string) {
    return this.prisma.incident.findMany({ where: { clientId }, ...this.listShape });
  }

  async listForRm(rmId: string, status?: string) {
    return this.prisma.incident.findMany({
      where: { rmId, ...(status ? { status: status as never } : {}) },
      ...this.listShape,
    });
  }

  /**
   * BM's queue is everything a BM can actually act on: ESCALATED (they handle
   * escalations) and RESOLVED (they are the only role that can close one).
   *
   * This used to return ESCALATED only, which made `close` unreachable in
   * practice — the one role allowed to close a RESOLVED incident could not see
   * a single RESOLVED incident in its own list.
   */
  async listForBm(status?: string) {
    return this.prisma.incident.findMany({
      where: status ? { status: status as never } : { status: { in: ['ESCALATED', 'RESOLVED'] } },
      ...this.listShape,
    });
  }

  async listAll(status?: string) {
    return this.prisma.incident.findMany({
      where: status ? { status: status as never } : {},
      ...this.listShape,
    });
  }

  async addComment(incidentId: string, actorId: string, body: string) {
    await this.findOne(incidentId);
    const comment = await this.prisma.incidentComment.create({
      data: { incidentId, actorId, body },
    });
    await this.audit.log({
      actorId, action: AuditAction.STAGE_TRANSITION, entityType: 'incident', entityId: incidentId,
      metadata: { event: 'INCIDENT_COMMENT' },
    });
    return comment;
  }

  private async transition(id: string, from: string[], to: string, actorId: string, extra?: Record<string, unknown>) {
    const incident = await this.findOne(id);
    if (!from.includes(incident.status)) {
      throw new BadRequestException(`Cannot move incident from ${incident.status} to ${to} (allowed from: ${from.join(', ')})`);
    }
    const updated = await this.prisma.incident.update({
      where: { id },
      data: { status: to as never, ...extra },
    });
    await this.audit.log({
      actorId, action: AuditAction.STAGE_TRANSITION, entityType: 'incident', entityId: id,
      metadata: { event: `INCIDENT_${to}`, from: incident.status },
    });
    return updated;
  }

  acknowledge(id: string, actorId: string) {
    return this.transition(id, ['OPEN'], 'INVESTIGATING', actorId);
  }

  async resolve(id: string, actorId: string, resolution: string) {
    if (!resolution || !String(resolution).trim()) {
      // A resolved incident with no resolution text is the same problem as a
      // silent 200: it reads as handled and records nothing about how.
      throw new BadRequestException('A resolution note is required to resolve an incident.');
    }
    const updated = await this.transition(
      id, ['OPEN', 'INVESTIGATING', 'ESCALATED'], 'RESOLVED', actorId,
      { resolution, resolvedAt: new Date() },
    );
    await this.closeEscalationLogs(id);
    return updated;
  }

  /**
   * Escalating flipped Incident.status and nothing else — but the BM dashboard
   * and the 24-hour follow-up cron both read `escalation_logs`, which only the
   * scenario engine ever wrote to. So an escalated complaint showed up in no BM
   * KPI and generated no reminder; it just sat in the list. The log row is
   * written here so escalation means the same thing whichever way it was
   * raised, and resolving/closing takes it back out of the open queue.
   */
  async escalate(id: string, actorId: string) {
    const updated = await this.transition(id, ['OPEN', 'INVESTIGATING'], 'ESCALATED', actorId);
    await this.prisma.escalationLog.create({
      data: {
        staffId: updated.staffId,
        clientId: updated.clientId,
        severity: updated.legalHold ? 'CRITICAL' : 'HIGH',
        title: `Incident escalated: ${updated.title}`,
        description: updated.description ?? `Incident ${updated.type} escalated to BM`,
        status: 'OPEN',
        assignedTo: updated.rmId,
        metadata: { incident_id: updated.id, incident_type: updated.type, escalated_by: actorId },
      },
    }).catch(() => undefined);
    return updated;
  }

  /** Close out any open escalation_logs row raised from this incident. */
  private async closeEscalationLogs(incidentId: string) {
    await this.prisma.escalationLog.updateMany({
      where: { status: 'OPEN', metadata: { path: ['incident_id'], equals: incidentId } },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    }).catch(() => undefined);
  }

  async close(id: string, actorId: string) {
    const updated = await this.transition(id, ['RESOLVED'], 'CLOSED', actorId);
    await this.closeEscalationLogs(id);
    return updated;
  }

  async setLegalHold(id: string, actorId: string, hold: boolean) {
    await this.findOne(id);
    const updated = await this.prisma.incident.update({ where: { id }, data: { legalHold: hold } });
    await this.audit.log({
      actorId, action: AuditAction.SETTINGS_CHANGE, entityType: 'incident', entityId: id,
      metadata: { event: 'INCIDENT_LEGAL_HOLD', hold },
    });
    return updated;
  }
}
