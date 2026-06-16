import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Assessor } from '../../assessors/entities/assessor.entity';
// Import candidate if available, assuming User or Candidate entity exists. We'll just use candidate_id for now.

@Entity('assessments')
export class Assessment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  candidate_id: string;

  @Column('uuid', { nullable: true })
  assessor_id: string;

  @Column()
  series: string; // e.g., DR-10, DR-09

  @Column()
  assessment_type: string; // 'DRIVER' or 'SC'

  @Column('int')
  attempt_number: number;

  @Column('decimal', { precision: 5, scale: 2, nullable: true })
  score: number;

  @Column({ nullable: true })
  result: string; // PASS, FAIL, DEFERRED, CONDITIONAL

  @Column('text', { nullable: true })
  remarks: string;

  @Column({ nullable: true })
  scenario_code: string;

  @Column({ default: 'PENDING' })
  status: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
