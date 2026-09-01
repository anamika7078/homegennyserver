import { Injectable, NotFoundException, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { createHmac, timingSafeEqual } from 'crypto';
import { assertTransition } from '../../../common/finance/invoice-status';
import { CreditNoteService } from './credit-note.service';

export interface InvoicePayment {
  id: string;
  invoice_number: string;
  client_id: string;
  client_name: string;
  total_amount: string;
  paid_at: string | null;
  payment_ref: string | null;
  razorpay_order_id: string | null;
  status: string;
  due_date: string;
  created_at: string;
}

interface RazorpayWebhookEvent {
  event: string;
  payload: {
    payment?: { entity?: { order_id?: string; id?: string; amount?: number } };
    order?:   { entity?: { id?: string; receipt?: string } };
  };
}

@Injectable()
export class FinanceSettlementService {
  private readonly logger = new Logger(FinanceSettlementService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly creditNotes: CreditNoteService,
  ) {}

  /**
   * Verifies Razorpay's `X-Razorpay-Signature` against the raw request body.
   *
   * Without this the handler took the caller's word for it: anyone who knew
   * the endpoint URL could mark any invoice PAID by posting a plausible
   * payload with a guessed `razorpay_order_id`. Called before anything reads
   * or writes the database. See F-08 in docs/FINANCE_MODULE_AUDIT.md.
   */
  verifyWebhookSignature(rawBody: Buffer | string | undefined, signature: string | undefined): void {
    const secret = this.config.get<string>('app.razorpay.webhookSecret', '');

    // Refuse rather than fall through. An unconfigured secret previously meant
    // "accept everything"; it now means the webhook is closed until someone
    // sets RAZORPAY_WEBHOOK_SECRET.
    if (!secret || secret.startsWith('YOUR_')) {
      this.logger.error('[WEBHOOK] RAZORPAY_WEBHOOK_SECRET is not configured — rejecting.');
      throw new UnauthorizedException('Webhook signature verification is not configured.');
    }
    if (!rawBody || !signature) {
      throw new UnauthorizedException('Missing webhook body or signature.');
    }

    const expected = createHmac('sha256', secret)
      .update(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'))
      .digest('hex');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    // timingSafeEqual throws on a length mismatch, so check length first —
    // a wrong-length signature is simply invalid.
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.logger.warn('[WEBHOOK] Signature mismatch — rejecting.');
      throw new UnauthorizedException('Invalid webhook signature.');
    }
  }

  async listPayments(status?: string): Promise<InvoicePayment[]> {
    // finance_customers, not the legacy `clients` table — see the note in
    // invoice.service.ts getInvoice(). Same bug, same fix.
    let sql = `
      SELECT ci.id, ci.invoice_number, ci.client_id, c.customer_name AS client_name,
             ci.total_amount, ci.paid_at, ci.payment_ref, ci.razorpay_order_id,
             ci.status, ci.due_date, ci.created_at
      FROM client_invoices ci
      LEFT JOIN finance_customers c ON c.id = ci.client_id
    `;
    const params: unknown[] = [];
    if (status) {
      params.push(status.toUpperCase());
      sql += ` WHERE ci.status = $1`;
    }
    sql += ' ORDER BY ci.created_at DESC';
    return this.dataSource.query<InvoicePayment[]>(sql, params);
  }

  async matchWebhookEvent(body: RazorpayWebhookEvent) {
    this.logger.log(`[WEBHOOK] Event: ${body.event}`);

    if (body.event === 'payment.captured' || body.event === 'order.paid') {
      const orderId =
        body.payload?.payment?.entity?.order_id ??
        body.payload?.order?.entity?.id;
      const paymentId = body.payload?.payment?.entity?.id;

      if (!orderId) {
        this.logger.warn('[WEBHOOK] No order_id in payload');
        return { matched: false, reason: 'No order_id in payload' };
      }

      const rows = await this.dataSource.query<{ id: string; status: string; invoice_number: string }[]>(
        `SELECT id, status, invoice_number FROM client_invoices WHERE razorpay_order_id = $1`, [orderId],
      );
      if (!rows.length) {
        this.logger.warn(`[WEBHOOK] No invoice for order ${orderId}`);
        return { matched: false, reason: 'Invoice not found for order' };
      }

      const invoiceId = rows[0].id;

      // A webhook can arrive twice for the same payment, and Razorpay expects
      // a 2xx either way. Re-marking a PAID invoice is a no-op, not an error —
      // but anything else illegal (a credit-noted invoice being "paid") must
      // still be refused rather than silently overwritten. See F-12.
      const current = rows[0].status;
      if (current === 'PAID') {
        this.logger.log(`[WEBHOOK] Invoice ${invoiceId} already PAID — ignoring duplicate`);
        return { matched: true, invoice_id: invoiceId, payment_ref: paymentId, duplicate: true };
      }
      assertTransition(current, 'PAID', rows[0].invoice_number);

      await this.dataSource.query(
        `UPDATE client_invoices
         SET status = 'PAID', paid_at = NOW(), payment_ref = $1
         WHERE id = $2`,
        [paymentId ?? orderId, invoiceId],
      );
      this.logger.log(`[WEBHOOK] Matched invoice ${invoiceId} → PAID`);
      return { matched: true, invoice_id: invoiceId, payment_ref: paymentId };
    }

    return { matched: false, reason: `Unhandled event: ${body.event}` };
  }

  async markSettled(invoiceId: string, paymentRef: string) {
    const rows = await this.dataSource.query<{ id: string; status: string; invoice_number: string }[]>(
      `SELECT id, status, invoice_number FROM client_invoices WHERE id = $1`, [invoiceId],
    );
    if (!rows.length) throw new NotFoundException(`Invoice ${invoiceId} not found`);
    assertTransition(rows[0].status, 'PAID', rows[0].invoice_number);

    await this.dataSource.query(
      `UPDATE client_invoices
       SET status = 'PAID', paid_at = NOW(), payment_ref = $1
       WHERE id = $2`,
      [paymentRef, invoiceId],
    );
    return { invoice_id: invoiceId, status: 'PAID', payment_ref: paymentRef };
  }

  /**
   * Kept so existing callers keep working, but it now issues a real credit
   * note through `CreditNoteService` rather than flipping a status and
   * discarding the details. See F-18.
   */
  async issueCreditNote(invoiceId: string, reason: string, amount?: number, actorId?: string) {
    return this.creditNotes.issue(invoiceId, reason, amount, actorId);
  }

  async getSettlementStats() {
    const rows = await this.dataSource.query<{
      total_paid: string; total_pending: string;
      count_paid: string; count_pending: string; count_overdue: string;
    }[]>(
      `SELECT
        COALESCE(SUM(CASE WHEN status = 'PAID' THEN total_amount END), 0)  AS total_paid,
        COALESCE(SUM(CASE WHEN status != 'PAID' THEN total_amount END), 0) AS total_pending,
        COUNT(CASE WHEN status = 'PAID' THEN 1 END)                        AS count_paid,
        COUNT(CASE WHEN status != 'PAID' THEN 1 END)                       AS count_pending,
        COUNT(CASE WHEN status NOT IN ('PAID') AND due_date < NOW() THEN 1 END) AS count_overdue
       FROM client_invoices`,
    );
    return rows[0];
  }
}
