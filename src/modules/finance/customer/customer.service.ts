import { Injectable, ConflictException, NotFoundException, BadRequestException, OnModuleInit, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosResponse } from 'axios';
import { firstValueFrom } from 'rxjs';

export interface PanVerificationResult {
  pan_number: string;
  name_on_pan: string;
  verified: boolean;
  raw: Record<string, any>;
}

export interface BranchItemDto {
  unit_code: string;
  unit_name: string;
  address?: string;
  state?: string;
  city?: string;
  pincode?: string;
  gstn?: string;
}

export interface CreateCustomerDto {
  customer_name: string;
  address: string;
  pan_card: string;
  gstn?: string;
  city?: string;
  state?: string;
  pincode?: string;
  branches?: BranchItemDto[];
  /** Optional — if supplied, a login-capable CLIENT account is provisioned and linked. */
  phone?: string;
  email?: string;
}

function generateUnitCode(name: string, existing: string[]): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const words = name.trim().toUpperCase().split(/\s+/).filter(Boolean);

  let base = '';
  if (words.length >= 3) {
    base = words.map((w) => w[0]).join('').slice(0, 5);
  }
  if (base.length < 3) {
    base = clean.slice(0, 5);
  }
  if (!base) base = 'UNIT';

  let code = `${base}-01`;
  let counter = 1;
  while (existing.includes(code)) {
    counter++;
    code = `${base}-${String(counter).padStart(2, '0')}`;
  }
  return code.toUpperCase();
}

function generateUnitName(name: string): string {
  return name.toUpperCase().slice(0, 50);
}

/**
 * The invoice series a customer bills under.
 *
 * This used to be `BILL/YYYYMM` — the month the customer was onboarded, and
 * nothing else. Every customer created in the same month therefore shared a
 * series, while `bill_seq` counts per customer, so the second such customer's
 * first invoice tried to take a number the first one already held and died on
 * the unique constraint with a bare 500. The unit code is unique per customer,
 * so putting it in front makes the series unique by construction.
 *
 * Existing customers keep the prefix they were created with: a tax series has
 * to stay continuous, and renumbering issued invoices is an accounting event,
 * not a migration. consolidated-invoice.service skips past numbers already
 * taken so those customers can still be billed.
 */
function buildBillPrefix(unitCode: string, month: number, year: number): string {
  const m = String(month).padStart(2, '0');
  const code = (unitCode || '').trim().replace(/\/+$/, '');
  return code ? `${code}/${year}${m}` : `BILL/${year}${m}`;
}

@Injectable()
export class FinanceCustomerService implements OnModuleInit {
  private readonly logger = new Logger(FinanceCustomerService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  async onModuleInit() {
    await this.ensureTablesExist();
  }

  private async ensureTablesExist() {
    try {
      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS finance_customer_branches (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          customer_id UUID NOT NULL REFERENCES finance_customers(id) ON DELETE CASCADE,
          unit_code VARCHAR(50) UNIQUE NOT NULL,
          unit_name VARCHAR(255) NOT NULL,
          address TEXT,
          state VARCHAR(100),
          city VARCHAR(100),
          pincode VARCHAR(20),
          gstn VARCHAR(50),
          status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await this.dataSource.query(`
        DO $$ BEGIN ALTER TABLE finance_customer_branches ADD COLUMN pincode VARCHAR(20); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
        DO $$ BEGIN ALTER TABLE finance_customers ADD COLUMN city VARCHAR(100); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
        DO $$ BEGIN ALTER TABLE finance_customers ADD COLUMN state VARCHAR(100); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
        DO $$ BEGIN ALTER TABLE finance_customers ADD COLUMN pincode VARCHAR(20); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      `);
    } catch (e: any) {
      this.logger.error(`Error bootstrapping customer branches table: ${e?.message}`);
    }
  }

  async createCustomer(dto: CreateCustomerDto) {
    await this.ensureTablesExist();

    if (!dto.customer_name || !dto.customer_name.trim()) {
      throw new BadRequestException('Customer name is required');
    }
    if (!dto.pan_card || !dto.pan_card.trim()) {
      throw new BadRequestException('PAN Card is required');
    }
    if (!dto.address || !dto.address.trim()) {
      throw new BadRequestException('Address is required');
    }

    // Check PAN uniqueness
    const panCheck = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM finance_customers WHERE pan_card = $1`,
      [dto.pan_card.toUpperCase().trim()],
    );
    if (panCheck.length) {
      throw new ConflictException(`Customer with PAN ${dto.pan_card} already exists`);
    }

    // Collect existing unit codes across customers and customer branches
    let existingCustCodes: { unit_code: string }[] = [];
    let existingBranchCodes: { unit_code: string }[] = [];
    try {
      existingCustCodes = await this.dataSource.query<{ unit_code: string }[]>(
        `SELECT unit_code FROM finance_customers`,
      );
    } catch {
      existingCustCodes = [];
    }

    try {
      existingBranchCodes = await this.dataSource.query<{ unit_code: string }[]>(
        `SELECT unit_code FROM finance_customer_branches`,
      );
    } catch {
      existingBranchCodes = [];
    }

    const existingCodes = [
      ...existingCustCodes.map((r) => r.unit_code),
      ...existingBranchCodes.map((r) => r.unit_code),
    ];

    const primaryUnitCode = generateUnitCode(dto.customer_name, existingCodes);
    const primaryUnitName = generateUnitName(dto.customer_name);

    const now = new Date();
    const billPrefix = buildBillPrefix(primaryUnitCode, now.getMonth() + 1, now.getFullYear());

    // Execute in transaction runner
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Insert Customer Master
      const result: any = await queryRunner.query(
        `INSERT INTO finance_customers
           (id, customer_name, address, pan_card, gstn, bill_no_prefix, bill_seq,
            unit_code, unit_name, status, metadata, city, state, pincode, created_at, updated_at)
         VALUES
           (gen_random_uuid(), $1, $2, $3, $4, $5, 1, $6, $7, 'ACTIVE', '{}', $8, $9, $10, now(), now())
         RETURNING id`,
        [
          dto.customer_name.trim(),
          dto.address.trim(),
          dto.pan_card.toUpperCase().trim(),
          dto.gstn ? dto.gstn.toUpperCase().trim() : null,
          billPrefix,
          primaryUnitCode,
          primaryUnitName,
          dto.city ? dto.city.trim() : null,
          dto.state ? dto.state.trim() : null,
          dto.pincode ? dto.pincode.trim() : null,
        ],
      );

      const customerId = result[0].id;

      // 2. Insert Branch items into finance_customer_branches
      const branchItems = (dto.branches && dto.branches.length > 0)
        ? dto.branches
        : [
            {
              unit_code: primaryUnitCode,
              unit_name: primaryUnitName,
              address: dto.address,
              gstn: dto.gstn,
              city: dto.city,
              state: dto.state,
              pincode: dto.pincode,
            },
          ];

      for (const branch of branchItems) {
        const uCode = (branch.unit_code || primaryUnitCode).toUpperCase().trim();
        const uName = (branch.unit_name || primaryUnitName).trim();

        await queryRunner.query(
          `INSERT INTO finance_customer_branches (
            customer_id, unit_code, unit_name, address, state, city, pincode, gstn, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE')`,
          [
            customerId,
            uCode,
            uName,
            branch.address ? branch.address.trim() : dto.address.trim(),
            branch.state ? branch.state.trim() : (dto.state ? dto.state.trim() : null),
            branch.city ? branch.city.trim() : (dto.city ? dto.city.trim() : null),
            branch.pincode ? branch.pincode.trim() : (dto.pincode ? dto.pincode.trim() : null),
            branch.gstn ? branch.gstn.toUpperCase().trim() : (dto.gstn ? dto.gstn.toUpperCase().trim() : null),
          ],
        );
      }

      await queryRunner.commitTransaction();
      return this.getCustomer(customerId);
    } catch (err: any) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Error creating customer: ${err?.message}`);
      if (err?.code === '23505') {
        throw new ConflictException(`Duplicate record: PAN Card or Unit Code already exists`);
      }
      if (err instanceof ConflictException || err instanceof BadRequestException) {
        throw err;
      }
      throw new BadRequestException(err?.message || 'Failed to create customer');
    } finally {
      await queryRunner.release();
    }
  }

  async listCustomers(search?: string) {
    let sql = `
      SELECT c.id, c.customer_name, c.address, c.city, c.state, c.pincode, c.pan_card, c.gstn,
             c.bill_no_prefix, c.bill_seq, c.unit_code, c.unit_name,
             c.status, c.metadata, c.created_at, c.updated_at
      FROM finance_customers c
    `;
    const params: unknown[] = [];
    if (search) {
      params.push(`%${search}%`);
      sql += ` WHERE c.customer_name ILIKE $1 OR c.pan_card ILIKE $1 OR c.unit_code ILIKE $1`;
    }
    sql += ` ORDER BY c.created_at DESC`;
    return this.dataSource.query(sql, params);
  }

  async getCustomer(id: string) {
    const rows = await this.dataSource.query(
      `SELECT c.id, c.customer_name, c.address, c.city, c.state, c.pincode, c.pan_card, c.gstn,
              c.bill_no_prefix, c.bill_seq, c.unit_code, c.unit_name,
              c.status, c.metadata, c.created_at, c.updated_at
       FROM finance_customers c
       WHERE c.id = $1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException(`Customer ${id} not found`);
    return rows[0];
  }

  /**
   * PAN verification — mirrors VerificationService.verifyAadhaar's shape
   * (mock mode until a real provider is configured), but finance_customers
   * has no dedicated VerificationTrack-style table, so the result is merged
   * into its existing `metadata` JSON column instead — same "no migration
   * needed" pattern already used for Placement.wage_config/wage_breakup.
   */
  async verifyPan(customerId: string): Promise<PanVerificationResult> {
    const customer = await this.getCustomer(customerId);
    const panNumber = String(customer.pan_card ?? '').toUpperCase().trim();
    if (!panNumber) throw new BadRequestException('Customer has no PAN on file');

    const apiUrl = this.config.get<string>('app.panVerification.apiUrl') ?? '';
    const apiKey = this.config.get<string>('app.panVerification.apiKey') ?? '';
    const mockMode = !apiKey || this.config.get('app.panVerification.mockMode') === 'true';

    let result: PanVerificationResult;
    if (mockMode) {
      this.logger.warn(`[PAN] Mock mode active for ${panNumber} — no PAN_VERIFICATION_API_KEY configured`);
      result = { pan_number: panNumber, name_on_pan: customer.customer_name, verified: true, raw: { mock: true } };
    } else {
      try {
        const res = await firstValueFrom<AxiosResponse<Record<string, unknown>>>(
          this.http.post(`${apiUrl}/pan/verify`, { pan: panNumber },
            { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 }),
        );
        result = this.mapPanResponse(panNumber, res.data);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`PAN verification error ${panNumber}: ${msg}`);
        throw new BadRequestException(`PAN verification failed: ${msg}`);
      }
    }

    await this.dataSource.query(
      `UPDATE finance_customers SET metadata = metadata || $2::jsonb, updated_at = now() WHERE id = $1`,
      [customerId, JSON.stringify({ pan_verification: { ...result, verified_at: new Date().toISOString() } })],
    );

    return result;
  }

  private mapPanResponse(panNumber: string, data: Record<string, unknown>): PanVerificationResult {
    return {
      pan_number: panNumber,
      name_on_pan: String(data['registered_name'] ?? data['name'] ?? ''),
      verified: data['status'] === 'VALID' || data['category'] != null,
      raw: data,
    };
  }

  async getCustomerBranches(customerId: string) {
    return this.dataSource.query(
      `SELECT * FROM finance_customer_branches WHERE customer_id = $1 AND status = 'ACTIVE' ORDER BY created_at ASC`,
      [customerId],
    );
  }

  async addCustomerBranch(customerId: string, dto: BranchItemDto) {
    const customer = await this.getCustomer(customerId);

    // Check unit_code uniqueness
    const existing = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM finance_customer_branches WHERE unit_code = $1`,
      [dto.unit_code.toUpperCase().trim()],
    );
    if (existing.length) {
      throw new ConflictException(`Unit Code ${dto.unit_code} already exists`);
    }

    await this.dataSource.query(
      `INSERT INTO finance_customer_branches (
        customer_id, unit_code, unit_name, address, state, city, pincode, gstn, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE')`,
      [
        customerId,
        dto.unit_code.toUpperCase().trim(),
        dto.unit_name.trim(),
        dto.address || customer.address,
        dto.state || null,
        dto.city || null,
        dto.pincode || null,
        dto.gstn ? dto.gstn.toUpperCase().trim() : (customer.gstn || null),
      ],
    );

    return this.getCustomer(customerId);
  }

  async listAllCustomerBranches() {
    return this.dataSource.query(
      `SELECT b.*, c.customer_name, c.pan_card
       FROM finance_customer_branches b
       JOIN finance_customers c ON b.customer_id = c.id
       WHERE b.status = 'ACTIVE'
       ORDER BY c.customer_name ASC, b.unit_code ASC`,
    );
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

  /**
   * What this customer's next invoice number will be. Read-only.
   *
   * This used to reserve the number itself: it rewrote `bill_no_prefix` to the
   * current month and reset `bill_seq` to 1 whenever the month had turned. But
   * invoices are numbered by consolidated-invoice.service, which takes the next
   * number inside its own transaction — so a call to this endpoint moved the
   * counter under it and could send a series back to 0001 over numbers that
   * were already issued. Nothing consumed the number it returned. It now only
   * reports, and the invoicing path remains the single place a number is taken.
   */
  async generateBillNumber(customerId: string): Promise<string> {
    const rows = await this.dataSource.query<{ bill_no_prefix: string; bill_seq: number }[]>(
      `SELECT bill_no_prefix, bill_seq FROM finance_customers WHERE id = $1`,
      [customerId],
    );
    if (!rows.length) throw new NotFoundException(`Customer ${customerId} not found`);

    const prefix = (rows[0].bill_no_prefix || 'INV').trim().replace(/\/+$/, '');
    return `${prefix}/${String((rows[0].bill_seq ?? 0) + 1).padStart(4, '0')}`;
  }
}
