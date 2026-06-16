import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';

export enum EventType {
  STAGE_ADVANCE = 'STAGE_ADVANCE',
  STAGE_BLOCK = 'STAGE_BLOCK',
  SCENARIO_ASSIGNED = 'SCENARIO_ASSIGNED',
  OUTCOME_SET = 'OUTCOME_SET',
  RESTRICTION_ADDED = 'RESTRICTION_ADDED',
  RESTRICTION_LIFTED = 'RESTRICTION_LIFTED',
  CHECKLIST_ITEM = 'CHECKLIST_ITEM',
  FRAUD_FLAG = 'FRAUD_FLAG',
  VIDEO_CERT_APPROVED = 'VIDEO_CERT_APPROVED',
  VIDEO_CERT_REJECTED = 'VIDEO_CERT_REJECTED',
  NOTE = 'NOTE',
}

@Entity('pipeline_events')
@Index(['staff_id', 'occurred_at'])
export class PipelineEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  staff_id: string;

  @Column({ type: 'enum', enum: EventType })
  event_type: EventType;

  @Column({ nullable: true, length: 30 })
  from_stage: string;

  @Column({ nullable: true, length: 30 })
  to_stage: string;

  @Column({ nullable: true })
  actor_id: string; // user UUID or 'SYSTEM'

  @Column({ nullable: true, length: 80 })
  reason_code: string; // DR-07-CHALLAN-2

  @Column({ type: 'jsonb', default: '{}' })
  payload: Record<string, any>; // Full context for this event

  @Column({ nullable: true, type: 'text' })
  notes: string;

  // APPEND-ONLY: occurred_at is server-set and never updated
  @CreateDateColumn()
  occurred_at: Date;

  // ── IMPORTANT: NO UpdateDateColumn or DeleteDateColumn ──
  // This table is append-only at the DB level via a trigger:
  // CREATE RULE no_update_pipeline_events AS ON UPDATE TO pipeline_events DO INSTEAD NOTHING;
  // CREATE RULE no_delete_pipeline_events AS ON DELETE TO pipeline_events DO INSTEAD NOTHING;
}
