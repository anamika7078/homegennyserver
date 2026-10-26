import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ALLOWED_GST_RATES,
  GST_STATE_CODES,
  isValidGstin,
  stateCodeOf,
  stateNameOf,
} from '../../../common/finance/gst.util';
import {
  readSupplierSettings,
  writeSupplierSettings,
  type SupplierSettingField,
} from '../../../common/finance/supplier-settings';

export interface CompanySettingsInput {
  legal_name?: string | null;
  gstin?: string | null;
  state?: string | null;
  sac_code?: string | null;
  address?: string | null;
  pan?: string | null;
  gst_rate_pct?: number | string | null;
  bank_name?: string | null;
  bank_account?: string | null;
  bank_ifsc?: string | null;
  bank_branch?: string | null;
}

const FIELD_MAP: Record<keyof CompanySettingsInput, SupplierSettingField> = {
  legal_name: 'legalName',
  gstin: 'gstin',
  state: 'state',
  sac_code: 'sacCode',
  address: 'address',
  pan: 'pan',
  gst_rate_pct: 'gstRatePct',
  bank_name: 'bankName',
  bank_account: 'bankAccount',
  bank_ifsc: 'bankIfsc',
  bank_branch: 'bankBranch',
};

/**
 * HomeGenny's own name, GSTIN, state, SAC and bank details — what every
 * invoice prints and what decides whether it is a Tax Invoice at all.
 *
 * These lived only in `system_settings`, writable by script. The invoice told
 * Finance to "add it in Finance settings", a page that did not exist, so the
 * dev server issued Bills of Supply with no GST for want of a form.
 */
@Injectable()
export class CompanySettingsService {
  private readonly logger = new Logger(CompanySettingsService.name);

  constructor(private readonly dataSource: DataSource) {}

  async get() {
    const s = await readSupplierSettings(this.dataSource);
    const missing: string[] = [];
    if (!s.isRegistered) missing.push(s.gstin ? 'a valid GSTIN (the one on file is not in GSTIN format)' : 'GSTIN');
    if (!stateCodeOf(s.state)) missing.push('state');
    if (!s.sacCode) missing.push('SAC code');

    // Invoices still open that were raised as a Bill of Supply — once the
    // GSTIN is in, these are the ones Finance should recalculate.
    const stale = await this.dataSource.query<{ n: string }[]>(
      `SELECT COUNT(*)::text AS n FROM client_invoices
        WHERE document_type = 'BILL_OF_SUPPLY' AND is_consolidated = true
          AND status IN ('DRAFT', 'APPROVED')`,
    );

    return {
      legal_name: s.legalName,
      gstin: s.gstin,
      state: s.state,
      state_code: stateCodeOf(s.state),
      sac_code: s.sacCode,
      address: s.address,
      pan: s.pan,
      gst_rate_pct: s.gstRatePct,
      bank_name: s.bankName,
      bank_account: s.bankAccount,
      bank_ifsc: s.bankIfsc,
      bank_branch: s.bankBranch,
      is_registered: s.isRegistered,
      ready_for_tax_invoice: missing.length === 0,
      missing,
      unsent_bills_of_supply: parseInt(stale[0]?.n ?? '0', 10),
      states: Object.entries(GST_STATE_CODES).map(([code, name]) => ({ code, name })),
      allowed_gst_rates: ALLOWED_GST_RATES,
    };
  }

  async update(input: CompanySettingsInput, actorId?: string) {
    const clean = (v: unknown) => (v == null ? null : String(v).trim() || null);
    const values: Partial<Record<SupplierSettingField, string | null>> = {};

    for (const [k, field] of Object.entries(FIELD_MAP) as [keyof CompanySettingsInput, SupplierSettingField][]) {
      if (input[k] !== undefined) values[field] = clean(input[k]);
    }

    if (values.gstin) {
      values.gstin = values.gstin.toUpperCase();
      if (!isValidGstin(values.gstin)) {
        throw new BadRequestException(
          `"${values.gstin}" is not a valid GSTIN. It is 15 characters: 2-digit state code, ` +
            `10-character PAN, entity number, "Z", check character — e.g. 07AABCH1234A1Z8.`,
        );
      }
    }

    if (values.state) {
      const code = stateCodeOf(values.state);
      if (!code) throw new BadRequestException(`"${values.state}" is not a recognised Indian state.`);
      values.state = stateNameOf(code);
    }

    // The GSTIN carries the state it was registered in; the two must agree,
    // or every intra/inter-state decision would be made against the wrong one.
    const current = await readSupplierSettings(this.dataSource);
    const gstin = values.gstin !== undefined ? values.gstin : current.gstin;
    if (gstin && isValidGstin(gstin)) {
      const gstinState = stateNameOf(gstin.slice(0, 2));
      const state = values.state !== undefined ? values.state : current.state;
      if (!state) {
        values.state = gstinState;
      } else if (stateCodeOf(state) !== gstin.slice(0, 2)) {
        throw new BadRequestException(
          `GSTIN ${gstin} is registered in ${gstinState ?? `state code ${gstin.slice(0, 2)}`}, ` +
            `but the state is set to ${state}. They must match.`,
        );
      }
    }

    if (values.sacCode && !/^99\d{4}$/.test(values.sacCode)) {
      throw new BadRequestException(
        `"${values.sacCode}" is not a services SAC code — those are 6 digits starting with 99.`,
      );
    }

    if (values.pan) {
      values.pan = values.pan.toUpperCase();
      if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(values.pan)) {
        throw new BadRequestException(`"${values.pan}" is not a valid PAN.`);
      }
    }

    if (values.bankIfsc) {
      values.bankIfsc = values.bankIfsc.toUpperCase();
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(values.bankIfsc)) {
        throw new BadRequestException(`"${values.bankIfsc}" is not a valid IFSC code.`);
      }
    }

    if (values.gstRatePct != null) {
      const rate = Number(values.gstRatePct);
      if (!(ALLOWED_GST_RATES as readonly number[]).includes(rate)) {
        throw new BadRequestException(`GST rate must be one of ${ALLOWED_GST_RATES.join(', ')}%.`);
      }
      values.gstRatePct = String(rate);
    }

    await this.dataSource.transaction((m) => writeSupplierSettings(m, values, actorId));
    this.logger.log(
      `[COMPANY_SETTINGS] updated ${Object.keys(values).join(', ')} by ${actorId ?? 'unknown'}`,
    );
    return this.get();
  }
}
