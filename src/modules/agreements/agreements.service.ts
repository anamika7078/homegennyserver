import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomInt } from 'crypto';
import { Agreement, AgreementType, AgreementStatus } from './agreement.entity';
import { StaffApplicant } from '../staff/staff.entity';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SendEsignOtpDto } from './dto/send-esign-otp.dto';

@Injectable()
export class AgreementsService {
  private readonly log = new Logger(AgreementsService.name);

  constructor(
    @InjectRepository(Agreement)
    private readonly agreementRepo: Repository<Agreement>,
    @InjectRepository(StaffApplicant)
    private readonly staffRepo: Repository<StaffApplicant>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createAgreement(data: Partial<Agreement>) {
    if (data.type === AgreementType.A2) {
      const a1 = await this.agreementRepo.findOne({
        where: { client_id: data.client_id, type: AgreementType.A1, status: AgreementStatus.SIGNED }
      });
      if (!a1) throw new BadRequestException('A1 Agreement must be signed before A2');
    }
    const agreement = this.agreementRepo.create(data);
    return this.agreementRepo.save(agreement);
  }

  async findByClient(clientId: string) {
    return this.agreementRepo.find({
      where: { client_id: clientId },
      order: { created_at: 'DESC' }
    });
  }

  async signAgreement(id: string, signature: { userId: string; role: string; ipAddress: string }) {
    const agreement = await this.agreementRepo.findOne({ where: { id } });
    if (!agreement) throw new BadRequestException('Agreement not found');
    if (agreement.status === AgreementStatus.SIGNED) throw new BadRequestException('Already signed');

    agreement.signatures.push({
      ...signature,
      timestamp: new Date(),
      otp_verified: true,
    });
    agreement.status = AgreementStatus.SIGNED;
    const saved = await this.agreementRepo.save(agreement);

    this.eventEmitter.emit('notification.send', {
      event: 'AGREEMENT_SIGNED',
      message: `${agreement.type} agreement signed by ${signature.role}`,
      data: { agreementId: saved.id, clientId: saved.client_id }
    });
    return saved;
  }

  /**
   * Sends (simulates) an e-sign OTP for a specific agreement step on a staff deployment bundle.
   * OTP is logged server-side; integrate SMS/email provider in production.
   */
  async sendEsignOtp(dto: SendEsignOtpDto) {
    const staff = await this.staffRepo.findOne({ where: { id: dto.staff_id } });
    const staffName = (staff?.full_name?.trim() || dto.staff_name?.trim() || '').trim();
    if (!staffName) {
      throw new BadRequestException('Could not resolve staff name');
    }
    const otp = String(randomInt(100000, 999999));
    this.log.log(`[ESIGN_OTP] type=${dto.agreement_type} staff=${staffName} staff_id=${dto.staff_id} otp=${otp} ttl=10m`);

    this.eventEmitter.emit('notification.send', {
      event: 'AGREEMENT_ESIGN_OTP',
      message: `${dto.agreement_type} OTP for ${staffName}`,
      data: {
        staff_id: dto.staff_id,
        agreement_type: dto.agreement_type,
        expires_in_minutes: 10,
      },
    });

    return {
      agreement_type: dto.agreement_type,
      staff_name: staffName,
      expires_in_minutes: 10,
    };
  }
}
