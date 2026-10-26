import { round2 } from './statutory-calc.util';

/**
 * Turning the amount a client is charged into the tax lines an Indian
 * invoice has to show.
 *
 * Two rules drive everything here:
 *
 *  1. **GST applies to the whole consideration** — wages, employer ESIC and
 *     PF, and the management fee. Manpower supply is taxed on the full
 *     contract value; the fee-only reading needed a pure-agent relationship
 *     that does not exist here. The caller decides the base, so a genuine
 *     pure-agent reimbursement can still be left out by passing less.
 *  2. **Same state → CGST + SGST, different state → IGST.** The comparison is
 *     between the supplier's state and the place of supply.
 *
 * Where the supplier has no GSTIN yet, the document is a **Bill of Supply**
 * rather than a Tax Invoice and carries no tax at all. That is the correct
 * document for an unregistered supplier — not a workaround, and not something
 * to fake a GSTIN for. See F-14 in docs/FINANCE_MODULE_AUDIT.md.
 */

export type InvoiceDocumentType = 'TAX_INVOICE' | 'BILL_OF_SUPPLY';

export interface SupplierTaxIdentity {
  legalName: string;
  gstin: string | null;
  state: string | null;
  sacCode: string | null;
}

export interface GstBreakdown {
  documentType: InvoiceDocumentType;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalTax: number;
  placeOfSupply: string | null;
  isInterState: boolean;
  /** False when the recipient's state could not be resolved to a GST state code. */
  placeOfSupplyKnown: boolean;
  /** The rate applied; 0 on a Bill of Supply. */
  gstRatePct: number;
  /** Anything the invoice still needs before it is a valid tax invoice. */
  missing: string[];
}

/**
 * GST state codes — the first two digits of every GSTIN.
 *
 * Intra- vs inter-state used to be decided by comparing state *names*, so
 * "New Delhi" against "Delhi", or "HR" against "Haryana", charged IGST on a
 * supply that never left the state. Both sides are resolved to this code
 * first and the codes are compared instead.
 */
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
  '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
  '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};

/** Spellings and abbreviations people actually type into a customer record. */
const STATE_ALIASES: Record<string, string> = {
  'new delhi': '07', 'nct of delhi': '07', 'delhi ncr': '07', dl: '07',
  hr: '06', up: '09', mh: '27', ka: '29', tn: '33', wb: '19', rj: '08',
  pb: '03', gj: '24', mp: '23', ap: '37', ts: '36', tg: '36', uk: '05',
  hp: '02', jk: '01', 'j&k': '01', orissa: '21', pondicherry: '34',
  uttaranchal: '05', gurgaon: '06', gurugram: '06', noida: '09',
  'greater noida': '09', ghaziabad: '09', faridabad: '06',
};

function squash(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9& ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Resolves a state name, abbreviation, two-digit code or full GSTIN to its
 * GST state code. Returns null when it cannot tell — the caller treats that as
 * "place of supply unknown" rather than guessing.
 */
export function stateCodeOf(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (isValidGstin(raw)) return raw.slice(0, 2);
  if (/^\d{1,2}$/.test(raw)) {
    const code = raw.padStart(2, '0');
    return GST_STATE_CODES[code] ? code : null;
  }
  const s = squash(raw);
  if (STATE_ALIASES[s]) return STATE_ALIASES[s];
  for (const [code, name] of Object.entries(GST_STATE_CODES)) {
    if (squash(name) === s) return code;
  }
  return null;
}

/** "07" → "Delhi". */
export function stateNameOf(code: string | null | undefined): string | null {
  return code ? GST_STATE_CODES[code] ?? null : null;
}

/** GST rates the settings page accepts. */
export const ALLOWED_GST_RATES = [0, 5, 12, 18, 28] as const;

/**
 * A GSTIN is 15 characters: 2-digit state code, 10-char PAN, entity digit,
 * 'Z', then a checksum character. Shape-checked only — this does not verify
 * the number exists.
 */
export function isValidGstin(gstin: string | null | undefined): boolean {
  if (!gstin) return false;
  return /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}$/.test(gstin.trim().toUpperCase());
}

/**
 * GST on a supply of manpower.
 *
 * `taxableValue` is the whole consideration — wages, employer ESIC and PF, and
 * the management fee — not the fee alone. This used to take the fee only, on
 * the reading that the wages pass through as a pure agent under Rule 33. That
 * reading is hard to sustain for manpower supply, where the agency contracts
 * to provide the service and the worker is its own employee; the industry
 * bills the full amount, and so does every invoice HomeGenny is measured
 * against. Charging on the fee alone under-collects GST, and the shortfall is
 * the supplier's to make good.
 *
 * The caller decides what goes into the base, so a genuine pure-agent
 * reimbursement could still be excluded by passing a smaller figure.
 */
export function computeGst(args: {
  taxableValue: number;
  gstRatePct: number;
  supplier: SupplierTaxIdentity;
  recipientGstin: string | null;
  recipientState: string | null;
}): GstBreakdown {
  const { taxableValue: rawTaxable, gstRatePct, supplier, recipientGstin, recipientState } = args;
  const missing: string[] = [];

  // Place of supply is the recipient's location. A registered recipient's
  // GSTIN states it outright, so it wins over a free-text state field.
  //
  // There is deliberately no fallback to the supplier's state any more: that
  // turned every customer with a blank state into an intra-state supply and
  // charged CGST+SGST where IGST may have been due. An unknown place of supply
  // is reported, and `placeOfSupplyKnown` lets the caller refuse to issue.
  const recipientCode = isValidGstin(recipientGstin)
    ? stateCodeOf(recipientGstin)
    : stateCodeOf(recipientState);
  const supplierCode = isValidGstin(supplier.gstin)
    ? stateCodeOf(supplier.gstin)
    : stateCodeOf(supplier.state);
  const placeOfSupply = stateNameOf(recipientCode) ?? (recipientState?.trim() || null);

  if (!recipientCode) {
    missing.push(recipientState?.trim()
      ? `recipient's state ("${recipientState.trim()}" is not a recognised Indian state)`
      : "recipient's state");
  }
  if (!supplierCode) missing.push("supplier's state");
  if (!supplier.sacCode?.trim()) missing.push('SAC code');
  if (!isValidGstin(supplier.gstin)) missing.push('supplier GSTIN');

  const taxableValue = round2(rawTaxable);

  // No GSTIN means no tax can be charged, and the document is a Bill of
  // Supply. Charging GST without being registered to collect it would be
  // worse than issuing the simpler document.
  if (!isValidGstin(supplier.gstin)) {
    return {
      documentType: 'BILL_OF_SUPPLY',
      taxableValue,
      cgst: 0, sgst: 0, igst: 0, totalTax: 0,
      placeOfSupply,
      isInterState: false,
      placeOfSupplyKnown: Boolean(recipientCode),
      gstRatePct: 0,
      missing,
    };
  }

  const isInterState = Boolean(recipientCode && supplierCode && recipientCode !== supplierCode);

  const totalTax = round2(taxableValue * (gstRatePct / 100));

  // Halving can leave a paisa on the table; give it to CGST so the two halves
  // always add back to the total rather than drifting.
  const half = round2(totalTax / 2);
  const cgst = isInterState ? 0 : round2(totalTax - half);
  const sgst = isInterState ? 0 : half;
  const igst = isInterState ? totalTax : 0;

  return {
    documentType: 'TAX_INVOICE',
    taxableValue,
    cgst, sgst, igst, totalTax,
    placeOfSupply,
    isInterState,
    placeOfSupplyKnown: Boolean(recipientCode),
    gstRatePct,
    missing,
  };
}

/**
 * Builds the invoice number from the customer's own series.
 *
 * The old format was `INV-YYYYMM-<first 6 chars of a placement id>` — neither
 * sequential nor per-customer, which no tax authority accepts. `bill_seq` is
 * incremented inside the caller's transaction so two invoices cannot take the
 * same number.
 */
export function formatInvoiceNumber(prefix: string, seq: number): string {
  const clean = (prefix || 'INV').trim().replace(/\/+$/, '');
  return `${clean}/${String(seq).padStart(4, '0')}`;
}
