import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Assessment } from '../../assessments/entities/assessment.entity';

@Entity('competency_scores')
export class CompetencyScore {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  assessment_id: string;

  @ManyToOne(() => Assessment)
  @JoinColumn({ name: 'assessment_id' })
  assessment: Assessment;

  @Column()
  skill_name: string;

  @Column('decimal', { precision: 5, scale: 2 })
  score: number;

  @Column('text', { nullable: true })
  remarks: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
