import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum AgreementType {
  A1 = 'A1',
  A2 = 'A2',
  A3 = 'A3',
  A4 = 'A4',
  A5 = 'A5',
}

export enum AgreementStatus {
  PENDING = 'PENDING',
  SIGNED = 'SIGNED',
  VOID = 'VOID',
  EXPIRED = 'EXPIRED',
}

@Entity('agreements')
export class Agreement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: AgreementType })
  type: AgreementType;

  @Column({ type: 'enum', enum: AgreementStatus, default: AgreementStatus.PENDING })
  status: AgreementStatus;

  @Column({ type: 'uuid' })
  client_id: string;

  @Column({ type: 'jsonb', default: [] })
  signatures: Array<{
    role: string;
    userId: string;
    timestamp: Date;
    ipAddress: string;
    otp_verified: boolean;
  }>;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updated_at: Date;
}
