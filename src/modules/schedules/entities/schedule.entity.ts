import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Assessment } from '../../assessments/entities/assessment.entity';

@Entity('assessment_schedules')
export class AssessmentSchedule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  assessment_id: string;

  @ManyToOne(() => Assessment)
  @JoinColumn({ name: 'assessment_id' })
  assessment: Assessment;

  @Column('timestamp')
  scheduled_date: Date;

  @Column()
  location: string;

  @Column({ default: 'SCHEDULED' })
  status: string;

  @Column('uuid', { nullable: true })
  created_by: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
