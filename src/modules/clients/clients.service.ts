import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from './client.entity';

@Injectable()
export class ClientsService {
  constructor(
    @InjectRepository(Client)
    private readonly clientRepo: Repository<Client>,
  ) {}

  async create(data: Partial<Client>) {
    const client = this.clientRepo.create(data);
    return this.clientRepo.save(client);
  }

  async findAll(params: any) {
    const query = this.clientRepo.createQueryBuilder('c');
    if (params.search) {
      query.andWhere('c.full_name ILIKE :search OR c.phone ILIKE :search', { search: `%${params.search}%` });
    }
    query.orderBy('c.created_at', 'DESC');
    return query.getMany();
  }

  async findOne(id: string) {
    const client = await this.clientRepo.findOne({ where: { id } });
    if (!client) throw new NotFoundException('Client not found');
    return client;
  }

  async update(id: string, data: Partial<Client>) {
    await this.clientRepo.update(id, data);
    return this.findOne(id);
  }
}
