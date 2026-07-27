import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface CreateCustomerDto {
  customer_name: string;
  address: string;
  pan_card: string;
  gstn?: string;
}

function generateUnitCode(name: string, existing: string[]): string {
  // Take first letter of each word, uppercase, max 5 chars
  const words = name.trim().toUpperCase().split(/\s+/).filter(Boolean);
  let base = words.map((w) => w[0]).join('').slice(0, 5);
  if (base.length < 3) base = name.replace(/\s+/g, '').slice(0, 5).toUpperCase();

  let code = base;
  let counter = 1;
  while (existing.includes(code)) {
    code = base.slice(0, 4) + String(counter).padStart(1, '0');
    counter++;
  }
  return code.toUpperCase();
}

function generateUnitName(name: string): string {
  return name.toUpperCase().slice(0, 50);
}

function buildBillPrefix(month: number, year: number): string {
  const m = String(month).padStart(2, '0');
  return `BILL/${year}${m}`;
}

@Injectable()
export class FinanceCustomerService {
  constructor(private readonly dataSource: DataSource) {}

  async createCustomer(dto: CreateCustomerDto) {
    // Check PAN uniqueness
    const panCheck = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM finance_customers WHERE pan_card = $1`,
      [dto.pan_card.toUpperCase()],
    );
    if (panCheck.length) {
      throw new ConflictException(`Customer with PAN ${dto.pan_card} already exists`);
    }

    // Collect existing unit codes
    const existing = await this.dataSource.query<{ unit_code: string }[]>(
      `SELECT unit_code FROM finance_customers`,
    );
    const existingCodes = existing.map((r) => r.unit_code);

    const unitCode = generateUnitCode(dto.customer_name, existingCodes);
    const unitName = generateUnitName(dto.customer_name);

    const now = new Date();
    const billPrefix = buildBillPrefix(now.getMonth() + 1, now.getFullYear());

    const result = await this.dataSource.query<{ id: string }[]>(
      `INSERT INTO finance_customers
         (id, customer_name, address, pan_card, gstn, bill_no_prefix, bill_seq,
          unit_code, unit_name, status, metadata, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, $4, $5, 1, $6, $7, 'ACTIVE', '{}', now(), now())
       RETURNING id`,
      [
        dto.customer_name,
        dto.address,
        dto.pan_card.toUpperCase(),
        dto.gstn ? dto.gstn.toUpperCase() : null,
        billPrefix,
        unitCode,
        unitName,
      ],
    );

    const id = result[0].id;
    return this.getCustomer(id);
  }

  async listCustomers(search?: string) {
    let sql = `
      SELECT id, customer_name, address, pan_card, gstn,
             bill_no_prefix, bill_seq, unit_code, unit_name,
             status, created_at, updated_at
      FROM finance_customers
    `;
    const params: unknown[] = [];
    if (search) {
      params.push(`%${search}%`);
      sql += ` WHERE customer_name ILIKE $1 OR pan_card ILIKE $1 OR unit_code ILIKE $1`;
    }
    sql += ` ORDER BY created_at DESC`;
    return this.dataSource.query(sql, params);
  }

  async getCustomer(id: string) {
    const rows = await this.dataSource.query(
      `SELECT id, customer_name, address, pan_card, gstn,
              bill_no_prefix, bill_seq, unit_code, unit_name,
              status, created_at, updated_at
       FROM finance_customers WHERE id = $1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException(`Customer ${id} not found`);
    return rows[0];
  }

  async updateCustomer(id: string, dto: Partial<CreateCustomerDto> & { status?: string }) {
    const existing = await this.getCustomer(id);
    await this.dataSource.query(
      `UPDATE finance_customers SET
         customer_name = $1, address = $2, pan_card = $3,
         gstn = $4, status = $5, unit_name = $6, updated_at = now()
       WHERE id = $7`,
      [
        dto.customer_name ?? existing.customer_name,
        dto.address ?? existing.address,
        (dto.pan_card ?? existing.pan_card).toUpperCase(),
        dto.gstn ? dto.gstn.toUpperCase() : existing.gstn,
        dto.status ?? existing.status,
        generateUnitName(dto.customer_name ?? existing.customer_name),
        id,
      ],
    );
    return this.getCustomer(id);
  }

  /** Generate next bill number for this customer (increments monthly counter) */
  async generateBillNumber(customerId: string): Promise<string> {
    const now = new Date();
    const newPrefix = buildBillPrefix(now.getMonth() + 1, now.getFullYear());

    const rows = await this.dataSource.query<{ bill_no_prefix: string; bill_seq: number }[]>(
      `SELECT bill_no_prefix, bill_seq FROM finance_customers WHERE id = $1`,
      [customerId],
    );
    if (!rows.length) throw new NotFoundException(`Customer ${customerId} not found`);

    let seq = rows[0].bill_seq;
    const prefix = rows[0].bill_no_prefix;

    // Reset seq if month changed
    if (prefix !== newPrefix) {
      seq = 1;
    } else {
      seq += 1;
    }

    await this.dataSource.query(
      `UPDATE finance_customers SET bill_no_prefix = $1, bill_seq = $2, updated_at = now() WHERE id = $3`,
      [newPrefix, seq, customerId],
    );

    return `${newPrefix}/${String(seq).padStart(4, '0')}`;
  }
}
