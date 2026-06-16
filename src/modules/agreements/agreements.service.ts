import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, AgreementStatus } from '@prisma/client';
import { SendEsignOtpDto } from './dto/send-esign-otp.dto';

interface OtpEntry {
  otp: string;
  staffId: string;
  agreementType: string;
  expiresAt: number;
}

/** Row shape from legacy agreements table (no staff_id / otp_verified columns) */
interface AgreementRow {
  id: string;
  type: string;
  status: string;
  client_id: string;
  signatures: unknown;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class AgreementsService {
  private readonly log = new Logger(AgreementsService.name);
  private readonly otpStore = new Map<string, OtpEntry>();
  private readonly otpVerifiedKeys = new Set<string>();
  private staffColumnReady: boolean | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly audit: AuditService,
  ) {}

  private otpKey(staffId: string, type: string) {
    return `${staffId}:${type}`;
  }

  private legacyStaffTag(staffId: string) {
    return JSON.stringify([{ staff_id: staffId, _legacy: true }]);
  }

  private async agreementsHasStaffColumn(): Promise<boolean> {
    if (this.staffColumnReady !== null) return this.staffColumnReady;
    const rows = await this.prisma.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'agreements'
          AND column_name = 'staff_id'
      ) AS exists
    `;
    this.staffColumnReady = Boolean(rows[0]?.exists);
    if (!this.staffColumnReady) {
      this.log.warn(
        '[Agreements] agreements.staff_id column missing — using legacy signatures storage. ' +
          'Run prisma/migrations/20260519100000_agreements_align/migration.sql as a DB admin.',
      );
    }
    return this.staffColumnReady;
  }

  private async findAgreementByStaff(staffId: string, type: string) {
    if (await this.agreementsHasStaffColumn()) {
      const rows = await this.prisma.$queryRaw<
        { id: string; client_id: string; type: string; status: string }[]
      >`
        SELECT id, client_id, type::text AS type, status::text AS status
        FROM agreements
        WHERE staff_id = ${staffId}::uuid
          AND type = ${type}
        LIMIT 1
      `;
      return rows[0] ?? null;
    }
    return this.findLegacyAgreement(staffId, type);
  }

  private async insertAgreementRow(staffId: string, clientId: string, type: string) {
    if (await this.agreementsHasStaffColumn()) {
      await this.prisma.$executeRaw`
        INSERT INTO agreements (staff_id, client_id, type, status, signatures)
        VALUES (
          ${staffId}::uuid,
          ${clientId}::uuid,
          ${type},
          'PENDING'::agreement_status,
          '[]'::jsonb
        )
      `;
      return;
    }
    await this.createLegacyAgreement(staffId, type, clientId);
  }

  private async findLegacyAgreement(staffId: string, type: string): Promise<AgreementRow | null> {
    const tag = this.legacyStaffTag(staffId);
    const rows = await this.prisma.$queryRaw<AgreementRow[]>`
      SELECT id, type, status, client_id, signatures, created_at, updated_at
      FROM agreements
      WHERE type = ${type}
        AND signatures @> ${tag}::jsonb
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async createLegacyAgreement(staffId: string, type: string, clientId: string) {
    const tag = this.legacyStaffTag(staffId);
    await this.prisma.$executeRaw`
      INSERT INTO agreements (client_id, type, status, signatures)
      VALUES (
        ${clientId}::uuid,
        ${type},
        'PENDING'::agreement_status,
        ${tag}::jsonb
      )
    `;
  }

  private staffIdFromLegacySignatures(signatures: unknown): string | null {
    if (!Array.isArray(signatures)) return null;
    for (const entry of signatures) {
      if (
        entry &&
        typeof entry === 'object' &&
        'staff_id' in entry &&
        typeof (entry as { staff_id: unknown }).staff_id === 'string'
      ) {
        return (entry as { staff_id: string }).staff_id;
      }
    }
    return null;
  }

  private async findAnyClientId(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM clients ORDER BY created_at ASC LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }

  private async createDevClient(): Promise<string> {
    const phone = `99${String(randomInt(100000000, 999999999))}`;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO clients (full_name, phone, status)
      VALUES ('Development Client', ${phone}, 'PROSPECT')
      RETURNING id
    `;
    if (!rows[0]?.id) throw new BadRequestException('Could not create client record');
    return rows[0].id;
  }

  private async findLegacyClientForStaff(staffId: string): Promise<string | null> {
    const tag = this.legacyStaffTag(staffId);
    const rows = await this.prisma.$queryRaw<{ client_id: string }[]>`
      SELECT client_id FROM agreements
      WHERE signatures @> ${tag}::jsonb
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0]?.client_id ?? null;
  }

  async list(params: { staffId?: string; clientId?: string; status?: string }) {
    if (!(await this.agreementsHasStaffColumn())) {
      const rows = await this.prisma.$queryRaw<AgreementRow[]>`
        SELECT id, type, status, client_id, signatures, created_at, updated_at
        FROM agreements
        ORDER BY created_at DESC
        LIMIT 100
      `;
      return rows
        .map((a) => ({
          id: a.id,
          staff_id: this.staffIdFromLegacySignatures(a.signatures),
          client_id: a.client_id,
          type: a.type,
          status: a.status,
          otp_verified: false,
          pdf_url: null,
          signatures: a.signatures,
          created_at: a.created_at,
        }))
        .filter((a) => !params.staffId || a.staff_id === params.staffId)
        .filter((a) => !params.clientId || a.client_id === params.clientId)
        .filter((a) => !params.status || a.status === params.status);
    }

    const where: Record<string, unknown> = {};
    if (params.staffId) where.staffId = params.staffId;
    if (params.clientId) where.clientId = params.clientId;
    if (params.status) where.status = params.status as AgreementStatus;

    const rows = await this.prisma.agreement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((a) => ({
      id: a.id,
      staff_id: a.staffId,
      client_id: a.clientId,
      type: a.type,
      status: a.status,
      otp_verified: a.otpVerified,
      pdf_url: a.pdfUrl,
      signatures: a.signatures,
      created_at: a.createdAt,
    }));
  }

  async createAgreement(data: {
    staff_id?: string;
    client_id: string;
    type: string;
    placement_id?: string;
  }) {
    if (data.type === 'A2' || data.type === 'A2_SOW') {
      const a1 = await this.prisma.agreement.findFirst({
        where: {
          clientId: data.client_id,
          type: { in: ['A1', 'A1_EOR'] },
          status: AgreementStatus.SIGNED,
        },
      });
      if (!a1) throw new BadRequestException('A1 must be signed before A2/SOW');
    }

    const row = await this.prisma.agreement.create({
      data: {
        staffId: data.staff_id,
        clientId: data.client_id,
        placementId: data.placement_id,
        type: data.type,
        status: AgreementStatus.PENDING,
      },
    });
    return row;
  }

  /** Resolve client for agreement rows — placements, prior agreement, or first client record */
  private async resolveClientIdForStaff(staffId: string): Promise<string> {
    if (await this.agreementsHasStaffColumn()) {
      const prior = await this.prisma.$queryRaw<{ client_id: string }[]>`
        SELECT client_id FROM agreements
        WHERE staff_id = ${staffId}::uuid
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (prior[0]?.client_id) return prior[0].client_id;
    } else {
      const legacyClient = await this.findLegacyClientForStaff(staffId);
      if (legacyClient) return legacyClient;
    }

    try {
      const placements = await this.prisma.$queryRaw<{ client_id: string }[]>`
        SELECT client_id FROM placements
        WHERE staff_id = ${staffId}::uuid
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (placements[0]?.client_id) return placements[0].client_id;
    } catch {
      // placements table may not exist on older DBs
    }

    const existingClient = await this.findAnyClientId();
    if (existingClient) return existingClient;

    if (process.env.NODE_ENV !== 'production') {
      const createdId = await this.createDevClient();
      this.log.warn(`[ESIGN_OTP] Auto-created dev client ${createdId}`);
      return createdId;
    }

    throw new BadRequestException(
      'No client is linked for this staff member. Add a client record before sending agreement OTP.',
    );
  }

  private async ensureAgreementRecord(staffId: string, agreementType: string) {
    const existing = await this.findAgreementByStaff(staffId, agreementType);
    if (existing) return existing;

    const clientId = await this.resolveClientIdForStaff(staffId);
    await this.insertAgreementRow(staffId, clientId, agreementType);
    return this.findAgreementByStaff(staffId, agreementType);
  }

  async sendEsignOtp(dto: SendEsignOtpDto) {
    const staff = await this.prisma.staffApplicant.findUnique({ where: { id: dto.staff_id } });
    if (!staff) {
      throw new BadRequestException('Staff not found — refresh the page and try again');
    }
    const staffName = staff.fullName.trim() || dto.staff_name?.trim() || '';
    if (!staffName) throw new BadRequestException('Could not resolve staff name');

    const otp = String(randomInt(100000, 999999));
    const key = this.otpKey(dto.staff_id, dto.agreement_type);
    this.otpStore.set(key, {
      otp,
      staffId: dto.staff_id,
      agreementType: dto.agreement_type,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    this.log.log(`[ESIGN_OTP] ${dto.agreement_type} staff=${staffName} otp=${otp}`);

    await this.ensureAgreementRecord(dto.staff_id, dto.agreement_type);

    this.eventEmitter.emit('notification.dispatch', {
      channels: ['SMS', 'EMAIL', 'IN_APP'],
      event: 'AGREEMENT_ESIGN_OTP',
      phone: staff?.mobile ?? undefined,
      email: staff?.email ?? undefined,
      userId: staff?.assignedRmId ?? undefined,
      data: {
        staff_name: staffName,
        agreement_type: dto.agreement_type,
        otp,
        expires_in_minutes: '10',
      },
    });

    return {
      agreement_type: dto.agreement_type,
      staff_name: staffName,
      expires_in_minutes: 10,
      dev_otp: process.env.NODE_ENV !== 'production' ? otp : undefined,
    };
  }

  async verifyEsignOtp(staffId: string, agreementType: string, otp: string) {
    const key = this.otpKey(staffId, agreementType);
    const entry = this.otpStore.get(key);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new BadRequestException('OTP expired or not sent');
    }
    if (entry.otp !== otp) throw new BadRequestException('Invalid OTP');

    this.otpStore.delete(key);
    this.otpVerifiedKeys.add(key);

    if (await this.agreementsHasStaffColumn()) {
      await this.prisma.$executeRaw`
        UPDATE agreements
        SET otp_verified = true
        WHERE staff_id = ${staffId}::uuid
          AND type = ${agreementType}
      `;
    }

    return { verified: true };
  }

  async signAgreement(
    id: string,
    signature: { userId: string; role: string; ipAddress: string; otp?: string },
  ) {
    const hasStaffCol = await this.agreementsHasStaffColumn();
    const agreement = hasStaffCol
      ? await this.prisma.agreement.findUnique({ where: { id } })
      : (await this.prisma.$queryRaw<AgreementRow[]>`
          SELECT id, type, status, client_id, signatures, created_at, updated_at
          FROM agreements WHERE id = ${id}::uuid LIMIT 1
        `)[0];

    if (!agreement) throw new BadRequestException('Agreement not found');
    const status = hasStaffCol
      ? (agreement as { status: AgreementStatus }).status
      : (agreement as AgreementRow).status;
    if (status === AgreementStatus.SIGNED || status === 'SIGNED') {
      throw new BadRequestException('Already signed');
    }

    const staffId = hasStaffCol
      ? (agreement as { staffId: string | null }).staffId
      : this.staffIdFromLegacySignatures((agreement as AgreementRow).signatures);
    const agreementType = hasStaffCol
      ? (agreement as { type: string }).type
      : (agreement as AgreementRow).type;
    const otpVerified = hasStaffCol
      ? (agreement as { otpVerified: boolean }).otpVerified
      : this.otpVerifiedKeys.has(this.otpKey(staffId ?? '', agreementType));

    if (!otpVerified && signature.otp && staffId) {
      await this.verifyEsignOtp(staffId, agreementType, signature.otp);
    }

    const existingSigs = hasStaffCol
      ? (agreement as { signatures: unknown }).signatures
      : (agreement as AgreementRow).signatures;
    const signatures = Array.isArray(existingSigs) ? [...(existingSigs as object[])] : [];
    signatures.push({
      ...signature,
      timestamp: new Date().toISOString(),
      otp_verified: true,
    });

    const clientId = hasStaffCol
      ? (agreement as { clientId: string }).clientId
      : (agreement as AgreementRow).client_id;

    if (hasStaffCol) {
      await this.prisma.agreement.update({
        where: { id },
        data: { signatures, status: AgreementStatus.SIGNED },
      });
    } else {
      await this.prisma.$executeRaw`
        UPDATE agreements
        SET signatures = ${JSON.stringify(signatures)}::jsonb,
            status = 'SIGNED',
            updated_at = NOW()
        WHERE id = ${id}::uuid
      `;
    }

    await this.audit.log({
      actorId: signature.userId,
      action: AuditAction.AGREEMENT_SIGN,
      entityType: 'agreement',
      entityId: id,
      metadata: { type: agreementType, clientId },
    });

    this.eventEmitter.emit('notification.dispatch', {
      channels: ['EMAIL', 'IN_APP'],
      event: 'AGREEMENT_SIGNED',
      data: { agreementId: id, type: agreementType },
    });

    this.eventEmitter.emit('realtime.broadcast', {
      channel: 'agreements',
      event: 'agreement.signed',
      data: { agreementId: id },
    });

    return { id, status: AgreementStatus.SIGNED, type: agreementType, clientId };
  }

  async generatePdf(agreementId: string) {
    const hasStaffCol = await this.agreementsHasStaffColumn();
    const agreement = hasStaffCol
      ? await this.prisma.agreement.findUnique({ where: { id: agreementId } })
      : (await this.prisma.$queryRaw<AgreementRow[]>`
          SELECT id, type, status, client_id, signatures, created_at, updated_at
          FROM agreements WHERE id = ${agreementId}::uuid LIMIT 1
        `)[0];

    if (!agreement) throw new NotFoundException('Agreement not found');

    const staffLabel = hasStaffCol
      ? (agreement as { staffId: string | null }).staffId ?? 'N/A'
      : this.staffIdFromLegacySignatures((agreement as AgreementRow).signatures) ?? 'N/A';

    const content = [
      `HomeGenny Agreement — ${hasStaffCol ? (agreement as { type: string }).type : (agreement as AgreementRow).type}`,
      `Client: ${hasStaffCol ? (agreement as { clientId: string }).clientId : (agreement as AgreementRow).client_id}`,
      `Staff: ${staffLabel}`,
      `Status: ${hasStaffCol ? (agreement as { status: string }).status : (agreement as AgreementRow).status}`,
      `Generated: ${new Date().toISOString()}`,
    ].join('\n');

    const pdfUrl = `data:application/pdf;base64,${Buffer.from(content).toString('base64')}`;
    const hash = createHash('sha256').update(content).digest('hex');

    if (hasStaffCol) {
      await this.prisma.agreement.update({
        where: { id: agreementId },
        data: { pdfUrl },
      });
    }

    return { agreement_id: agreementId, pdf_url: pdfUrl, sha256: hash };
  }

  async findByClient(clientId: string) {
    return this.list({ clientId });
  }

  /** Lock video cert on staff after RM approval — immutable */
  async lockVideoCert(staffId: string, videoCertId: string, actorId: string) {
    const staff = await this.prisma.staffApplicant.findUnique({ where: { id: staffId } });
    if (!staff) throw new NotFoundException('Staff not found');

    const meta = (staff.metadata as Record<string, unknown>) ?? {};
    if (meta.video_cert_locked) {
      throw new BadRequestException('Video certification is locked and cannot be modified');
    }

    await this.prisma.staffApplicant.update({
      where: { id: staffId },
      data: {
        videoCertId,
        metadata: {
          ...meta,
          video_cert_locked: true,
          video_cert_locked_at: new Date().toISOString(),
          video_cert_locked_by: actorId,
        },
      },
    });

    await this.audit.log({
      actorId,
      action: AuditAction.APPROVAL,
      entityType: 'staff_applicant',
      entityId: staffId,
      metadata: { video_cert_id: videoCertId, immutable: true },
    });

    return { staffId, videoCertId, locked: true };
  }
}
