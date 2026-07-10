import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CategoriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.employeeCategory.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async findById(id: string) {
    return this.prisma.employeeCategory.findUnique({
      where: { id },
    });
  }

  async findByName(name: string) {
    return this.prisma.employeeCategory.findUnique({
      where: { name },
    });
  }

  async create(name: string) {
    return this.prisma.employeeCategory.create({
      data: { name },
    });
  }

  async update(id: string, name: string) {
    return this.prisma.employeeCategory.update({
      where: { id },
      data: { name },
    });
  }

  async delete(id: string) {
    return this.prisma.employeeCategory.delete({
      where: { id },
    });
  }
}
