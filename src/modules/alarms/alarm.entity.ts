import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum AlarmStatus {
  OPEN = 'OPEN',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  RESOLVED = 'RESOLVED',
}

export enum AlarmSeverity {
  CRITICAL = 'CRITICAL',
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

@Entity('alarms')
export class Alarm {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Human-readable id for UI, e.g. AL-012 */
  @Column({ type: 'varchar', length: 32, unique: true })
  ref_code: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'enum', enum: AlarmStatus, default: AlarmStatus.OPEN })
  status: AlarmStatus;

  @Column({ type: 'enum', enum: AlarmSeverity })
  severity: AlarmSeverity;

  @Column({ type: 'varchar', length: 32 })
  category: string;

  @Column({ type: 'text' })
  list_meta: string;

  @Column({ type: 'text' })
  list_footer: string;

  @Column({ type: 'varchar', length: 120 })
  assigned_to: string;

  @Column({ type: 'text', nullable: true })
  detail_meta: string | null;

  @Column({ type: 'text', nullable: true })
  recommended_action: string | null;

  @Column({ type: 'boolean', default: false })
  is_read: boolean;

  @Column({ type: 'text', nullable: true })
  bm_note: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  bm_action_status: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  bm_action_at: Date | null;

  @Column({ type: 'uuid', nullable: true })
  bm_action_by: string | null;

  @Column({ type: 'uuid', nullable: true })
  resolved_by: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  resolved_at: Date | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updated_at: Date;
}
