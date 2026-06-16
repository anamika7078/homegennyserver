import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

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

  constructor(private readonly dataSource: DataSource) {}

  async listPayments(status?: string): Promise<InvoicePayment[]> {
    let sql = `
      SELECT ci.id, ci.invoice_number, ci.client_id, c.full_name AS client_name,
             ci.total_amount, ci.paid_at, ci.payment_ref, ci.razorpay_order_id,
             ci.status, ci.due_date, ci.created_at
      FROM client_invoices ci
      LEFT JOIN clients c ON c.id::text = ci.client_id::text
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

      const rows = await this.dataSource.query<{ id: string }[]>(
        `SELECT id FROM client_invoices WHERE razorpay_order_id = $1`, [orderId],
      );
      if (!rows.length) {
        this.logger.warn(`[WEBHOOK] No invoice for order ${orderId}`);
        return { matched: false, reason: 'Invoice not found for order' };
      }

      const invoiceId = rows[0].id;
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
    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM client_invoices WHERE id = $1`, [invoiceId],
    );
    if (!rows.length) throw new NotFoundException(`Invoice ${invoiceId} not found`);

    await this.dataSource.query(
      `UPDATE client_invoices
       SET status = 'PAID', paid_at = NOW(), payment_ref = $1
       WHERE id = $2`,
      [paymentRef, invoiceId],
    );
    return { invoice_id: invoiceId, status: 'PAID', payment_ref: paymentRef };
  }

  async issueCreditNote(invoiceId: string, reason: string) {
    const rows = await this.dataSource.query<{ id: string; invoice_number: string; total_amount: string }[]>(
      `SELECT id, invoice_number, total_amount FROM client_invoices WHERE id = $1`, [invoiceId],
    );
    if (!rows.length) throw new NotFoundException(`Invoice ${invoiceId} not found`);
    const inv = rows[0];

    // Mark original as credit-noted
    await this.dataSource.query(
      `UPDATE client_invoices SET status = 'CREDIT_NOTE' WHERE id = $1`, [invoiceId],
    );

    this.logger.log(`[CREDIT_NOTE] Invoice ${inv.invoice_number} → reason: ${reason}`);
    return {
      original_invoice_id:     invoiceId,
      original_invoice_number: inv.invoice_number,
      credit_amount:           inv.total_amount,
      reason,
      status:                  'CREDIT_NOTE_ISSUED',
    };
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
