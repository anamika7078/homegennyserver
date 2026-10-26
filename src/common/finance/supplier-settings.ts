import { GST_RATE_DEFAULT } from './statutory-calc.util';
import { isValidGstin, type SupplierTaxIdentity } from './gst.util';

/**
 * HomeGenny's own identity as it has to appear on an invoice, read from
 * `system_settings`.
 *
 * This used to be read by three private copies of the same function — the
 * invoice generator, the invoice renderer and the payroll preview — and they
 * did not agree on what counted as "registered": the preview accepted any
 * non-empty GSTIN while the invoice checked its format, so a mistyped GSTIN
 * showed GST in the preview and issued a Bill of Supply without it.
 */

type Runner = { query<T = any>(sql: string, params?: unknown[]): Promise<T> };

/** setting key → field. The keys are what the deploy runbook already documents. */
export const SUPPLIER_SETTING_KEYS = {
  legalName: 'finance.supplier_legal_name',
  gstin: 'finance.supplier_gstin',
  state: 'finance.supplier_state',
  sacCode: 'finance.sac_code',
  address: 'finance.supplier_address',
  pan: 'finance.supplier_pan',
  gstRatePct: 'finance.gst_rate_pct',
  bankName: 'finance.bank_name',
  bankAccount: 'finance.bank_account',
  bankIfsc: 'finance.bank_ifsc',
  bankBranch: 'finance.bank_branch',
} as const;

export type SupplierSettingField = keyof typeof SUPPLIER_SETTING_KEYS;

export interface SupplierSettings extends SupplierTaxIdentity {
  address: string | null;
  pan: string | null;
  bankName: string | null;
  bankAccount: string | null;
  bankIfsc: string | null;
  bankBranch: string | null;
  /** The GST rate every invoice charges. 18 unless Finance has set another. */
  gstRatePct: number;
  /** True when invoices raised now will be Tax Invoices carrying GST. */
  isRegistered: boolean;
}

/** `value` is jsonb; older rows hold a JSON string, some hold a bare scalar. */
function unwrap(raw: unknown): string {
  if (raw == null) return '';
  const v = typeof raw === 'string' ? raw : String(raw);
  return v.replace(/^"|"$/g, '').trim();
}

export async function readSupplierSettings(runner: Runner): Promise<SupplierSettings> {
  const rows = await runner.query<{ key: string; value: unknown }[]>(
    `SELECT key, value FROM system_settings WHERE key LIKE 'finance.%'`,
  );
  const get = (field: SupplierSettingField): string | null => {
    const v = unwrap(rows.find((r) => r.key === SUPPLIER_SETTING_KEYS[field])?.value);
    return v ? v : null;
  };

  const rate = Number(get('gstRatePct'));
  const gstin = get('gstin');

  return {
    legalName: get('legalName') ?? 'HomeGenny',
    gstin,
    state: get('state'),
    sacCode: get('sacCode'),
    address: get('address'),
    pan: get('pan'),
    bankName: get('bankName'),
    bankAccount: get('bankAccount'),
    bankIfsc: get('bankIfsc'),
    bankBranch: get('bankBranch'),
    gstRatePct: Number.isFinite(rate) && get('gstRatePct') != null ? rate : GST_RATE_DEFAULT,
    isRegistered: isValidGstin(gstin),
  };
}

/**
 * Writes the given fields. `null` or an empty string clears one. The table's
 * `id` and `updated_at` have no defaults, so both are supplied here.
 */
export async function writeSupplierSettings(
  runner: Runner,
  values: Partial<Record<SupplierSettingField, string | number | null>>,
  actorId?: string | null,
): Promise<void> {
  for (const [field, value] of Object.entries(values)) {
    const key = SUPPLIER_SETTING_KEYS[field as SupplierSettingField];
    if (!key || value === undefined) continue;
    const text = value == null ? '' : String(value).trim();
    await runner.query(
      `INSERT INTO system_settings (id, key, value, description, updated_by, updated_at)
       VALUES (gen_random_uuid(), $1, to_jsonb($2::text), $3, $4, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [key, text, `Finance company/GST setting (${field})`, actorId ?? null],
    );
  }
}
