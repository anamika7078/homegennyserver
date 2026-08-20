import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { calculateGstOnFee, calculateEsic, calculateNetSalary } from '../../../common/finance/statutory-calc.util';
import { WageConfigDto, CalculationItemDto, CreateCalculationDto, CreateQuotationDto } from './dto/commercial.dto';

export { WageConfigDto, CalculationItemDto, CreateCalculationDto, CreateQuotationDto };

const DEFAULT_CATEGORIES = [
  'Security Guard',
  'Lady Guard',
  'Supervisor',
  'Security Officer',
  'Housekeeping',
  'Driver',
  'Office Boy',
  'Receptionist',
  'Technician',
  'Caregiver',
  'Nurse',
  'Cook',
  'Helper'
];

@Injectable()
export class CommercialService {
  constructor(private readonly dataSource: DataSource) {}

  // ─── WAGE CONFIGURATION ───────────────────────────────────────────────────

  async listWageConfigs(search?: string) {
    let sql = `SELECT * FROM finance_wage_config`;
    const params: any[] = [];
    if (search) {
      sql += ` WHERE state ILIKE $1 OR zone ILIKE $1 OR category ILIKE $1`;
      params.push(`%${search}%`);
    }
    sql += ` ORDER BY effective_date DESC, category ASC`;
    return this.dataSource.query(sql, params);
  }

  async getActiveWageConfig(state: string, zone: string, category: string, dateStr?: string) {
    const targetDate = dateStr ? new Date(dateStr) : new Date();
    let rows = await this.dataSource.query(
      `SELECT * FROM finance_wage_config
       WHERE state = $1 AND zone = $2 AND category = $3 AND effective_date <= $4 AND status = 'ACTIVE'
       ORDER BY effective_date DESC LIMIT 1`,
      [state, zone, category, targetDate]
    );
    if (!rows.length) {
      rows = await this.dataSource.query(
        `SELECT * FROM finance_wage_config
         WHERE category = $1 AND status = 'ACTIVE'
         ORDER BY effective_date DESC LIMIT 1`,
        [category]
      );
    }
    if (!rows.length) {
      rows = await this.dataSource.query(
        `SELECT * FROM finance_wage_config WHERE status = 'ACTIVE' ORDER BY effective_date DESC LIMIT 1`
      );
    }
    if (!rows.length) {
      return {
        id: null,
        state,
        zone,
        category,
        basic_wage: 15000,
        da: 0,
        hra: 0,
        skilled_allowance: 0,
        additional_hours_pct: 50,
        employer_pf_pct: 13,
        employer_pf_max: 15000,
        employee_pf_pct: 12,
        employer_esic_pct: 3.25,
        employee_esic_pct: 0.75,
        bonus_pct: 8.33,
        leave_days: 32,
        lwf_pct: 0,
        lwf_max: 62,
        uniform_allowance: 275,
        relieving_pct: 16.67,
        management_pct: 5.5,
        training_charges: 0,
        gst_pct: 18,
        professional_tax: 0,
        nfh: 0,
        pf_applicable: true,
        esic_applicable: true,
        bonus_applicable: true,
        bonus_frequency: 'monthly',
        lwf_applicable: true,
        uniform_applicable: true,
        relieving_applicable: true,
        nfh_applicable: false,
        shift_pattern: '8',
        gst_applicable: true,
        gst_type: 'intra_state',
      };
    }
    return rows[0];
  }

  async createWageConfig(dto: WageConfigDto) {
    const result = await this.dataSource.query(
      `INSERT INTO finance_wage_config (
        state, zone, effective_date, category, basic_wage, da, hra, skilled_allowance,
        additional_hours_pct, employer_pf_pct, employer_pf_max, employee_pf_pct,
        employer_esic_pct, employee_esic_pct, bonus_pct, leave_days, lwf_pct, lwf_max,
        uniform_allowance, relieving_pct, management_pct, training_charges, gst_pct,
        professional_tax, nfh, status,
        pf_applicable, esic_applicable, bonus_applicable, bonus_frequency,
        lwf_applicable, uniform_applicable, relieving_applicable, nfh_applicable, shift_pattern,
        gst_applicable, gst_type
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23, $24, $25, 'ACTIVE',
        $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36
      ) RETURNING id`,
      [
        dto.state,
        dto.zone,
        dto.effective_date,
        dto.category,
        dto.basic_wage,
        dto.da,
        dto.hra,
        dto.skilled_allowance,
        dto.additional_hours_pct,
        dto.employer_pf_pct,
        dto.employer_pf_max,
        dto.employee_pf_pct,
        dto.employer_esic_pct,
        dto.employee_esic_pct,
        dto.bonus_pct,
        dto.leave_days,
        dto.lwf_pct,
        dto.lwf_max,
        dto.uniform_allowance,
        dto.relieving_pct,
        dto.management_pct,
        dto.training_charges,
        dto.gst_pct,
        dto.professional_tax,
        dto.nfh,
        // Toggle flags
        dto.pf_applicable ?? true,
        dto.esic_applicable ?? true,
        dto.bonus_applicable ?? true,
        dto.bonus_frequency ?? 'monthly',
        dto.lwf_applicable ?? true,
        dto.uniform_applicable ?? true,
        dto.relieving_applicable ?? true,
        dto.nfh_applicable ?? false,
        dto.shift_pattern ?? '8',
        dto.gst_applicable ?? true,
        dto.gst_type ?? 'intra_state',
      ]
    );
    return result[0];
  }

  async getWageCategories() {
    const rows = await this.dataSource.query(
      `SELECT DISTINCT category FROM finance_wage_config ORDER BY category ASC`
    );
    const dbCategories = rows.map((r: any) => r.category);
    const merged = Array.from(new Set([...DEFAULT_CATEGORIES, ...dbCategories]));
    return merged.sort();
  }

  // ─── CALCULATOR & CALCULATIONS ──────────────────────────────────────────

  calculateFormulas(config: any, noOfResources: number, workingHours: number) {
    const basic = Number(config.basic_wage) || 0;
    const da = Number(config.da) || 0;
    const hra = Number(config.hra) || 0;
    const skilledAllowance = Number(config.skilled_allowance) || 0;
    
    // Additional Hours % determined ONLY by the workingHours parameter from Commercial Calculator
    // (config.shift_pattern is stored config only, NOT used in calculation)
    const is12HourShift = Number(workingHours) >= 12;
    const additionalHoursPct = is12HourShift ? (Number(config.additional_hours_pct) || 50) : 0;

    const employerPfPct = Number(config.employer_pf_pct) || 13;
    const employerPfMax = Number(config.employer_pf_max) || 15000;
    const employeePfPct = Number(config.employee_pf_pct) || 12;
    const employerEsicPct = Number(config.employer_esic_pct) || 3.25;
    const employeeEsicPct = Number(config.employee_esic_pct) || 0.75;
    const bonusPct = Number(config.bonus_pct) || 8.33;
    const leaveDays = Number(config.leave_days) || 32;
    const uniformAllowance = Number(config.uniform_allowance) || 275;
    const relievingPct = Number(config.relieving_pct) || 0;
    const managementPct = Number(config.management_pct) || 0;
    const trainingCharges = Number(config.training_charges) || 0;
    const gstPct = Number(config.gst_pct) || 18;
    const professionalTax = Number(config.professional_tax) || 0;
    const nfhVal = Number(config.nfh) || 0;

    // Toggle flags (default to true for backward compat)
    const pfOn = config.pf_applicable !== false;
    const esicOn = config.esic_applicable !== false;
    const bonusOn = config.bonus_applicable !== false;
    const bonusFreq: string = config.bonus_frequency || 'monthly';
    const lwfOn = config.lwf_applicable !== false;
    const uniformOn = config.uniform_applicable !== false;
    const relievingOn = config.relieving_applicable !== false;
    const nfhOn = config.nfh_applicable === true;

    // ── Phase A: Gross Salary ──
    const subtotal1 = basic + da;
    const additionalHours = subtotal1 * (additionalHoursPct / 100);
    const subtotal2 = subtotal1 + additionalHours + hra + skilledAllowance;

    // ── Phase B: Statutory Contributions ──
    // Bonus
    const bonusRaw = bonusOn ? subtotal1 * (bonusPct / 100) : 0;
    const bonus = bonusFreq === 'yearly' ? bonusRaw / 12 : bonusRaw;

    // Leave with Wages = SubTotal2 × (leaveDays / 312)
    const workingYear = 312;
    const leaveWages = subtotal2 * (leaveDays / workingYear);
    const nfh = nfhOn ? nfhVal : 0;

    // Gross salary computed here (not just in the "Employee Salary" section
    // below) because the statutory ESIC wage-limit check needs it before the
    // employer-side contribution is calculated.
    const grossSalary = subtotal2 + bonus + leaveWages + nfh;

    // PF Base = Basic + Skilled Allowance + Leave (capped at employer_pf_max)
    // NOTE (Phase 3, deliberately not resolved): the spec's PF rule is
    // ambiguous ("12% on first ₹15,000" vs "applied when salary ≤ ₹15,000")
    // and this quotation calculator uses a different PF base (basic +
    // skilled allowance + leave, capped at a *configurable* employer_pf_max
    // per wage-config row) than the flat statutory calculation in
    // payroll.service.ts / statutory-calc.util.ts (min(gross,15000)*12%,
    // same base both sides). Left as-is per instruction not to invent a
    // resolution — see PHASE_3 report for the business decision needed.
    const pfBase = basic + skilledAllowance + leaveWages;
    const employerPfCeiling = employerPfMax * (employerPfPct / 100);
    const employerPf = pfOn ? Math.min(Math.round(pfBase * (employerPfPct / 100)), employerPfCeiling) : 0;

    // ESIC — statutory wage-limit check (gross <= ₹21,000) is mandatory and
    // was previously missing entirely; esicOn (wage-config toggle) is kept as
    // an ADDITIONAL override for categories legitimately exempted for other
    // reasons, but can no longer switch ESIC on above the statutory limit.
    const esicStatutorilyApplicable = grossSalary <= 21_000;
    const esicApplicable = esicOn && esicStatutorilyApplicable;
    // Employer ESIC base = SubTotal2 + Leave + Bonus (existing formula, kept
    // as-is — distinct from the employee-side base below, which is grossSalary
    // and already included nfh; not unifying the two bases here, out of scope).
    const esic = esicApplicable ? (subtotal2 + leaveWages + bonus) * (employerEsicPct / 100) : 0;

    // LWF is a fixed statutory amount (stored in lwf_max), NOT a percentage calculation
    const lwfAmount = Number(config.lwf_max) || 62;
    const lwf = lwfOn ? lwfAmount : 0;
    const uniform = uniformOn ? uniformAllowance : 0;

    // ── Phase C: CTC ──
    const subtotal3 = subtotal2 + employerPf + esic + bonus + leaveWages + nfh + lwf + uniform;
    const relieving = relievingOn ? subtotal3 * (relievingPct / 100) : 0;
    const subtotal4 = subtotal3 + relieving;
    const managementFee = subtotal4 * (managementPct / 100);
    const monthlyCostPerResource = subtotal4 + managementFee + trainingCharges;
    const monthlyCost = monthlyCostPerResource * (noOfResources || 1);
    const dailyRate = monthlyCostPerResource / 30.45;
    const hourlyRate = dailyRate / (workingHours || 8);
    // GST applies ONLY to the management fee — CRITICAL FIX (2026-08-10 audit
    // §D1): this used to be `monthlyCost * (gstPct/100)`, taxing the entire
    // cost including staff salary, employer ESIC/PF, bonus, leave, etc.
    // Confirmed against real stored data: a ₹12,069.70 fee was carrying
    // ₹42,213.55 of GST instead of the correct ₹2,172.55.
    const gst = calculateGstOnFee(managementFee, gstPct);
    const grandTotal = monthlyCost + gst;

    // ── Employee Salary ──
    const employeePfCeiling = employerPfMax * (employeePfPct / 100);
    const employeePf = pfOn ? Math.min(Math.round(pfBase * (employeePfPct / 100)), employeePfCeiling) : 0;
    const employeeEsic = esicApplicable ? calculateEsic(grossSalary, employeeEsicPct, employerEsicPct, 21_000).employee : 0;
    // Net = Gross − employee ESIC − employee PF only. Professional tax is no
    // longer subtracted here (audit §D5 / spec has no such term) — it's still
    // computed/returned below as its own line item for display, just not
    // folded into net salary.
    const netSalary = calculateNetSalary(grossSalary, employeeEsic, employeePf);

    return {
      basic,
      da,
      hra,
      skilledAllowance,
      additionalHours,
      additional_hours: additionalHours,
      additionalHoursPct,
      additional_hours_pct: additionalHoursPct,
      subtotal1,
      subtotal2,
      employerPf,
      employer_pf: employerPf,
      bonus,
      bonusRaw,
      leaveWages,
      leave_wages: leaveWages,
      esic,
      lwf,
      uniform,
      nfh,
      subtotal3,
      relieving,
      subtotal4,
      managementFee,
      management_fee: managementFee,
      trainingCharges,
      monthlyCost,
      monthly_cost: monthlyCost,
      dailyRate,
      daily_rate: dailyRate,
      hourlyRate,
      hourly_rate: hourlyRate,
      gst,
      grandTotal,
      grand_total: grandTotal,
      grossSalary,
      gross_salary: grossSalary,
      employeePf,
      employee_pf: employeePf,
      employeeEsic,
      employee_esic: employeeEsic,
      professionalTax,
      professional_tax: professionalTax,
      netSalary,
      net_salary: netSalary,
    };
  }

  private buildEffectiveConfig(item: any, activeConfig: any = {}) {
    return {
      ...activeConfig,
      ...item,
      basic_wage: item.basic_wage !== undefined ? item.basic_wage : (item.basic !== undefined ? item.basic : activeConfig.basic_wage),
      da: item.da !== undefined ? item.da : activeConfig.da,
      hra: item.hra !== undefined ? item.hra : activeConfig.hra,
      skilled_allowance: item.skilled_allowance !== undefined ? item.skilled_allowance : activeConfig.skilled_allowance,
      additional_hours_pct: item.additional_hours_pct !== undefined ? item.additional_hours_pct : activeConfig.additional_hours_pct,
      employer_pf_pct: item.employer_pf_pct !== undefined ? item.employer_pf_pct : activeConfig.employer_pf_pct,
      employer_pf_max: item.employer_pf_max !== undefined ? item.employer_pf_max : activeConfig.employer_pf_max,
      employee_pf_pct: item.employee_pf_pct !== undefined ? item.employee_pf_pct : activeConfig.employee_pf_pct,
      employer_esic_pct: item.employer_esic_pct !== undefined ? item.employer_esic_pct : activeConfig.employer_esic_pct,
      employee_esic_pct: item.employee_esic_pct !== undefined ? item.employee_esic_pct : activeConfig.employee_esic_pct,
      bonus_pct: item.bonus_pct !== undefined ? item.bonus_pct : activeConfig.bonus_pct,
      leave_days: item.leave_days !== undefined ? item.leave_days : activeConfig.leave_days,
      lwf_max: item.lwf_amount !== undefined ? item.lwf_amount : (item.lwf_max !== undefined ? item.lwf_max : activeConfig.lwf_max),
      uniform_allowance: item.uniform_allowance !== undefined ? item.uniform_allowance : activeConfig.uniform_allowance,
      relieving_pct: item.relieving_pct !== undefined ? item.relieving_pct : activeConfig.relieving_pct,
      management_pct: item.management_pct !== undefined ? item.management_pct : activeConfig.management_pct,
      professional_tax: item.professional_tax !== undefined ? item.professional_tax : activeConfig.professional_tax,
      gst_pct: item.gst_pct !== undefined ? item.gst_pct : activeConfig.gst_pct,
    };
  }

  async runCalculationOnTheFly(dto: { state: string; zone: string; items: CalculationItemDto[] }) {
    const results: any[] = [];
    for (const item of dto.items) {
      const activeConfig = await this.getActiveWageConfig(dto.state, dto.zone, item.category).catch(() => ({}));
      const config = this.buildEffectiveConfig(item, activeConfig);
      const calc = this.calculateFormulas(config, item.no_of_resources, item.working_hours);
      results.push({
        ...item,
        ...calc,
        wage_config_id: activeConfig?.id || null,
      });
    }
    return results;
  }

  async createCalculation(dto: CreateCalculationDto, user: any) {
    const customer = await this.dataSource.query(
      `SELECT customer_name, unit_code FROM finance_customers WHERE id = $1`,
      [dto.customer_id]
    );
    if (!customer.length) {
      throw new NotFoundException(`Customer ${dto.customer_id} not found`);
    }

    const { customer_name, unit_code } = customer[0];

    // Determine revision number
    const revRows = await this.dataSource.query(
      `SELECT COALESCE(MAX(revision_number), 0) as max_rev FROM finance_commercial_calculations
       WHERE customer_id = $1`,
      [dto.customer_id]
    );
    const nextRevision = Number(revRows[0].max_rev) + 1;

    // Start transaction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Insert master
      const masterResult = await queryRunner.query(
        `INSERT INTO finance_commercial_calculations (
          customer_id, customer_name, unit_code, branch_id, branch_name, state, zone,
          contract_duration, revision_number, status, created_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, 'DRAFT', $10
        ) RETURNING id`,
        [
          dto.customer_id,
          customer_name,
          unit_code,
          dto.branch_id || null,
          dto.branch_name || null,
          dto.state,
          dto.zone,
          dto.contract_duration,
          nextRevision,
          user?.fullName || user?.phone || user?.email || 'System',
        ]
      );
      const calcId = masterResult[0].id;

      let totalMonthlyCost = 0;
      let totalGst = 0;
      let totalGrandTotal = 0;
      let totalResources = 0;

      // 2. Insert items and run formulas using EXACT user-submitted inputs
      for (const item of dto.items) {
        const activeConfig = await this.getActiveWageConfig(dto.state, dto.zone, item.category).catch(() => ({}));
        const config = this.buildEffectiveConfig(item, activeConfig);
        const calc = this.calculateFormulas(config, item.no_of_resources, item.working_hours);

        await queryRunner.query(
          `INSERT INTO finance_commercial_items (
            calculation_id, category, no_of_resources, working_hours, shift_type, wage_config_id,
            basic, da, hra, skilled_allowance, additional_hours, subtotal1, subtotal2,
            employer_pf, bonus, leave_wages, esic, lwf, uniform, nfh, subtotal3, relieving,
            subtotal4, management_fee, training_charges, monthly_cost, daily_rate, hourly_rate,
            gst, grand_total, gross_salary, employee_pf, employee_esic, professional_tax, net_salary
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35
          )`,
          [
            calcId,
            item.category,
            item.no_of_resources,
            item.working_hours,
            item.shift_type,
            activeConfig?.id || null,
            calc.basic,
            calc.da,
            calc.hra,
            calc.skilledAllowance,
            calc.additionalHours,
            calc.subtotal1,
            calc.subtotal2,
            calc.employerPf,
            calc.bonus,
            calc.leaveWages,
            calc.esic,
            calc.lwf,
            calc.uniform,
            calc.nfh,
            calc.subtotal3,
            calc.relieving,
            calc.subtotal4,
            calc.managementFee,
            calc.trainingCharges,
            calc.monthlyCost,
            calc.dailyRate,
            calc.hourlyRate,
            calc.gst,
            calc.grand_total,
            calc.gross_salary,
            calc.employee_pf,
            calc.employee_esic,
            calc.professional_tax,
            calc.net_salary,
          ]
        );

        totalMonthlyCost += calc.monthlyCost;
        totalGst += calc.gst;
        totalGrandTotal += calc.grand_total;
        totalResources += item.no_of_resources;
      }

      // 3. Update master with totals
      await queryRunner.query(
        `UPDATE finance_commercial_calculations SET
          total_monthly_cost = $1, total_gst = $2, total_grand_total = $3, total_resources = $4
         WHERE id = $5`,
        [totalMonthlyCost, totalGst, totalGrandTotal, totalResources, calcId]
      );

      // 4. Log Audit Trail
      await queryRunner.query(
        `INSERT INTO finance_logs (action, module, details, user_id, user_name)
         VALUES ('CREATE_CALCULATION', 'COMMERCIAL', $1, $2, $3)`,
        [
          JSON.stringify({ calculation_id: calcId, customer_name, unit_code }),
          user?.id || user?.userId || null,
          user?.fullName || user?.phone || user?.email || 'System',
        ]
      );

      await queryRunner.commitTransaction();
      return { id: calcId, nextRevision };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async listCalculations(search?: string) {
    let sql = `SELECT * FROM finance_commercial_calculations`;
    const params: any[] = [];
    if (search) {
      sql += ` WHERE customer_name ILIKE $1 OR unit_code ILIKE $1 OR state ILIKE $1`;
      params.push(`%${search}%`);
    }
    sql += ` ORDER BY created_at DESC`;
    const calcs = await this.dataSource.query(sql, params);

    if (!calcs || !calcs.length) return [];

    const ids = calcs.map((c: any) => c.id);
    const items = await this.dataSource.query(
      `SELECT * FROM finance_commercial_items WHERE calculation_id = ANY($1)`,
      [ids]
    );

    return calcs.map((c: any) => {
      const calcItems = items.filter((it: any) => it.calculation_id === c.id);
      return {
        ...c,
        items: calcItems,
      };
    });
  }

  async getCalculation(id: string) {
    const master = await this.dataSource.query(
      `SELECT * FROM finance_commercial_calculations WHERE id = $1`,
      [id]
    );
    if (!master.length) {
      throw new NotFoundException(`Calculation ${id} not found`);
    }
    const items = await this.dataSource.query(
      `SELECT * FROM finance_commercial_items WHERE calculation_id = $1`,
      [id]
    );
    const approvals = await this.dataSource.query(
      `SELECT * FROM finance_approval WHERE calculation_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    return {
      ...master[0],
      items,
      approvals,
    };
  }

  // ─── APPROVAL FLOW ───────────────────────────────────────────────────────

  async submitForApproval(id: string, user: any) {
    const master = await this.dataSource.query(
      `SELECT status FROM finance_commercial_calculations WHERE id = $1`,
      [id]
    );
    if (!master.length) throw new NotFoundException(`Calculation ${id} not found`);
    if (master[0].status !== 'DRAFT' && master[0].status !== 'REJECTED') {
      throw new BadRequestException(`Cannot submit from status ${master[0].status}`);
    }

    await this.dataSource.query(
      `UPDATE finance_commercial_calculations SET status = 'PENDING_EXECUTIVE' WHERE id = $1`,
      [id]
    );

    await this.dataSource.query(
      `INSERT INTO finance_approval (calculation_id, stage, status, comments, user_id, user_name, approval_date)
       VALUES ($1, 'EXECUTIVE', 'PENDING', 'Submitted for Executive Review', $2, $3, now())`,
      [id, user?.id || user?.userId || null, user?.fullName || user?.phone || user?.email || 'System']
    );

    return { status: 'PENDING_EXECUTIVE' };
  }

  async approveCalculation(id: string, comments: string, user: any) {
    const master = await this.dataSource.query(
      `SELECT status, customer_id, customer_name, unit_code FROM finance_commercial_calculations WHERE id = $1`,
      [id]
    );
    if (!master.length) throw new NotFoundException(`Calculation ${id} not found`);

    const currentStatus = master[0].status;
    let nextStatus = '';
    let stage = '';

    if (currentStatus === 'PENDING_EXECUTIVE') {
      nextStatus = 'PENDING_MANAGER';
      stage = 'EXECUTIVE';
    } else if (currentStatus === 'PENDING_MANAGER') {
      nextStatus = 'PENDING_SUPER_ADMIN';
      stage = 'MANAGER';
    } else if (currentStatus === 'PENDING_SUPER_ADMIN') {
      nextStatus = 'APPROVED';
      stage = 'SUPER_ADMIN';
    } else {
      throw new BadRequestException(`Cannot approve from status ${currentStatus}`);
    }

    await this.dataSource.query(
      `INSERT INTO finance_approval (calculation_id, stage, status, comments, user_id, user_name, approval_date)
       VALUES ($1, $2, 'APPROVED', $3, $4, $5, now())`,
      [id, stage, comments, user?.id || user?.userId || null, user?.fullName || user?.phone || user?.email || 'System']
    );

    await this.dataSource.query(
      `UPDATE finance_commercial_calculations SET status = $1 WHERE id = $2`,
      [nextStatus, id]
    );

    if (nextStatus === 'APPROVED') {
      const items = await this.dataSource.query(
        `SELECT * FROM finance_commercial_items WHERE calculation_id = $1`,
        [id]
      );
      for (const item of items) {
        await this.dataSource.query(
          `INSERT INTO finance_rate_cards (
            calculation_id, customer_id, customer_name, unit_code, category,
            monthly_rate, daily_rate, hourly_rate, effective_date, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), 'ACTIVE')`,
          [
            id,
            master[0].customer_id,
            master[0].customer_name,
            master[0].unit_code,
            item.category,
            item.monthly_cost / item.no_of_resources,
            item.daily_rate,
            item.hourly_rate,
          ]
        );
      }
    }

    await this.dataSource.query(
      `INSERT INTO finance_logs (action, module, details, user_id, user_name)
       VALUES ($1, 'COMMERCIAL', $2, $3, $4)`,
      [
        `APPROVE_${stage}`,
        JSON.stringify({ calculation_id: id, next_status: nextStatus }),
        user?.id || user?.userId || null,
        user?.fullName || user?.phone || user?.email || 'System',
      ]
    );

    return { status: nextStatus };
  }

  async rejectCalculation(id: string, comments: string, user: any) {
    const master = await this.dataSource.query(
      `SELECT status FROM finance_commercial_calculations WHERE id = $1`,
      [id]
    );
    if (!master.length) throw new NotFoundException(`Calculation ${id} not found`);

    const currentStatus = master[0].status;
    let stage = '';

    if (currentStatus === 'PENDING_EXECUTIVE') {
      stage = 'EXECUTIVE';
    } else if (currentStatus === 'PENDING_MANAGER') {
      stage = 'MANAGER';
    } else if (currentStatus === 'PENDING_SUPER_ADMIN') {
      stage = 'SUPER_ADMIN';
    } else {
      throw new BadRequestException(`Cannot reject from status ${currentStatus}`);
    }

    await this.dataSource.query(
      `INSERT INTO finance_approval (calculation_id, stage, status, comments, user_id, user_name, approval_date)
       VALUES ($1, $2, 'REJECTED', $3, $4, $5, now())`,
      [id, stage, comments, user?.id || user?.userId || null, user?.fullName || user?.phone || user?.email || 'System']
    );

    await this.dataSource.query(
      `UPDATE finance_commercial_calculations SET status = 'REJECTED' WHERE id = $1`,
      [id]
    );

    return { status: 'REJECTED' };
  }

  // ─── QUOTATIONS ──────────────────────────────────────────────────────────

  async createQuotation(dto: CreateQuotationDto, user: any) {
    const calc = await this.dataSource.query(
      `SELECT * FROM finance_commercial_calculations WHERE id = $1`,
      [dto.calculation_id]
    );
    if (!calc.length) throw new NotFoundException(`Calculation ${dto.calculation_id} not found`);
    if (calc[0].status === 'REJECTED') {
      throw new BadRequestException(`Cannot generate quotation for rejected calculation (status: ${calc[0].status})`);
    }

    const { customer_id, customer_name, unit_code, total_monthly_cost, total_gst, total_grand_total } = calc[0];

    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const seqResult = await this.dataSource.query(
      `SELECT COUNT(*) as count FROM finance_quotations WHERE DATE(created_at) = CURRENT_DATE`
    );
    const seq = String(Number(seqResult[0].count) + 1).padStart(3, '0');
    const qtnNumber = `QTN/${datePart}/${seq}`;

    const validityDate = new Date();
    validityDate.setDate(validityDate.getDate() + (dto.validity_days || 30));

    const qResult = await this.dataSource.query(
      `INSERT INTO finance_quotations (
        quotation_number, calculation_id, customer_id, customer_name, unit_code,
        date, validity, prepared_by, status, terms_conditions,
        total_monthly_cost, total_gst, total_grand_total
      ) VALUES ($1, $2, $3, $4, $5, now(), $6, $7, 'DRAFT', $8, $9, $10, $11)
      RETURNING id`,
      [
        qtnNumber,
        dto.calculation_id,
        customer_id,
        customer_name,
        unit_code,
        validityDate,
        dto.prepared_by,
        dto.terms_conditions || 'Standard Terms & Conditions apply.',
        total_monthly_cost,
        total_gst,
        total_grand_total,
      ]
    );

    const qid = qResult[0].id;

    const items = await this.dataSource.query(
      `SELECT * FROM finance_commercial_items WHERE calculation_id = $1`,
      [dto.calculation_id]
    );

    for (const item of items) {
      await this.dataSource.query(
        `INSERT INTO finance_quotation_items (
          quotation_id, category, no_of_resources, monthly_rate, gst, grand_total, daily_rate, hourly_rate
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          qid,
          item.category,
          item.no_of_resources,
          item.monthly_cost / item.no_of_resources,
          item.gst,
          item.grand_total,
          item.daily_rate,
          item.hourly_rate,
        ]
      );
    }

    return { id: qid, quotation_number: qtnNumber };
  }

  async listQuotations() {
    return this.dataSource.query(`SELECT * FROM finance_quotations ORDER BY created_at DESC`);
  }

  async getQuotation(id: string) {
    const q = await this.dataSource.query(`SELECT * FROM finance_quotations WHERE id = $1`, [id]);
    if (!q.length) throw new NotFoundException(`Quotation ${id} not found`);
    const items = await this.dataSource.query(
      `SELECT * FROM finance_quotation_items WHERE quotation_id = $1`,
      [id]
    );
    return {
      ...q[0],
      items,
    };
  }

  // ─── RATE CARDS ──────────────────────────────────────────────────────────

  async listRateCards(search?: string) {
    let sql = `SELECT * FROM finance_rate_cards`;
    const params: any[] = [];
    if (search) {
      sql += ` WHERE customer_name ILIKE $1 OR unit_code ILIKE $1 OR category ILIKE $1`;
      params.push(`%${search}%`);
    }
    sql += ` ORDER BY created_at DESC`;
    return this.dataSource.query(sql, params);
  }

  // ─── REPORTS ─────────────────────────────────────────────────────────────

  async getReports() {
    const summary = await this.dataSource.query(
      `SELECT
         COALESCE(SUM(total_monthly_cost), 0) as total_revenue,
         COALESCE(SUM(total_grand_total), 0) as total_grand_total,
         COALESCE(SUM(total_resources), 0) as total_resources
       FROM finance_commercial_calculations WHERE status = 'APPROVED'`
    );

    const marginRows = await this.dataSource.query(
      `SELECT
         COALESCE(SUM(management_fee), 0) as total_margin,
         COALESCE(AVG(management_fee / NULLIF(subtotal4, 0)) * 100, 0) as avg_margin_pct
       FROM finance_commercial_items`
    );

    const customerRev = await this.dataSource.query(
      `SELECT customer_name, unit_code,
              SUM(total_monthly_cost) as revenue
       FROM finance_commercial_calculations
       WHERE status = 'APPROVED'
       GROUP BY customer_name, unit_code
       ORDER BY revenue DESC`
    );

    const categoryRev = await this.dataSource.query(
      `SELECT category,
              SUM(monthly_cost) as revenue,
              SUM(no_of_resources) as resources
       FROM finance_commercial_items i
       JOIN finance_commercial_calculations c ON i.calculation_id = c.id
       WHERE c.status = 'APPROVED'
       GROUP BY category
       ORDER BY revenue DESC`
    );

    const quoteHistory = await this.dataSource.query(
      `SELECT quotation_number, customer_name, date, total_grand_total, status
       FROM finance_quotations
       ORDER BY date DESC LIMIT 10`
    );

    const upcomingRevisions = await this.dataSource.query(
      `SELECT state, zone, category, effective_date, status
       FROM finance_wage_config
       WHERE status = 'ACTIVE'
       ORDER BY effective_date ASC LIMIT 10`
    );

    return {
      revenue: summary[0].total_revenue,
      grand_total: summary[0].total_grand_total,
      resources: summary[0].total_resources,
      margin: marginRows[0].total_margin,
      avg_margin_pct: marginRows[0].avg_margin_pct,
      customer_revenue: customerRev,
      category_revenue: categoryRev,
      quotation_history: quoteHistory,
      upcoming_revisions: upcomingRevisions,
    };
  }

  async getWageRevisionComparison(state: string, zone: string, category: string) {
    return this.dataSource.query(
      `SELECT * FROM finance_wage_config
       WHERE state = $1 AND zone = $2 AND category = $3
       ORDER BY effective_date DESC`,
      [state, zone, category]
    );
  }
}
