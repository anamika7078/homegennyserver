import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { AssessmentSchedule } from './entities/schedule.entity';

@Injectable()
export class SchedulesService {
  constructor(
    @InjectRepository(AssessmentSchedule)
    private readonly scheduleRepo: Repository<AssessmentSchedule>
  ) {}

  async create(data: any) {
    const schedule = this.scheduleRepo.create(data);
    return this.scheduleRepo.save(schedule);
  }

  async getUpcoming() {
    return this.scheduleRepo.find({
      where: { scheduled_date: MoreThanOrEqual(new Date()) },
      relations: ['assessment'],
      order: { scheduled_date: 'ASC' }
    });
  }

  async reschedule(id: string, data: any) {
    const schedule = await this.scheduleRepo.findOne({ where: { id } });
    if (!schedule) throw new NotFoundException('Schedule not found');
    
    schedule.scheduled_date = data.scheduled_date;
    schedule.location = data.location || schedule.location;
    return this.scheduleRepo.save(schedule);
  }
}
