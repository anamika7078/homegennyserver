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

  async fileByClient(
    dto: { staffId: string; type: IncidentType; title: string; description?: string; evidenceUrls?: string[] },
    clientId: string,
    actorUserId: string,
  ) {
    await this.assertClientDeployedStaff(clientId, dto.staffId);
    const placement = await this.prisma.placement.findFirst({ where: { clientId, staffId: dto.staffId } });

    const incident = await this.prisma.incident.create({
      data: {
        staffId: dto.staffId,
        clientId,
        placementId: placement?.id,
        branchId: placement?.branchId,
        rmId: placement?.rmId,
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
    const incident = await this.prisma.incident.findUnique({ where: { id }, include: { comments: { orderBy: { createdAt: 'asc' } } } });
    if (!incident) throw new NotFoundException(`Incident ${id} not found`);
    return incident;
  }

  async listForClient(clientId: string) {
    return this.prisma.incident.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' } });
  }

  async listForRm(rmId: string) {
    return this.prisma.incident.findMany({ where: { rmId }, orderBy: { createdAt: 'desc' } });
  }

  async listEscalated() {
    return this.prisma.incident.findMany({ where: { status: 'ESCALATED' }, orderBy: { createdAt: 'desc' } });
  }

  async listAll() {
    return this.prisma.incident.findMany({ orderBy: { createdAt: 'desc' } });
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

  resolve(id: string, actorId: string, resolution: string) {
    return this.transition(id, ['OPEN', 'INVESTIGATING', 'ESCALATED'], 'RESOLVED', actorId, { resolution, resolvedAt: new Date() });
  }

  escalate(id: string, actorId: string) {
    return this.transition(id, ['OPEN', 'INVESTIGATING'], 'ESCALATED', actorId);
  }

  close(id: string, actorId: string) {
    return this.transition(id, ['RESOLVED'], 'CLOSED', actorId);
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
