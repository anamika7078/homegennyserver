import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';

/**
 * Pillar 7 — Client Indemnity. Each clause version is its own row, never
 * edited after creation — a new clause version means a new row, so historical
 * acknowledgements are never rewritten (spec: "Do not overwrite historical
 * acknowledgements").
 */
@Injectable()
export class IndemnityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async send(dto: { placementId: string; clauseVersion: string; clauseText: string }, actorId: string) {
    const placement = await this.prisma.placement.findUnique({ where: { id: dto.placementId } });
    if (!placement) throw new NotFoundException(`Placement ${dto.placementId} not found`);

    const indemnity = await this.prisma.clientIndemnity.create({
      data: {
        placementId: placement.id,
        clientId: placement.clientId,
        clauseVersion: dto.clauseVersion,
        clauseText: dto.clauseText,
        sentBy: actorId,
      },
    });
    await this.audit.log({
      actorId, action: AuditAction.AGREEMENT_SIGN, entityType: 'client_indemnity', entityId: indemnity.id,
      metadata: { event: 'INDEMNITY_SENT', placementId: placement.id, clauseVersion: dto.clauseVersion },
    });
    return indemnity;
  }

  async findOne(id: string) {
    const row = await this.prisma.clientIndemnity.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Indemnity ${id} not found`);
    return row;
  }

  async findForPlacement(placementId: string) {
    return this.prisma.clientIndemnity.findMany({ where: { placementId }, orderBy: { sentAt: 'desc' } });
  }

  async acknowledge(id: string, actorUserId: string) {
    const row = await this.findOne(id);
    if (row.acknowledgedAt) throw new BadRequestException('Already acknowledged');
    if (row.contested) throw new BadRequestException('This clause is contested — it must go through BM review before it can be acknowledged');
    const updated = await this.prisma.clientIndemnity.update({
      where: { id },
      data: { acknowledgedBy: actorUserId, acknowledgedAt: new Date() },
    });
    await this.audit.log({
      actorId: actorUserId, action: AuditAction.AGREEMENT_SIGN, entityType: 'client_indemnity', entityId: id,
      metadata: { event: 'INDEMNITY_ACKNOWLEDGED' },
    });
    return updated;
  }

  /** Client disputes the clause instead of acknowledging it — routes to BM. */
  async contest(id: string, actorUserId: string, reason?: string) {
    const row = await this.findOne(id);
    if (row.acknowledgedAt) throw new BadRequestException('Already acknowledged — cannot contest');
    const updated = await this.prisma.clientIndemnity.update({
      where: { id },
      data: { contested: true },
    });
    await this.audit.log({
      actorId: actorUserId, action: AuditAction.DENIAL, entityType: 'client_indemnity', entityId: id,
      metadata: { event: 'INDEMNITY_CONTESTED', reason },
    });
    return updated;
  }

  async bmReview(id: string, actorId: string, notes: string) {
    const row = await this.findOne(id);
    if (!row.contested) throw new BadRequestException('This indemnity clause is not marked contested');
    const updated = await this.prisma.clientIndemnity.update({
      where: { id },
      data: { bmReviewedBy: actorId, bmReviewNotes: notes, bmReviewedAt: new Date() },
    });
    await this.audit.log({
      actorId, action: AuditAction.APPROVAL, entityType: 'client_indemnity', entityId: id,
      metadata: { event: 'INDEMNITY_BM_REVIEWED', notes },
    });
    return updated;
  }
}
