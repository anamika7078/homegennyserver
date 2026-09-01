import { BadRequestException } from '@nestjs/common';

/**
 * The states a client invoice can be in, and the only moves allowed between
 * them.
 *
 * `client_invoices.status` was a free-text VARCHAR with no rules, so PAID →
 * PENDING was as legal as anything else and nothing stopped an invoice being
 * "sent" twice or revived after a credit note. See F-12 in
 * docs/FINANCE_MODULE_AUDIT.md. The database carries a matching CHECK
 * constraint; this is where the *transitions* are enforced.
 */
export const INVOICE_STATUSES = [
  'DRAFT',
  'APPROVED',
  'SENT',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'CREDIT_NOTE',
  'CANCELLED',
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * OVERDUE is deliberately reachable only from SENT/PARTIALLY_PAID and returns
 * to the same payment path — it describes lateness, not a different document.
 * PAID and CREDIT_NOTE are terminal: money has moved or been reversed, and
 * re-opening either would silently rewrite what the client was told.
 */
const ALLOWED: Record<InvoiceStatus, InvoiceStatus[]> = {
  DRAFT:          ['APPROVED', 'CANCELLED'],
  APPROVED:       ['SENT', 'DRAFT', 'CANCELLED'],
  SENT:           ['PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CREDIT_NOTE', 'CANCELLED'],
  PARTIALLY_PAID: ['PAID', 'OVERDUE', 'CREDIT_NOTE'],
  OVERDUE:        ['PARTIALLY_PAID', 'PAID', 'CREDIT_NOTE', 'CANCELLED'],
  PAID:           [],
  CREDIT_NOTE:    [],
  CANCELLED:      [],
};

export function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return typeof value === 'string' && (INVOICE_STATUSES as readonly string[]).includes(value);
}

/** True when `to` is reachable from `from`. A no-op move is not a transition. */
export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

/**
 * Throws unless the move is legal, naming what *is* possible from here — an
 * error that only says "invalid" leaves the caller guessing.
 */
export function assertTransition(from: string, to: InvoiceStatus, invoiceNumber?: string): void {
  const label = invoiceNumber ? `Invoice ${invoiceNumber}` : 'Invoice';

  if (!isInvoiceStatus(from)) {
    throw new BadRequestException(
      `${label} has an unrecognised status "${from}". Expected one of ${INVOICE_STATUSES.join(', ')}.`,
    );
  }
  if (from === to) {
    throw new BadRequestException(`${label} is already ${to}.`);
  }
  if (!canTransition(from, to)) {
    const options = ALLOWED[from];
    throw new BadRequestException(
      options.length
        ? `${label} cannot go from ${from} to ${to}. Allowed from ${from}: ${options.join(', ')}.`
        : `${label} is ${from}, which is final — no further changes are possible.`,
    );
  }
}
