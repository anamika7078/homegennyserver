import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { round2 } from '../../../common/finance/statutory-calc.util';
import { assertTransition } from '../../../common/finance/invoice-status';

/**
 * Credit notes as real documents.
 *
 * Issuing one used to set `client_invoices.status = 'CREDIT_NOTE'` and return
 * an object that was never stored — no number, no amount, no GST reversal, no
 * audit trail. The original invoice also kept counting at full value in every
 * report, so revenue never reflected the reversal. See F-18.
 *
 * A credit note under GST is its own document with its own series, and it
 * reverses tax in proportion to the value it reverses — you cannot credit the
 * fee back and quietly keep the GST charged on it.
 */

interface InvoiceForCredit {
  id: string; invoice_number: string; client_id: string; status: string;
  total_amount: string; taxable_value: string; credited_amount: string;
  cgst_amount: string; sgst_amount: string; igst_amount: string;
  supplier_gstin: string | null; recipient_gstin: string | null; place_of_supply: string | null;
}

@Injectable()
export class CreditNoteService {
  private readonly logger = new Logger(CreditNoteService.name);

  constructor(private readonly dataSource: DataSource) {}

  private async loadInvoice(invoiceId: string): Promise<InvoiceForCredit> {
    const rows = await this.dataSource.query<InvoiceForCredit[]>(
      `SELECT id, invoice_number, client_id, status, total_amount, taxable_value,
              credited_amount, cgst_amount, sgst_amount, igst_amount,
              supplier_gstin, recipient_gstin, place_of_supply
       FROM client_invoices WHERE id = $1`,
      [invoiceId],
    );
    if (!rows.length) throw new NotFoundException(`Invoice ${invoiceId} not found`);
    return rows[0];
  }

  /**
   * What crediting this invoice would produce, without issuing anything or
   * consuming a number from the series.
   *
   * @param amount Omit for a full reversal of whatever is still uncredited.
   */
  /**
   * Statuses an invoice can be credited from.
   *
   * You credit a document the client has actually received; an invoice still
   * in DRAFT or APPROVED has been issued to nobody, so it gets **cancelled**,
   * not credited. Enforcing this here rather than only on the status
   * transition closes an inconsistency: a partial credit against a DRAFT used
   * to slip through unchecked, while the credit that completed it was refused.
   */
  private static readonly CREDITABLE_FROM = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'];

  async preview(invoiceId: string, amount?: number) {
    const inv = await this.loadInvoice(invoiceId);

    if (!CreditNoteService.CREDITABLE_FROM.includes(inv.status)) {
      throw new BadRequestException(
        `Invoice ${inv.invoice_number} is ${inv.status} and cannot be credited. ` +
        `Credit notes apply to an invoice the client has received (${CreditNoteService.CREDITABLE_FROM.join(', ')}); ` +
        `cancel it instead if it was never sent.`,
      );
    }

    const invoiceTotal = round2(parseFloat(inv.total_amount));
    const alreadyCredited = round2(parseFloat(inv.credited_amount ?? '0'));
    const remaining = round2(invoiceTotal - alreadyCredited);

    if (remaining <= 0) {
      throw new BadRequestException(
        `Invoice ${inv.invoice_number} has already been fully credited (${alreadyCredited}).`,
      );
    }

    const creditAmount = amount == null ? remaining : round2(amount);
    if (creditAmount <= 0) {
      throw new BadRequestException('A credit note must be for a positive amount.');
    }
    if (creditAmount > remaining) {
      throw new BadRequestException(
        `Cannot credit ${creditAmount}: only ${remaining} of invoice ${inv.invoice_number} remains uncredited.`,
      );
    }

    // Full only when it clears the entire invoice, not merely the remainder of
    // one already partly credited — the invoice's status turns on this.
    const isFull = alreadyCredited === 0 && Math.abs(creditAmount - invoiceTotal) <= 0.01;

    // Tax reverses in the same proportion as the value credited. GST only ever
    // sits on the management fee, so the taxable share of an invoice is rarely
    // the whole of it.
    const proportion = invoiceTotal > 0 ? creditAmount / invoiceTotal : 0;

    return {
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      client_id: inv.client_id,
      invoice_status: inv.status,
      invoice_total: invoiceTotal,
      already_credited: alreadyCredited,
      remaining_before: remaining,
      credit_amount: creditAmount,
      is_full_reversal: isFull,
      remaining_after: round2(remaining - creditAmount),
      tax_reversal: {
        taxable_value: round2(parseFloat(inv.taxable_value ?? '0') * proportion),
        cgst: round2(parseFloat(inv.cgst_amount ?? '0') * proportion),
        sgst: round2(parseFloat(inv.sgst_amount ?? '0') * proportion),
        igst: round2(parseFloat(inv.igst_amount ?? '0') * proportion),
      },
      supplier_gstin: inv.supplier_gstin,
      recipient_gstin: inv.recipient_gstin,
      place_of_supply: inv.place_of_supply,
    };
  }

  async issue(invoiceId: string, reason: string, amount?: number, actorId?: string) {
    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required to issue a credit note.');
    }

    const p = await this.preview(invoiceId, amount);

    // What closes the invoice is the *cumulative* credit reaching its total,
    // not whether this single note happened to reverse everything at once.
    // Keying the status off `is_full_reversal` left an invoice sitting in
    // DRAFT after two partial credits had between them reversed all of it.
    const fullyCredited =
      Math.abs((p.already_credited + p.credit_amount) - p.invoice_total) <= 0.01;

    if (fullyCredited) {
      assertTransition(p.invoice_status, 'CREDIT_NOTE', p.invoice_number);
    }

    const statusClause = fullyCredited ? ", status = 'CREDIT_NOTE'" : '';

    return this.dataSource.transaction(async (manager) => {
      // Own series per customer, taken inside the transaction so two notes
      // cannot share a number. TypeORM returns [rows, count] for
      // UPDATE ... RETURNING, so normalise rather than trust the shape.
      const seqResult = await manager.query(
        `UPDATE finance_customers SET credit_note_seq = credit_note_seq + 1
         WHERE id = $1 RETURNING bill_no_prefix, credit_note_seq`,
        [p.client_id],
      );
      const seqRows = (Array.isArray(seqResult[0]) ? seqResult[0] : seqResult) as
        { bill_no_prefix: string; credit_note_seq: number }[];
      const cust = seqRows[0];
      if (!cust?.credit_note_seq) {
        throw new BadRequestException(
          `Could not reserve a credit-note number for the customer on invoice ${p.invoice_number}.`,
        );
      }
      const prefix = (cust.bill_no_prefix || 'INV').trim().replace(/\/+$/, '');
      const creditNoteNumber = `CN/${prefix}/${String(cust.credit_note_seq).padStart(4, '0')}`;

      const noteResult = await manager.query(
        `INSERT INTO credit_notes
           (id, credit_note_number, credit_note_seq, invoice_id, client_id, reason,
            is_full_reversal, taxable_value, cgst_amount, sgst_amount, igst_amount,
            total_amount, supplier_gstin, recipient_gstin, place_of_supply, issued_by)
         VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [
          creditNoteNumber, cust.credit_note_seq, p.invoice_id, p.client_id, reason.trim(),
          p.is_full_reversal, p.tax_reversal.taxable_value,
          p.tax_reversal.cgst, p.tax_reversal.sgst, p.tax_reversal.igst,
          p.credit_amount, p.supplier_gstin, p.recipient_gstin, p.place_of_supply,
          actorId ?? null,
        ],
      );
      const noteRows = (Array.isArray(noteResult[0]) ? noteResult[0] : noteResult) as Record<string, unknown>[];

      await manager.query(
        `UPDATE client_invoices
         SET credited_amount = credited_amount + $1${statusClause}
         WHERE id = $2`,
        [p.credit_amount, p.invoice_id],
      );

      this.logger.log(
        `[CREDIT_NOTE] ${creditNoteNumber} against ${p.invoice_number} — ` +
        `${p.credit_amount} (${p.is_full_reversal ? 'full' : 'partial'}) by ${actorId ?? 'unknown'}`,
      );

      return {
        credit_note: noteRows[0],
        credit_note_number: creditNoteNumber,
        original_invoice_id: p.invoice_id,
        original_invoice_number: p.invoice_number,
        credit_amount: p.credit_amount,
        // Whether this one note reversed the whole invoice…
        is_full_reversal: p.is_full_reversal,
        // …versus whether the invoice is now fully credited, which several
        // partial notes can achieve between them. Only the second closes it.
        invoice_fully_credited: fullyCredited,
        tax_reversed: p.tax_reversal,
        remaining_on_invoice: p.remaining_after,
        reason: reason.trim(),
      };
    });
  }

  /**
   * Credit notes, optionally filtered.
   *
   * Accepts either a bare client id or a filter object: the controller has
   * been written both ways, and a compatibility shim here is cheaper than
   * the two files disagreeing about the signature.
   */
  async list(filter?: string | { invoiceId?: string; clientId?: string }) {
    const f = typeof filter === 'string' ? { clientId: filter } : (filter ?? {});
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (f.invoiceId) { params.push(f.invoiceId); clauses.push(`cn.invoice_id = $${params.length}`); }
    if (f.clientId) { params.push(f.clientId); clauses.push(`cn.client_id = $${params.length}`); }

    return this.dataSource.query(
      `SELECT cn.*, ci.invoice_number AS original_invoice_number,
              ci.total_amount AS original_invoice_total, fc.customer_name
       FROM credit_notes cn
       JOIN client_invoices ci ON ci.id = cn.invoice_id
       LEFT JOIN finance_customers fc ON fc.id = cn.client_id
       ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
       ORDER BY cn.created_at DESC`,
      params,
    );
  }

  /** One credit note by its own id. */
  async getOne(id: string) {
    const rows = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT cn.*, ci.invoice_number AS original_invoice_number,
              ci.total_amount AS original_invoice_total,
              ci.period_month, ci.period_year, fc.customer_name
       FROM credit_notes cn
       JOIN client_invoices ci ON ci.id = cn.invoice_id
       LEFT JOIN finance_customers fc ON fc.id = cn.client_id
       WHERE cn.id = `,
      [id],
    );
    if (!rows.length) throw new NotFoundException(`Credit note ${id} not found`);
    return rows[0];
  }

  /** Every credit note against one invoice — partial credits mean there can be several. */
  async getForInvoice(invoiceId: string) {
    return this.list({ invoiceId });
  }
}
