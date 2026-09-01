import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Sends money out, as opposed to collecting it.
 *
 * Disbursement used to call `razorpay.orders.create()`. An Order is a request
 * for a *customer to pay us* — it moves nothing toward the staff member, and
 * creating one and calling it a salary payment meant the system reported
 * "disbursed" while the money was still sitting in the account. Paying out
 * needs RazorpayX: a Contact, a Fund Account holding the bank details, and
 * then a Payout against it. See F-09 in docs/FINANCE_MODULE_AUDIT.md.
 *
 * RazorpayX is a separate product from the Razorpay checkout keys, with its
 * own account number. Until `RAZORPAYX_ACCOUNT_NUMBER` is configured this
 * service refuses to pretend: `isConfigured()` is false and callers record a
 * clearly-marked SIMULATED result instead of a payment that never happened.
 */

export interface BankAccountDetails {
  accountHolderName: string;
  accountNumber: string;
  ifsc: string;
  razorpayContactId?: string | null;
  razorpayFundAccountId?: string | null;
}

export interface PayoutResult {
  status: 'PROCESSING' | 'PAID' | 'SIMULATED';
  reference: string;
  contactId?: string;
  fundAccountId?: string;
  raw?: Record<string, unknown>;
}

const RAZORPAYX_BASE = 'https://api.razorpay.com/v1';

@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);

  constructor(private readonly config: ConfigService) {}

  /** True only when real payouts can actually be made. */
  isConfigured(): boolean {
    const keyId = this.config.get<string>('app.razorpay.keyId', '');
    const keySecret = this.config.get<string>('app.razorpay.keySecret', '');
    const accountNumber = this.config.get<string>('app.razorpay.xAccountNumber', '');
    return Boolean(
      keyId && !keyId.startsWith('YOUR_') &&
      keySecret && !keySecret.startsWith('YOUR_') &&
      accountNumber && !accountNumber.startsWith('YOUR_'),
    );
  }

  /** Human-readable reason the payout rail is unavailable, for the UI. */
  configurationHint(): string {
    if (this.isConfigured()) return '';
    const missing: string[] = [];
    const keyId = this.config.get<string>('app.razorpay.keyId', '');
    const keySecret = this.config.get<string>('app.razorpay.keySecret', '');
    const acct = this.config.get<string>('app.razorpay.xAccountNumber', '');
    if (!keyId || keyId.startsWith('YOUR_')) missing.push('RAZORPAY_KEY_ID');
    if (!keySecret || keySecret.startsWith('YOUR_')) missing.push('RAZORPAY_KEY_SECRET');
    if (!acct || acct.startsWith('YOUR_')) missing.push('RAZORPAYX_ACCOUNT_NUMBER');
    return `Payouts are not configured — set ${missing.join(', ')}.`;
  }

  private authHeader(): string {
    const keyId = this.config.get<string>('app.razorpay.keyId', '');
    const keySecret = this.config.get<string>('app.razorpay.keySecret', '');
    return 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  }

  private async call<T>(path: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const res = await fetch(`${RAZORPAYX_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader(),
        // RazorpayX honours this on payouts, so a retried request cannot pay
        // the same person twice.
        ...(idempotencyKey ? { 'X-Payout-Idempotency': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (json.error as { description?: string } | undefined)?.description ?? res.statusText;
      throw new BadRequestException(`RazorpayX ${path} failed: ${err}`);
    }
    return json as T;
  }

  /**
   * Ensures the staff member has a Contact and a Fund Account, creating them
   * only when they are missing. Both ids are meant to be stored back on the
   * bank account row so this is a no-op from the second payout onward.
   */
  private async ensureFundAccount(
    staffName: string,
    staffRef: string,
    bank: BankAccountDetails,
  ): Promise<{ contactId: string; fundAccountId: string }> {
    let contactId = bank.razorpayContactId ?? '';
    if (!contactId) {
      const contact = await this.call<{ id: string }>('/contacts', {
        name: staffName,
        type: 'employee',
        reference_id: staffRef,
      });
      contactId = contact.id;
    }

    let fundAccountId = bank.razorpayFundAccountId ?? '';
    if (!fundAccountId) {
      const fundAccount = await this.call<{ id: string }>('/fund_accounts', {
        contact_id: contactId,
        account_type: 'bank_account',
        bank_account: {
          name: bank.accountHolderName,
          ifsc: bank.ifsc,
          account_number: bank.accountNumber,
        },
      });
      fundAccountId = fundAccount.id;
    }

    return { contactId, fundAccountId };
  }

  /**
   * Pays one staff member.
   *
   * `payrollId` doubles as the idempotency key, so a retry after a timeout
   * resolves to the original payout instead of sending a second one.
   */
  async payout(args: {
    payrollId: string;
    staffName: string;
    staffRef: string;
    amount: number;
    bank: BankAccountDetails;
    narration?: string;
  }): Promise<PayoutResult> {
    if (args.amount <= 0) {
      throw new BadRequestException('Refusing to pay out a non-positive amount.');
    }

    if (!this.isConfigured()) {
      // Deliberately not an error: local and demo environments still need the
      // flow to run end to end. The caller records SIMULATED, never PAID, so
      // nothing downstream can mistake this for money having moved.
      this.logger.warn(`[PAYOUT] ${this.configurationHint()} Recording a simulated payout.`);
      return { status: 'SIMULATED', reference: `sim_payout_${args.payrollId.slice(0, 8)}_${Date.now()}` };
    }

    const { contactId, fundAccountId } = await this.ensureFundAccount(args.staffName, args.staffRef, args.bank);

    const payout = await this.call<{ id: string; status: string }>(
      '/payouts',
      {
        account_number: this.config.get<string>('app.razorpay.xAccountNumber', ''),
        fund_account_id: fundAccountId,
        amount: Math.round(args.amount * 100), // paise
        currency: 'INR',
        mode: 'IMPS',
        purpose: 'salary',
        queue_if_low_balance: true,
        reference_id: args.payrollId,
        narration: (args.narration ?? 'HomeGenny Salary').slice(0, 30),
      },
      args.payrollId,
    );

    // RazorpayX settles asynchronously: 'processed' is final, everything else
    // is still in flight and must not be reported as paid.
    const status = payout.status === 'processed' ? 'PAID' : 'PROCESSING';
    this.logger.log(`[PAYOUT] ${args.payrollId} → ${payout.id} (${payout.status})`);

    return { status, reference: payout.id, contactId, fundAccountId, raw: payout as unknown as Record<string, unknown> };
  }
}
