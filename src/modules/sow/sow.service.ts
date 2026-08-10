import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';

/**
 * Pillar 6 — Scope of Work.
 *
 * RM creates -> (optionally amends while DRAFT) -> sends -> Client
 * acknowledges. Once ACKNOWLEDGED, content is immutable on that row — any
 * further change goes through amend(), which creates a new version row
 * linked via supersedesId rather than editing the acknowledged one, so the
 * acknowledgement history is never rewritten.
 */
@Injectable()
export class SowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: { placementId: string; content: string; isNonStandard?: boolean }, actorId: string) {
    const placement = await this.prisma.placement.findUnique({ where: { id: dto.placementId } });
    if (!placement) throw new NotFoundException(`Placement ${dto.placementId} not found`);

    const sow = await this.prisma.scopeOfWork.create({
      data: {
        placementId: placement.id,
        clientId: placement.clientId,
        staffId: placement.staffId,
        content: dto.content,
        isNonStandard: dto.isNonStandard ?? false,
        createdBy: actorId,
        status: 'DRAFT',
      },
    });

    await this.audit.log({
      actorId, action: AuditAction.AGREEMENT_SIGN, entityType: 'scope_of_work', entityId: sow.id,
      metadata: { event: 'SOW_CREATED', placementId: placement.id },
    });
    return sow;
  }

  async findOne(id: string) {
    const sow = await this.prisma.scopeOfWork.findUnique({ where: { id } });
    if (!sow) throw new NotFoundException(`SOW ${id} not found`);
    return sow;
  }

  async findForPlacement(placementId: string) {
    return this.prisma.scopeOfWork.findMany({
      where: { placementId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** RM edits content — only while still DRAFT. Once SENT/ACKNOWLEDGED, use amend(). */
  async update(id: string, content: string, actorId: string) {
    const sow = await this.findOne(id);
    if (sow.status !== 'DRAFT') {
      throw new BadRequestException(
        `Cannot edit a SOW in status ${sow.status} — use the amend endpoint, which creates a new version instead of rewriting an already-sent/acknowledged one.`,
      );
    }
    const updated = await this.prisma.scopeOfWork.update({
      where: { id },
      data: { content, amendedBy: actorId, version: { increment: 1 } },
    });
    await this.audit.log({
      actorId, action: AuditAction.AGREEMENT_SIGN, entityType: 'scope_of_work', entityId: id,
      metadata: { event: 'SOW_EDITED_DRAFT' },
    });
    return updated;
  }

  async send(id: string, actorId: string) {
    const sow = await this.findOne(id);
    if (sow.status !== 'DRAFT') throw new BadRequestException(`Cannot send from status ${sow.status}`);
    const updated = await this.prisma.scopeOfWork.update({
      where: { id },
      data: { status: 'SENT', sentAt: new Date() },
    });
    await this.audit.log({
      actorId, action: AuditAction.AGREEMENT_SIGN, entityType: 'scope_of_work', entityId: id,
      metadata: { event: 'SOW_SENT' },
    });
    return updated;
  }

  /** Client acknowledges — ownership (clientId match) is checked by the controller before this is called. */
  async acknowledge(id: string, actorUserId: string) {
    const sow = await this.findOne(id);
    if (sow.status !== 'SENT') {
      throw new BadRequestException(`Cannot acknowledge from status ${sow.status} — SOW must be SENT first`);
    }
    const updated = await this.prisma.scopeOfWork.update({
      where: { id },
      data: { status: 'ACKNOWLEDGED', acknowledgedBy: actorUserId, acknowledgedAt: new Date() },
    });
    await this.audit.log({
      actorId: actorUserId, action: AuditAction.AGREEMENT_SIGN, entityType: 'scope_of_work', entityId: id,
      metadata: { event: 'SOW_ACKNOWLEDGED' },
    });
    return updated;
  }

  /** RM-mediated amendment. If the current version isn't acknowledged yet, this is just update(). */
  async amend(id: string, content: string, actorId: string) {
    const current = await this.findOne(id);
    if (current.status !== 'ACKNOWLEDGED') {
      return this.update(id, content, actorId);
    }

    const [superseded, next] = await this.prisma.$transaction([
      this.prisma.scopeOfWork.update({ where: { id }, data: { status: 'SUPERSEDED' } }),
      this.prisma.scopeOfWork.create({
        data: {
          placementId: current.placementId,
          clientId: current.clientId,
          staffId: current.staffId,
          content,
          version: current.version + 1,
          status: 'DRAFT',
          isNonStandard: current.isNonStandard,
          createdBy: current.createdBy,
          amendedBy: actorId,
          supersedesId: current.id,
        },
      }),
    ]);

    await this.audit.log({
      actorId, action: AuditAction.AGREEMENT_SIGN, entityType: 'scope_of_work', entityId: next.id,
      metadata: { event: 'SOW_AMENDED', supersedes: superseded.id },
    });
    return next;
  }

  async approveNonStandard(id: string, actorId: string) {
    const sow = await this.findOne(id);
    if (!sow.isNonStandard) throw new BadRequestException('This SOW is not marked non-standard — nothing to approve');
    const updated = await this.prisma.scopeOfWork.update({
      where: { id },
      data: { bmApprovedBy: actorId, bmApprovedAt: new Date() },
    });
    await this.audit.log({
      actorId, action: AuditAction.APPROVAL, entityType: 'scope_of_work', entityId: id,
      metadata: { event: 'SOW_NON_STANDARD_APPROVED' },
    });
    return updated;
  }
}
