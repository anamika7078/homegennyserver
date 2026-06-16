import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('assessment_audit_logs')
export class AssessmentAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  assessment_id: string;

  @Column('uuid', { nullable: true })
  actor_id: string;

  @Column()
  action: string;

  @Column('jsonb')
  payload: any;

  @CreateDateColumn()
  created_at: Date;
}
