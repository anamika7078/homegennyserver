import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('notification_logs')
export class NotificationLog {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ length: 200 }) recipient: string;
  @Column({ length: 20 }) channel: string;  // FCM | EMAIL
  @Column({ length: 100 }) template: string;
  @Column({ type: 'jsonb', default: '{}' }) payload: Record<string, any>;
  @Column({ length: 20, default: 'PENDING' }) status: string;
  @Column({ nullable: true }) error: string;
  @Column({ type: 'timestamptz', nullable: true }) sent_at: Date;
  @CreateDateColumn() created_at: Date;
}