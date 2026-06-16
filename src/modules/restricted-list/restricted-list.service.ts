import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';

interface RestrictedRow { id: string; reason: string; }

@Injectable()
export class RestrictedListService {
  constructor(private readonly dataSource: DataSource) { }

  async add(data: {
    staff_id?: string; aadhaar_number?: string; phone?: string;
    reason: string; added_by: string; notes?: string;
  }): Promise<Record<string, unknown>> {
    const aadhaarHash = data.aadhaar_number
      ? crypto.createHash('sha256').update(data.aadhaar_number).digest('hex') : null;
    const phoneHash = data.phone
      ? crypto.createHash('sha256').update(data.phone).digest('hex') : null;

    const [row] = await this.dataSource.query<Record<string, unknown>[]>(
      `INSERT INTO restricted_list (staff_id, aadhaar_hash, phone_hash, reason, added_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [data.staff_id ?? null, aadhaarHash, phoneHash, data.reason, data.added_by, data.notes ?? null],
    );
    return row;
  }

  async check(aadhaar: string, phone: string): Promise<{ found: boolean; reason?: string }> {
    try {
      const ah = crypto.createHash('sha256').update(aadhaar).digest('hex');
      const ph = crypto.createHash('sha256').update(phone).digest('hex');
      const rows = await this.dataSource.query<RestrictedRow[]>(
        `SELECT id, reason FROM restricted_list WHERE aadhaar_hash=$1 OR phone_hash=$2 LIMIT 1`,
        [ah, ph],
      );
      return rows.length > 0 ? { found: true, reason: rows[0].reason } : { found: false };
    } catch {
      return { found: false };
    }
  }
}
