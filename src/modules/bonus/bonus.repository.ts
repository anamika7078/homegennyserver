import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { CreateBonusRecordDto, UpdateBonusRecordDto } from './dto/bonus.dto';

@Injectable()
export class BonusRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateBonusRecordDto) {
    return this.prisma.bonusRecord.create({
      data: {
        ...dto,
        status: dto.status ?? 'APPROVED',
      },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async findAll(params: { employeeId?: string; month?: number; year?: number; status?: string; category?: string }) {
    const where: Prisma.BonusRecordWhereInput = {};
    if (params.employeeId) where.employeeId = params.employeeId;
    if (params.month) where.month = Number(params.month);
    if (params.year) where.year = Number(params.year);
    if (params.status) where.status = params.status;
    if (params.category) where.category = params.category;

    return this.prisma.bonusRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async findById(id: string) {
    return this.prisma.bonusRecord.findUnique({
      where: { id },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async update(id: string, dto: UpdateBonusRecordDto) {
    return this.prisma.bonusRecord.update({
      where: { id },
      data: dto,
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async delete(id: string) {
    return this.prisma.bonusRecord.delete({ where: { id } });
  }
}
