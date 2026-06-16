import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

function toClientDto(row: {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  address: string | null;
  city: string | null;
  status: string;
  kycVerified: boolean;
  medicalRequirements: unknown;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    full_name: row.fullName,
    phone: row.phone,
    email: row.email,
    address: row.address,
    city: row.city,
    status: row.status,
    kyc_verified: row.kycVerified,
    medical_requirements: row.medicalRequirements,
    metadata: row.metadata,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Record<string, unknown>) {
    const row = await this.prisma.clientProfile.create({
      data: {
        fullName: String(data.full_name),
        phone: String(data.phone),
        email: data.email ? String(data.email) : undefined,
        address: data.address ? String(data.address) : undefined,
        city: data.city ? String(data.city) : undefined,
        status: String(data.status ?? 'PROSPECT'),
        medicalRequirements: (data.medical_requirements as object) ?? {},
        metadata: (data.metadata as object) ?? {},
      },
    });
    return toClientDto(row);
  }

  async findAll(params: { search?: string }) {
    const where: Prisma.ClientProfileWhereInput = { deletedAt: null };
    if (params.search) {
      where.OR = [
        { fullName: { contains: params.search, mode: 'insensitive' } },
        { phone: { contains: params.search } },
      ];
    }
    const rows = await this.prisma.clientProfile.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(toClientDto);
  }

  async findOne(id: string) {
    const row = await this.prisma.clientProfile.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Client not found');
    return toClientDto(row);
  }

  async update(id: string, data: Record<string, unknown>) {
    const row = await this.prisma.clientProfile.update({
      where: { id },
      data: {
        ...(data.full_name ? { fullName: String(data.full_name) } : {}),
        ...(data.phone ? { phone: String(data.phone) } : {}),
        ...(data.email !== undefined ? { email: data.email ? String(data.email) : null } : {}),
        ...(data.status ? { status: String(data.status) } : {}),
        ...(data.medical_requirements
          ? { medicalRequirements: data.medical_requirements as Prisma.InputJsonValue }
          : {}),
      },
    });
    return toClientDto(row);
  }
}
