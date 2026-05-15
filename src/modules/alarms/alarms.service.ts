import { Injectable, NotFoundException, OnModuleInit, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Alarm, AlarmStatus } from './alarm.entity';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CreateAlarmDto } from './dto/create-alarm.dto';
import { AlarmActionDto } from './dto/alarm-action.dto';
import { ALARM_SEED_FIXTURES } from './alarms.seed-data';

@Injectable()
export class AlarmsService implements OnModuleInit {
  private readonly log = new Logger(AlarmsService.name);

  constructor(
    @InjectRepository(Alarm)
    private readonly alarmRepo: Repository<Alarm>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    await this.seedIfEmpty();
  }

  private async seedIfEmpty() {
    try {
      const n = await this.alarmRepo.count();
      if (n > 0) return;
      this.log.log('Seeding demo alarms (empty table)…');
      for (const row of ALARM_SEED_FIXTURES) {
        await this.alarmRepo.save(this.alarmRepo.create(row));
      }
      this.log.log(`Inserted ${ALARM_SEED_FIXTURES.length} demo alarms.`);
    } catch (e) {
      this.log.warn(`Alarm seed skipped: ${(e as Error).message}`);
    }
  }

  async createAlarm(dto: CreateAlarmDto) {
    const alarm = this.alarmRepo.create({
      ref_code: dto.ref_code,
      title: dto.title,
      description: dto.description ?? null,
      severity: dto.severity,
      category: dto.category,
      list_meta: dto.list_meta,
      list_footer: dto.list_footer,
      assigned_to: dto.assigned_to,
      detail_meta: dto.detail_meta ?? null,
      recommended_action: dto.recommended_action ?? null,
      is_read: dto.is_read ?? false,
      status: AlarmStatus.OPEN,
      bm_note: null,
      bm_action_status: null,
      bm_action_at: null,
      bm_action_by: null,
      resolved_by: null,
      resolved_at: null,
    });
    const saved = await this.alarmRepo.save(alarm);
    this.eventEmitter.emit('notification.send', {
      event: 'NEW_ALARM',
      message: `Critical Issue: ${saved.title}`,
      data: saved,
    });
    return saved;
  }

  async findAll(filters: { severity?: string; category?: string; status?: string }) {
    const qb = this.alarmRepo.createQueryBuilder('a').orderBy('a.created_at', 'DESC');
    if (filters.status) qb.andWhere('a.status = :status', { status: filters.status });
    if (filters.severity) qb.andWhere('a.severity = :severity', { severity: filters.severity });
    if (filters.category) qb.andWhere('a.category = :category', { category: filters.category });
    return qb.getMany();
  }

  async findOne(id: string) {
    const alarm = await this.alarmRepo.findOne({ where: { id } });
    if (!alarm) throw new NotFoundException('Alarm not found');
    return alarm;
  }

  async markRead(id: string) {
    const alarm = await this.findOne(id);
    alarm.is_read = true;
    return this.alarmRepo.save(alarm);
  }

  async markAllRead() {
    await this.alarmRepo.createQueryBuilder().update(Alarm).set({ is_read: true }).execute();
    return { updated: true };
  }

  async saveBmAction(id: string, dto: AlarmActionDto, userId: string) {
    if (dto.bm_note === undefined && dto.bm_action_status === undefined) {
      throw new BadRequestException('Provide at least bm_note or bm_action_status');
    }
    const alarm = await this.findOne(id);
    if (dto.bm_note !== undefined) alarm.bm_note = dto.bm_note || null;
    if (dto.bm_action_status !== undefined) alarm.bm_action_status = dto.bm_action_status || null;

    const hasNote = !!(alarm.bm_note && alarm.bm_note.trim());
    const hasStatus = !!(alarm.bm_action_status && alarm.bm_action_status.length > 0);
    if (!hasNote && !hasStatus) {
      alarm.bm_action_at = null;
      alarm.bm_action_by = null;
    } else {
      alarm.bm_action_at = new Date();
      alarm.bm_action_by = userId;
    }

    const st = alarm.bm_action_status;
    if (st === 'resolved' || st === 'close_no_action') {
      alarm.status = AlarmStatus.RESOLVED;
      alarm.resolved_by = userId;
      alarm.resolved_at = new Date();
    } else if (st === 'in_progress' || st === 'snooze_24h' || st === 'escalate_director') {
      alarm.status = AlarmStatus.ACKNOWLEDGED;
    }

    return this.alarmRepo.save(alarm);
  }

  async resolveAlarm(id: string, userId: string) {
    const alarm = await this.findOne(id);
    alarm.status = AlarmStatus.RESOLVED;
    alarm.resolved_by = userId;
    alarm.resolved_at = new Date();
    return this.alarmRepo.save(alarm);
  }

  async getStats() {
    return this.alarmRepo
      .createQueryBuilder('a')
      .select('status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('status')
      .getRawMany();
  }
}
