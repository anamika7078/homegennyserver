import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ReimbursementRepository } from './reimbursement.repository';
import { CreateReimbursementDto, UpdateReimbursementStatusDto } from './dto/reimbursement.dto';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ReimbursementService {
  constructor(
    private readonly repository: ReimbursementRepository,
    private readonly prisma: PrismaService,
  ) {}

  async create(dto: CreateReimbursementDto) {
    if (dto.amount <= 0) {
      throw new BadRequestException('Reimbursement amount must be greater than zero.');
    }
    const emp = await this.prisma.employee.findUnique({ where: { id: dto.employeeId } });
    if (!emp) throw new NotFoundException(`Employee ${dto.employeeId} not found.`);
    return this.repository.create(dto);
  }

  async findAll(query: any) {
    return this.repository.findAll({
      employeeId: query.employeeId,
      status: query.status,
      category: query.category,
      month: query.month ? Number(query.month) : undefined,
      year: query.year ? Number(query.year) : undefined,
    });
  }

  async findById(id: string) {
    const req = await this.repository.findById(id);
    if (!req) throw new NotFoundException(`Reimbursement request ${id} not found.`);
    return req;
  }

  async updateStatus(id: string, dto: UpdateReimbursementStatusDto) {
    await this.findById(id);
    return this.repository.updateStatus(id, dto);
  }

  async delete(id: string) {
    await this.findById(id);
    return this.repository.delete(id);
  }
}
