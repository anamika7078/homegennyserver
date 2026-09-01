import { round2 } from './statutory-calc.util';

/**
 * Turning a management fee into the tax lines an Indian invoice has to show.
 *
 * Two rules drive everything here:
 *
 *  1. **GST applies only to the management fee.** Salary and employer
 *     ESIC/PF are a reimbursement, not a supply, so they are never taxable.
 *     This is the same rule `statutory-calc.util.ts` enforces; here it decides
 *     what goes in the "taxable value" box.
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
  /** Anything the invoice still needs before it is a valid tax invoice. */
  missing: string[];
}

/** Normalises state names so "delhi" and " Delhi " compare equal. */
function normaliseState(state: string | null | undefined): string {
  return String(state ?? '').trim().toLowerCase();
}

/**
 * A GSTIN is 15 characters: 2-digit state code, 10-char PAN, entity digit,
 * 'Z', then a checksum character. Shape-checked only — this does not verify
 * the number exists.
 */
export function isValidGstin(gstin: string | null | undefined): boolean {
  if (!gstin) return false;
  return /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}$/.test(gstin.trim().toUpperCase());
}

export function computeGst(args: {
  managementFee: number;
  gstRatePct: number;
  supplier: SupplierTaxIdentity;
  recipientGstin: string | null;
  recipientState: string | null;
}): GstBreakdown {
  const { managementFee, gstRatePct, supplier, recipientState } = args;
  const missing: string[] = [];

  // Place of supply for a service to a registered business is the recipient's
  // location; falling back to the supplier's state keeps intra-state maths
  // right when the customer record has no state yet.
  const placeOfSupply = recipientState?.trim() || supplier.state?.trim() || null;
  if (!recipientState?.trim()) missing.push("recipient's state");
  if (!supplier.state?.trim()) missing.push("supplier's state");
  if (!supplier.sacCode?.trim()) missing.push('SAC code');
  if (!isValidGstin(supplier.gstin)) missing.push('supplier GSTIN');

  const taxableValue = round2(managementFee);

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
      missing,
    };
  }

  const isInterState =
    Boolean(placeOfSupply) &&
    Boolean(supplier.state) &&
    normaliseState(placeOfSupply) !== normaliseState(supplier.state);

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
