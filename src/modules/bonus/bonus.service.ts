import { Injectable, NotFoundException } from '@nestjs/common';
import { BonusRepository } from './bonus.repository';
import { CreateBonusRecordDto, UpdateBonusRecordDto } from './dto/bonus.dto';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class BonusService {
  constructor(
    private readonly repository: BonusRepository,
    private readonly prisma: PrismaService,
  ) {}

  async create(dto: CreateBonusRecordDto) {
    const emp = await this.prisma.employee.findUnique({ where: { id: dto.employeeId } });
    if (!emp) throw new NotFoundException(`Employee ${dto.employeeId} not found.`);
    return this.repository.create(dto);
  }

  async findAll(query: any) {
    return this.repository.findAll(query);
  }

  async findById(id: string) {
    const record = await this.repository.findById(id);
    if (!record) throw new NotFoundException(`Bonus record ${id} not found.`);
    return record;
  }

  async update(id: string, dto: UpdateBonusRecordDto) {
    await this.findById(id);
    return this.repository.update(id, dto);
  }

  async delete(id: string) {
    await this.findById(id);
    return this.repository.delete(id);
  }
}
