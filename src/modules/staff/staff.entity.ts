import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, DeleteDateColumn, ManyToOne, OneToMany,
  OneToOne, JoinColumn, Index, BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

export enum Series {
  MAID = 'MAID',
  SKILLED_CARE = 'SKILLED_CARE',
  UNSKILLED_CARE = 'UNSKILLED_CARE',
  DRIVER = 'DRIVER',
}

export enum PipelineStage {
  S1_INTAKE = 'S1_INTAKE',
  S2_VERIFY = 'S2_VERIFY',
  S2_5_ASSESS = 'S2_5_ASSESS',
  S3_TRAIN = 'S3_TRAIN',
  S4_AGREEMENTS = 'S4_AGREEMENTS',
  S5_DEPLOY = 'S5_DEPLOY',
  TERMINAL = 'TERMINAL',
}

export enum TerminalOutcome {
  ENROLLED = 'ENROLLED',
  CONDITIONAL = 'CONDITIONAL',
  DEFERRED = 'DEFERRED',
  DENIED = 'DENIED',
  ABANDONED = 'ABANDONED',
  LATE_EXIT = 'LATE_EXIT',
}

export enum PvStatus {
  NOT_INITIATED = 'NOT_INITIATED',
  IN_PROGRESS = 'IN_PROGRESS',
  CLEAR = 'CLEAR',
  ADVERSE = 'ADVERSE',
  EXPIRED = 'EXPIRED',
}

export enum LanguageTier {
  T1 = 'T1',
  T2 = 'T2',
  T3 = 'T3',
  T4 = 'T4',
}

@Entity('staff_applicants')
@Index(['pipeline_stage', 'series'])
@Index(['branch_id', 'assigned_rm_id'])
@Index(['terminal_outcome'], { where: '"terminal_outcome" IS NULL' })
export class StaffApplicant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, length: 30 })
  staff_code: string; // HG-DR-20250601-0047

  @Column({ type: 'enum', enum: Series })
  series: Series;

  @Column({ type: 'simple-array', nullable: true })
  role_types: string[]; // ['NS','BP'] for UC; ['H4','SUV'] for DR

  @Column({ type: 'enum', enum: LanguageTier, nullable: true })
  language_tier: LanguageTier; // DR series only

  @Column({ type: 'enum', enum: PipelineStage, default: PipelineStage.S1_INTAKE })
  @Index()
  pipeline_stage: PipelineStage;

  @Column({ name: 'current_scenario_code', nullable: true, length: 20 })
  current_scenario_code: string; // DR-07, SC-12, M3X-05 etc

  @Column({ type: 'enum', enum: TerminalOutcome, nullable: true })
  terminal_outcome: TerminalOutcome;

  // Personal details
  @Column()
  full_name: string;

  @Column({ type: 'date' })
  date_of_birth: Date;

  @Column({ length: 15 })
  mobile: string;

  @Column({ nullable: true })
  email: string;

  @Column({ type: 'text' })
  address: string;

  @Column({ nullable: true })
  emergency_contact_name: string;

  @Column({ nullable: true })
  emergency_contact_mobile: string;

  // Verification status
  @Column({ type: 'jsonb', default: '{}' })
  verified_docs: {
    aadhaar?: boolean;
    dl?: boolean;
    pv?: boolean;
    medical?: boolean;
    refs_count?: number;
    breathalyser?: boolean;
    sarathi_screenshot_ref?: string;
  };

  @Column({ type: 'enum', enum: PvStatus, default: PvStatus.NOT_INITIATED })
  pv_status: PvStatus;

  // Restrictions (for Conditional outcomes)
  @Column({ type: 'jsonb', default: '{}' })
  restrictions: {
    types?: string[];
    reason?: string;
    upgrade_criteria?: string;
    eligible_at?: Date;
    schedule_ref?: string;
  };

  // Security flags
  @Column({ name: 'restricted_list_flag', default: false })
  @Index()
  restricted_list_flag: boolean; // BM-only write

  // Relationships
  @Column({ nullable: true })
  video_cert_id: string;

  @Column({ nullable: true })
  assigned_rm_id: string;

  @Column({ nullable: true })
  branch_id: string;

  // Series-specific metadata (flexible JSONB)
  @Column({ type: 'jsonb', default: '{}' })
  metadata: {
    // DR specific
    dl_number?: string;
    dl_class?: string[];
    dl_expiry?: Date;
    practical_test_score?: number;
    practical_test_attempts?: number;
    violation_count?: number;
    has_dui?: boolean;
    has_hit_run?: boolean;
    challan_last_checked?: Date;
    vehicle_types_approved?: string[];
    // SC specific
    care_type_tier?: string;
    certifications?: string[];
    // UC specific
    temperament_score?: number;
    temperament_concerns?: number;
    // All
    re_apply_eligible_date?: Date;
    blacklist_reason?: string;
    exit_notes?: string;
    rm_signed_off?: boolean;
    sow_generated?: boolean;
    sow_client_signed?: boolean;
    right_to_refuse_signed?: boolean;
    incident_protocol_briefed?: boolean;
    breathalyser_clear?: boolean;
  };

  // Timestamps
  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @DeleteDateColumn()
  deleted_at: Date;

  @BeforeInsert()
  generateStaffCode() {
    if (!this.staff_code) {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const seq = Math.floor(Math.random() * 9999).toString().padStart(4, '0');
      const seriesCode = this.series?.slice(0, 2).toUpperCase() || 'HG';
      this.staff_code = `HG-${seriesCode}-${date}-${seq}`;
    }
  }
}
