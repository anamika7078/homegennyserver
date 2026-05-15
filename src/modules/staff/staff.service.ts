import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { StaffApplicant } from './staff.entity';
import * as crypto from 'crypto';

interface RestrictedListRow { id: string; reason: string; }

@Injectable()
export class StaffService {
  constructor(
    @InjectRepository(StaffApplicant) private readonly repo: Repository<StaffApplicant>,
    private readonly dataSource: DataSource,
  ) { }

  async create(data: Partial<StaffApplicant>): Promise<StaffApplicant> {
    const s = this.repo.create(data);
    return this.repo.save(s);
  }

  async findById(id: string): Promise<StaffApplicant> {
    const s = await this.repo.findOne({ where: { id } });
    if (!s) throw new NotFoundException(`Staff ${id} not found`);
    return s;
  }

  async findAll(params: {
    limit?: number; offset?: number;
    stage?: string; series?: string; rmId?: string; branchId?: string;
  }): Promise<{ items: StaffApplicant[]; total: number }> {
    const q = this.repo.createQueryBuilder('s');
    if (params.stage) q.andWhere('s.pipeline_stage = :stage', { stage: params.stage });
    if (params.series) q.andWhere('s.series = :series', { series: params.series });
    if (params.rmId) q.andWhere('s.assigned_rm_id = :rmId', { rmId: params.rmId });
    if (params.branchId) q.andWhere('s.branch_id = :branchId', { branchId: params.branchId });
    q.orderBy('s.updated_at', 'DESC')
      .take(params.limit ?? 100)
      .skip(params.offset ?? 0);
    const [items, total] = await q.getManyAndCount();
    return { items, total };
  }

  async update(id: string, data: Partial<StaffApplicant>): Promise<StaffApplicant> {
    await this.repo.update(id, data);
    return this.findById(id);
  }

  async checkRestrictedList(
    aadhaarNumber: string,
    phone: string,
  ): Promise<{ found: boolean; reason?: string }> {
    const aadhaarHash = crypto.createHash('sha256').update(aadhaarNumber).digest('hex');
    const phoneHash = crypto.createHash('sha256').update(phone).digest('hex');
    const rows = await this.dataSource.query<RestrictedListRow[]>(
      `SELECT id, reason FROM restricted_list
       WHERE aadhaar_hash = $1 OR phone_hash = $2 LIMIT 1`,
      [aadhaarHash, phoneHash],
    );
    return rows.length > 0 ? { found: true, reason: rows[0].reason } : { found: false };
  }
}
