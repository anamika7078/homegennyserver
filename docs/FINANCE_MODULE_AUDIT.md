# Finance Module Audit — against the live pipeline

**Date:** 2026-08-31
**Scope:** `src/modules/finance/*`, `src/modules/payroll/*`, `src/modules/employee-salary`,
`src/modules/salary-structure`, `src/modules/employees/employee-payslip.service.ts`,
`src/modules/attendance/*`, `src/modules/cron/enterprise-cron.service.ts`,
`src/common/finance/statutory-calc.util.ts`, `prisma/schema.prisma`, and the web app's
`finance/*` + `hr/*` pages.

**Method:** static code review with `file:line` evidence for every finding.

> The findings below are backend. **Each phase in §6 also lists its web-app work** — the first
> version of this plan omitted that entirely, and F1 turned out to break three things in
> `homegenny/` that had to be fixed with it (see §9).

> **Status.** The audit itself was code review. **Phase F1 has since been implemented and
> live-verified, along with every other finding F-06 through F-20** — see §9 for what shipped, what the tests prove, and
> what is still blocked. `npm run test:finance` = 281 live checks against a running server and the
> real database. Findings not yet fixed remain code-review assertions.

> Cross-links: pipeline stages and who triggers what → [`RM_PIPELINE_PLAYBOOK.md`](./RM_PIPELINE_PLAYBOOK.md);
> spec-vs-actual gap list → [`PRODUCT_SPEC_REFERENCE.md`](./PRODUCT_SPEC_REFERENCE.md) (§4 has the
> hardcoded EOR payroll rules this audit checks against); prior platform audit →
> [`AUDIT_REPORT.md`](./AUDIT_REPORT.md).

---

## 0. Verdict

The **calculations are correct**. GST applies only to the management fee, ESIC respects the
₹21,000 wage limit, PF uses the ₹15,000 ceiling, and all three live in one shared util that
payroll / commercial / esic all delegate to. That part of the spec is faithfully implemented.

The problem is **plumbing**, and it has one root cause: **three separate payroll engines exist and
none of them knows about the others**. Almost every finding below traces back to that.

| Severity | Count | What it means |
|---|---|---|
| Critical | 6 | Money or data is actively wrong today — **all 6 fixed** |
| High | 7 | Compliance or control gap — **all 7 fixed** |
| Medium | 6 | Incomplete, or still manual — **all 6 fixed** |
| Dead tables | 11 | **Resolved** — 5 now written, 6 dropped (F-13) |
| Genuinely solid | 9 | Do not break these in the refactor |

**All 20 findings are fixed and live-verified.** Every Critical, every High, every Medium, plus
the two found while implementing (F-19, F-20).

What remains is not code. Three things need a decision or a credential from you, and no amount of
implementation closes them:

| What | Why it is blocked |
|---|---|
| RazorpayX credentials, and someone collecting staff bank account numbers | The payout rail is built and tested; it has nothing to send money through |
| Company GSTIN and SAC code, confirmed by your CA | Until set, invoices correctly issue as a Bill of Supply rather than a Tax Invoice |
| Confirming the seeded PT and income-tax slabs | Payroll runs meanwhile with every figure flagged unverified |

Realistic effort to production-grade: **5–7 weeks**, sequenced as F1–F5 in §6. **F1 is done**,
and F-06 through F-20 were all pulled forward with it — §9.

---

## 1. The three payroll engines

| Engine | Covers | Writes to | Attendance | Statutory | State |
|---|---|---|---|---|---|
| **EOR / field** (`payroll.service.ts`) | Deployed staff on a `CONFIRMED` placement | `payroll_records`, `client_invoices` | `staff_daily_attendance` — correct | ESIC + PF, both employee and employer sides | Works |
| **HR** (`runEmployeePayroll()`, same file) | Internal / office employees | `employee_payrolls` | `attendance` table — correct | Employee-side ESIC + PF only | Incomplete |
| **Enterprise batch** (`enterprise-payroll.service.ts`) | All active employees, with 3-tier approval | `payroll_processing_batches`, `payroll_details` | **Hardcoded 30/30** | PF, ESIC, PT, TDS + loans/advances — employee side only | Wrong |

A **fourth** engine exists in the schema and is never written by anything:
`payroll_batches` → `payroll_entries` → `payroll_payslips`. This matters because the HR payslip
bridge reads it (see F-04).

**Invoicing** only exists on the EOR path. `invoice.service.ts` fakes an invoice row for internal
HR payrolls by `UNION`-ing `employee_payrolls` into the invoice list under a synthetic
`PAY-YYYYMM-XXXXXX` number and the literal client name `'Internal HR'`. That is a display-level
convenience, not a ledger.

---

## 2. Finance's responsibilities — spec vs actual

Spec (`PRODUCT_SPEC_REFERENCE.md` §3) defines Finance as: EOR payroll cycle, ESIC/PF,
GST-compliant invoicing, Razorpay settlement, deposit tracking — with **no access to
pipeline/verification data at all**.

| Responsibility | Built today | Missing | State |
|---|---|---|---|
| Monthly payroll run | `POST /finance/payroll/attendance-generate`, `confirm-batch`, plus a 1st-of-month cron that runs every `CONFIRMED` placement automatically | No unified month-end close; three engines run independently; enterprise batch ignores attendance | Partial |
| Payroll approval | Enterprise batch: L1 HR → L2 Finance → L3 Admin, with role check *and* tier-order check enforced, then LOCK | EOR and HR payroll have **no approval at all** — a cron or one POST writes straight to the DB, and nothing locks | Partial |
| ESIC / PF filing | Challan + ECR with CSV export, and each row is independently recomputed so stale data gets flagged rather than silently filed | Reads `payroll_records` only — internal and enterprise employees never appear | Partial |
| GST invoicing | 18% on management fee only, enforced at API level, exactly per spec | GSTIN, HSN/SAC, place of supply, CGST/SGST vs IGST split, proper invoice series — none present. Line items don't reconcile to the total | Gap |
| Razorpay settlement | Order creation, webhook → PAID, manual mark-settled | No webhook signature verification; wrong API used for payouts | Gap |
| Deposit tracking | List, stats, and REFUND / FORFEITURE / PARTIAL_REFUND event endpoint | Reads a column nothing writes — the page is permanently empty | Gap |
| Commercial / quotation | Wage config, rate cards, quotations, calculator, approval flow | No link from an approved quotation to the placement's actual terms | Partial |
| Reports / analytics | Revenue, GST, ESIC-PF outflow, branch P&L, invoice aging — all live | Branch P&L formula is wrong; HR payroll cost absent everywhere | Partial |
| Stay out of pipeline data | Commercial and ESIC controllers are FINANCE + ADMIN only | Invoice, payroll, deposit, settlement, analytics all also grant RM and BM — spec says Finance-only | Loose |
| Exit / final settlement | — | Late-exit cancellation fee matrix and full & final settlement do not exist in any form | Missing |

---

## 3. Where Finance touches the pipeline

Finance is correctly not part of the day-to-day S1→S5 flow, but **four points in the pipeline
create money**, and those are Finance's inputs.

| Stage | Money event | What Finance needs | What actually happens |
|---|---|---|---|
| **S1 Intake** | Refundable deposit — DR ₹2,000 · SC ₹1,500 · UC ₹1,000 · Maid ₹500 | Deposit liability tracked through to refund/forfeit | Row created in `deposits`; Finance console reads a different place entirely → always empty |
| **S2–S3** | Verification and training cost (Aadhaar, DL, PV, medical, video storage) | Per-staff acquisition cost, so the management fee can be priced against it | Not tracked anywhere |
| **S4 Agreements** | **The real commercial moment.** A1 fixes salary/deductions; the placement's `staff_salary` + `management_fee` get set | Terms should derive from an approved rate card, and Finance should be able to lock them | RM types them freely, or fills the wage-breakup form. No link to the commercial module's approved rate cards |
| **S5 Deploy** | Daily attendance → billable days → monthly payroll + client invoice | Approved attendance, correct pro-ration, GST invoice, disbursement | The best-built part of the system. Shift approval → attendance row → cron invoice all works |
| **Exit / Terminal** | Late-exit fee, deposit refund or forfeiture, final month pro-rata | One full & final settlement statement | Writes a metadata flag. No calculation, no money, no statement |

### The single biggest design gap

Finance's **only input from the pipeline** is the placement's `staff_salary` +
`management_fee`, and today an RM can type any number into them. The commercial module's approved
rate cards have no enforcement power. An RM entering ₹500 instead of ₹5,000 for the fee destroys a
year of margin on that placement with nothing to stop it. This should be the core of Phase F2.

---

## 4. The calculation flow

All formulas live in `src/common/finance/statutory-calc.util.ts` and are shared by payroll,
commercial, and esic. This is good architecture — each module used to hold its own copy and they
had diverged.

| Component | Formula | Rule |
|---|---|---|
| Pro-rated gross | `monthly_salary × (billable_days ÷ days_in_month)` | billable = PRESENT + OVERTIME |
| Pro-rated fee | `management_fee × (billable_days ÷ days_in_month)` | fee pro-rates on the same days |
| ESIC employee | `gross × 0.75%` | only when gross ≤ ₹21,000 |
| ESIC employer | `gross × 3.25%` | only when gross ≤ ₹21,000 |
| PF employee | `min(gross, ₹15,000) × 12%` | ceiling, not a cliff |
| PF employer | `min(gross, ₹15,000) × 12%` | same base, same rate |
| **Net salary** | `gross − ESIC(emp) − PF(emp)` | no other deductions per spec |
| GST | `management_fee × 18%` | **fee only** — never salary |
| **Client total** | `gross + ESIC(er) + PF(er) + fee + GST` | one consolidated charge |

Note `calculatePfFlat()`'s header comment: the spec's PF wording is genuinely ambiguous ("12% on
first ₹15,000" vs "applies when salary ≤ ₹15,000"). The util implements the **ceiling** reading,
which was the audited baseline. `commercial.service.ts` deliberately does *not* use it — it prices
a wage *category* for a quotation on a config-driven base, which is a business decision left open
rather than silently resolved.

### Worked example — SC staff, ₹18,000 salary, ₹4,500 fee, 26 billable days of 30

| Step | Calculation | Amount |
|---|---|---:|
| Pro-rated gross | `18,000 × 26/30` | ₹15,600.00 |
| Pro-rated management fee | `4,500 × 26/30` | ₹3,900.00 |
| ESIC employee (0.75%) | `15,600 × 0.0075` | −₹117.00 |
| PF employee (12% of 15k cap) | `15,000 × 0.12` | −₹1,800.00 |
| **Net salary — paid to staff** | `15,600 − 117 − 1,800` | **₹13,683.00** |
| ESIC employer (3.25%) | `15,600 × 0.0325` | ₹507.00 |
| PF employer (12%) | `15,000 × 0.12` | ₹1,800.00 |
| GST on fee (18%) | `3,900 × 0.18` | ₹702.00 |
| **Client total charge** | `15,600 + 507 + 1,800 + 3,900 + 702` | **₹22,509.00** |
| HomeGenny gross margin | fee only — GST is a pass-through | ₹3,900.00 |

**This example exposes F-03 directly.** The invoice prints four line items — salary ₹15,600, fee
₹3,900, GST ₹702, total ₹22,509. The first three sum to **₹20,202**, which is **₹2,307 short** of
the stated total. That ₹2,307 is employer ESIC + PF: billed to the client, itemised nowhere.

### End-to-end flow

```
S4/RM                S5/daily              1st/cron
placement terms  →   attendance       →    payroll run     →  ┌─ payroll_records ──→ salary slip (HR)
staff_salary         shift approved →      pro-rate +          │                      ✗ BROKEN (F-04)
management_fee       staff_daily_          ESIC/PF             │
                     attendance            runAttendance       └─ client_invoices ──→ Razorpay order
                                           Payroll()                                  → webhook → PAID
                                                                                      ✗ unsigned (F-08)
```

Internal HR employees follow the same path with the first two boxes swapped for
`employees.salary` + the `attendance` table, and no client-side branch at all.

---

## 5. Findings

### Critical — money or data is wrong today

#### F-01 · Enterprise payroll ignores attendance entirely

`enterprise-payroll.service.ts:83–86` hardcodes `workingDays = 30` and `presentDays = 30`, so
`prorationRatio` is always exactly 1. Overtime, bonuses, reimbursements and loan EMIs are all read
correctly from their tables — attendance alone is a constant.

The web UI (`finance/payroll/components/processing-pipeline-tab.tsx`) advertises
"Auto-calculates attendance proration" and "synchronize attendance from HR". No such code path
exists. An employee present 4 days receives a full month's salary, and all three approval tiers
will pass it because the number looks ordinary.

**Fix:** `PayrollService.countAttendanceForEmployee()` already exists and is correct. Call it and
populate `presentDays` / `lwpDays` / `prorationRatio` from it. Roughly one day of work.

#### F-02 · Invoices never join to their own client

`Placement.clientId` points at `finance_customers` — confirmed by
`placement.service.ts:92` (`prisma.financeCustomer.findUnique`). That id is copied into
`client_invoices.client_id` at invoice creation. But `invoice.service.ts:61,132` and
`settlement.service.ts:38` all `LEFT JOIN clients c` — the legacy `ClientProfile` table
(`schema.prisma:150`, `@@map("clients")`).

Two different tables, two different UUID spaces. The join can never match. Result: client name is
blank on the invoice list, the invoice detail, the generated invoice HTML, and the settlements
list. And the GST-capable customer master — which already holds `gstn`, `pan_card`,
`bill_no_prefix`, `bill_seq` — is not connected to invoicing at all.

This is the same root-cause class already fixed for `agreements` / SOW / indemnity
(see `PRODUCT_SPEC_REFERENCE.md` §6). Invoices were missed.

**Fix:** repoint all three joins at `finance_customers`, selecting `customer_name`, `gstn`,
`pan_card`.

#### F-03 · Invoice line items do not reconcile to the invoice total

`invoice.service.ts:147–152` builds four line items: salary, fee, GST, total. Employer ESIC and
employer PF are inside `total_amount` but appear in no line item, and `client_invoices` has no
columns for them (`schema.prisma:493`) — so they cannot be recovered by regenerating the invoice
either.

Separately, the `InvoiceItem` model / `invoice_items` table (`schema.prisma:860`) is never written
by any code. The whole line-item mechanism is dead.

**Fix:** add `esic_employer` + `pf_employer` columns to `client_invoices` via an additive SQL
migration, have the invoice writer populate real `invoice_items` rows, and assert that the sum of
line items equals `total_amount` before commit.

#### F-04 · EOR staff payslips can never reach the HR module

`EmployeePayslipService` merges three sources. Its `FIELD_PAYROLL` source reads
`prisma.payrollEntry` — the `payroll_entries` table (`employee-payslip.service.ts:81`). The actual
EOR payroll writes to `payroll_records` (`payroll.service.ts:305` and `:426`). **Nothing anywhere
in the codebase ever writes `payroll_entries`.**

So the "payroll completes → payslip appears in HR" flow already works for internal HR employees,
and will never work for deployed field staff no matter how correctly their payroll runs.

**Fix, two options.** Small: repoint `FIELD_PAYROLL` at `payroll_records`, joining through
`employees.staff_applicant_id` (already exists, `schema.prisma:1087`). Correct: make the EOR
payroll write `payroll_batches` / `payroll_entries` so it also gains batching and approval —
this is what Phase F3 does anyway.

#### F-05 · The Finance Deposits page is permanently empty

Intake creates the deposit in the `deposits` table (`rm.service.ts:361`,
`prisma.deposit.create`). `DepositService` queries
`FROM staff_applicants WHERE deposit_amount > 0` (`deposit.service.ts:65`), and
`staff_applicants.deposit_amount` defaults to `0` (`schema.prisma:120`) with **no writer anywhere**.

List, stats and the FORFEITED filter all return zero, always. Deposit events are also written to
`staff_applicants.metadata` rather than onto the `deposits` row they describe.

**Fix:** move `DepositService` onto the `deposits` table and record events there. Remove both
deposit columns from `staff_applicants` — the dual representation is the root cause. (Same failure
shape as the series enum dual representation that has caused silent prod bugs before.)

#### F-19 · Recalculating a draft payroll batch deducts every loan EMI again · CRITICAL

*Found while implementing F1, not in the original review pass.*

`processEnterpriseBatch()` supports re-running a batch for a month that is still DRAFT / PENDING /
REJECTED — the UI's "Run 10-Step Pipeline" button does exactly this. On re-run it deletes the
previous `payroll_details` and recomputes them (`enterprise-payroll.service.ts:54–58`), but the
loan loop at `:163–177` does `remainingAmount -= emi` against the live `employee_loans` row every
single time.

Payroll details are rebuilt from scratch; the loan balance is not. So each recalculation
permanently takes another EMI off the employee's outstanding loan. Three recalculations of one
month's payroll silently repay three months of loan.

Salary advances escape this only by accident — they are filtered on `status: ACTIVE` and the first
run closes them, so the second run no longer sees them. Loans stay ACTIVE until zero, so they are
hit every time.

**Fixed and live-verified** — see §9. Recovery is now a consequence of the batch being **locked**,
not of it being calculated: the draft records which loan owes what in
`payroll_details.recovery_breakdown`, and `lockBatch()` replays exactly those figures inside the
same transaction that locks the batch, stamped with `recoveries_applied_at` so it cannot run twice.

---

### High — compliance and control gaps

#### F-06 · ESIC challan and PF ECR cover EOR staff only · FIXED

**Fixed and live-verified.** Both filings now read one `UNION` across all three engines —
`payroll_records` (EOR), `employee_payrolls` (HR) and `payroll_details` (enterprise) — and every
row, response and CSV line names the engine it came from. Only enterprise batches in `APPROVED` or
`LOCKED` state are included: filing a draft would commit to figures nobody signed off.

A detail worth keeping: PF is reconciled against **the base each engine actually used**, not always
gross. Checking enterprise rows against gross would have flagged every one of them as
non-compliant for what is a policy difference, burying the real mismatches. See F-20.

The reconciliation control proved itself during verification — it flagged three seeded EOR rows
(`priya001`, `ramesh001`, `lakshmi001`) carrying ESIC of 165/650 regardless of gross, when a
₹25,000 gross should attract none at all. Those are genuine bad rows, and the live test asserts
only that *its own* rows are clean rather than demanding a silent challan.

#### F-20 · The engines compute PF on different bases · FIXED

**Fixed and live-verified — and it was worse than first documented: there were _three_ bases, not
two.**

- `wage-calculator.util.ts` and `commercial.service.ts` quoted the client PF on
  `basic + skilled allowance + leave wages`, storing it as `wage_breakup.pfBase`.
- `enterprise-payroll.service.ts` deducted on `min(basic, 15000)`.
- `payroll.service.ts` deducted on `min(gross, 15000)`.

So payroll could deduct a different figure from the one quoted to the client for the same person.
That — not "gross versus basic" — was the actual defect.

There is one rule underneath, and it is now the only one: **PF is computed on the agreed base, and
where no breakdown exists the whole wage is that base.** Statutorily the base is basic + DA; for a
maid or driver on a single undifferentiated wage the whole wage *is* the basic, so the EOR path's
"gross" was right for staff without a breakup and wrong for the ones with it. `resolvePfBase()` in
`StatutoryTaxService` applies this, and both payroll engines call it.

`pf.base_rule` makes the choice explicit — `AGREED_BASE` (default) or `GROSS` for the legacy
behaviour — and `GET /finance/tax/pf-base` reports what switching would cost, per placement.

**On today's data it costs nothing, and the report says so plainly.** Three confirmed placements
carry an agreed PF base, but every one sits above the ₹15,000 ceiling, so both rules cap to the
same ₹1,800. The divergence was real but latent; it starts costing money the moment someone is
placed below the ceiling. An earlier draft of the report said "no placement carries an agreed
base", which was wrong — identical figures are not the same as missing data, and the note now
distinguishes them.

#### F-20 (original finding text)

*Found while implementing F-06.*

The enterprise batch computes PF on `min(basic, 15000)`; the EOR and HR paths compute it on
`min(gross, 15000)`. Both are defensible readings — the statutory base is basic, but the EOR path's
behaviour is the audited baseline described in `statutory-calc.util.ts` — and they produce
different numbers for the same person.

Nothing was changed here. Picking one is a policy decision with money attached, and it belongs to
the F3 consolidation, not to a bug fix. Until then the challan carries each row's own base so the
filing is at least arithmetically honest about it.

#### F-06 (original finding text)

Both filings read `payroll_records` alone (`esic.service.ts:88` and `:136`). Internal employees
(`employee_payrolls`) and enterprise batch employees (`payroll_details`) never appear in a
government filing. That is under-reporting, and it carries penalties.

**Fix:** UNION all three sources — `FinancePayrollService.listPayrollRuns()` already demonstrates
the pattern.

#### F-07 · Enterprise payroll never computes employer contributions · FIXED

**Fixed and live-verified.** Both engines now compute and store the employer side.
`payroll_details` gained `esic_employer` / `pf_employer`; `employee_payrolls` gained all four
statutory columns, so a filing can aggregate them without parsing the deductions JSON.

`getStatutoryCompliance()` now separates the two halves — what was withheld from salaries versus
what the company owes on top — and reports `totalStatutoryLiability` as the sum. It previously
returned only the withheld half while reading as the whole bill.

`enterprise-payroll.service.ts:149–153` computes employee-side PF and ESIC only. The employer's
matching 12% PF and 3.25% ESIC — the company's actual liability — is neither computed nor stored,
so `getStatutoryCompliance()` (`:533–546`) reports less than the real outflow.

**Fix:** `calculatePfFlat()` and `calculateEsic()` already return both sides. Store the employer
values; add the columns additively.

#### F-08 · Razorpay webhook signature is never verified

`matchWebhookEvent()` (`settlement.service.ts:49–83`) trusts the request body directly. No
`X-Razorpay-Signature` header check, no HMAC against the webhook secret. Anyone who knows the
endpoint URL can mark any invoice PAID by guessing a `razorpay_order_id`.

**Fix:** verify HMAC-SHA256 over the raw body against the webhook secret and return 400 on
mismatch, before touching the database.

#### F-09 · Salary disbursement uses the wrong Razorpay API · FIXED

**Fixed and live-verified.** A new `PayoutService` uses **RazorpayX Payouts** — Contact → Fund
Account → Payout, with the payroll id as the idempotency key so a retry after a timeout cannot pay
twice. `razorpay.orders.create()` is gone from the disbursement path entirely.

Three behaviours changed beyond the API swap:

- **`disbursed_at` is stamped only when the payout actually settles.** RazorpayX settles
  asynchronously, so PROCESSING and SIMULATED both leave it null. "Has this person been paid?" now
  has an honest answer.
- **An unconfigured rail refuses to pretend.** Without `RAZORPAYX_ACCOUNT_NUMBER` the result is
  recorded as `SIMULATED`, never PAID, and the response says which environment variable is missing.
- **No bank account means no payout.** `staff_bank_accounts` is the new home for pipeline staff
  bank details (they only existed for HR employees). The IFSC shape and account number are
  validated on save, the number is returned masked to the last four digits, and replacing the
  details clears the cached RazorpayX fund account bound to the old ones.

**Still blocked on you:** RazorpayX credentials, and someone actually collecting account numbers
from staff. Both are outside the code.

#### F-12 · EOR payroll and invoices have no approval or lock · FIXED

**Fixed and live-verified.** Invoice transitions live in
`src/common/finance/invoice-status.ts` — DRAFT → APPROVED → SENT → PARTIALLY_PAID / PAID, with
OVERDUE, CREDIT_NOTE and CANCELLED. PAID and CREDIT_NOTE are terminal. Every mutation path
(`approve`, `send`, `mark-settled`, `credit-note`, and the Razorpay webhook) asserts the move
first, and the error names what *is* possible from the current state rather than just refusing.

A duplicate webhook for an already-PAID invoice is treated as a no-op rather than an error, because
Razorpay retries and expects a 2xx — but an illegal move, such as "paying" a credit-noted invoice,
is still refused.

EOR payroll gained `status` / `approved_by` / `approved_at` / `locked_at`. A newly generated record
is PENDING, approval locks it, and **disbursement refuses anything that is not APPROVED**. Newly
generated invoices now start at DRAFT rather than PENDING, which was never a state anyone had
agreed to.

`client_invoices.status` and `payroll_records.status` both carry a database `CHECK` constraint, so
the vocabulary holds even against a direct SQL write. A Postgres enum was deliberately *not* used:
the columns hold live data and `npm start` runs `prisma db push --accept-data-loss`, which is
exactly the combination that eats rows.

#### F-09 / F-12 (original finding text)

`triggerDisbursement()` (`finance/payroll/payroll.service.ts:481–511`) calls
`razorpay.orders.create()`. An order **collects** money; paying staff needs the RazorpayX Payouts
API with a fund account. Staff bank details are not stored anywhere for pipeline staff — only
`EmployeeSalaryProfile` has them, and that is HR-side.

Worse, `disbursed_at` is set even when the fallback simulated order is used, so the system reports
"paid" when no money moved.

**Fix:** move to Payouts. Until then, only set `disbursed_at` on a real reference, and keep a
distinct `SIMULATED` status for the fallback.

#### F-10 · Branch P&L formula is wrong — every branch shows a loss · FIXED

**Fixed and live-verified.** `getBranchPnl()` now reports the EOR model honestly:
`revenue` is the management fee alone; `gst_collected` is broken out as the liability it is;
`pass_through` (salary + employer ESIC/PF) is shown separately because the client reimburses it;
`client_billed` is the invoice total; `internal_payroll_cost` brings in the branch's own employees,
which the old query ignored entirely; and `contribution` = revenue − internal payroll.

Confirmed against real data: Delhi NCR HQ reports **+₹6,000** contribution on ₹6,000 of fees. The
old formula reported **−₹17,920** for the same branch (`6,000 + 1,080 − 25,000`). The live test
asserts the old number is not reproduced.

`analytics.service.ts:89–92` computes `revenue = management_fee + gst_amount` and
`gross_profit = management_fee + gst_amount − staff_salary_component`. Two errors: GST is a
liability, not revenue; and staff salary is reimbursed by the client, so subtracting it from
fee-only revenue is meaningless.

On the worked example above this reports **−₹10,998** instead of **₹3,900**. Every branch will
look heavily loss-making.

**Fix:** `revenue = management_fee`. `gross_profit = management_fee − (acquisition + operating
cost)`. Show GST as a separate liability line.

#### F-11 · HR payroll ignores loans, advances, bonuses, overtime and reimbursements

`runEmployeePayroll()` (`payroll.service.ts:595–635`) is salary × days and nothing else. All those
modules exist and the enterprise batch reads them (`enterprise-payroll.service.ts:115–194`); the
HR path does not.

Running the same employee for the same month through both paths produces two different numbers,
and both persist.

**Fixed and live-verified**, ahead of the F3 consolidation rather than waiting for it.
`previewEmployeePayroll()` now reads approved overtime, bonuses and reimbursements into gross, and
applies professional tax, TDS, loan EMI and advance recovery on the deduction side — the same
components, from the same tables, as the enterprise batch. `employee_payrolls.deductions` stores
every line rather than just ESIC and PF, so the payslip shows them.

Loan and advance balances are **calculated but not moved** here, following F-19: this path has no
lock step, so recovery stays the enterprise batch's job at lock. The preview returns
`recovery_applied: false` and a `recovery_breakdown` saying which loan the figure came from. The
live test asserts the balance is untouched after both preview and generate.

#### F-12 · EOR payroll and invoices have no approval or lock

The enterprise batch has a good 3-tier workflow. The EOR path — where the actual client money is —
writes straight to the DB from a cron or a single POST with no review, and nothing is ever locked.

`Invoice.status` is free-text `VARCHAR(20)` (`schema.prisma:506`), not an enum, with no state
machine (`invoice.service.ts:242–295`). PENDING → PAID → PENDING is all permitted.

**Fix:** add an `InvoiceStatus` enum with enforced transitions; move EOR payroll behind batching
and approval.

---

### Medium — incomplete or still manual

#### F-13 · Eleven finance tables exist in the schema with no writer · FIXED

**Fixed and live-verified.** Every one of the eleven is now either written or gone — the middle
state is exactly what produced F-04, where a bridge assumed `payroll_entries` was populated.

*Now written:* `invoice_items` (F-03), `esic_reports` and `pf_reports` (generating a challan or ECR
records the filing, its totals, its mismatch count and its per-engine breakdown, upserted by
period so re-generating updates rather than duplicates), `payment_reminders` (the overdue cron
records each chase, unique per invoice and day).

*Dropped:* `payroll_batches`, `payroll_entries`, `payroll_payslips` (the dead fourth engine),
`refunds` (superseded by the deposit event columns from F-05), `salary_ledgers`,
`branch_financial_reports` (branch P&L is computed live — F-10). The migration only drops a table
after checking it is empty, so it cannot destroy data even if someone starts using one first.

*Kept:* `payslip_documents`, which F4 fills when a batch locks.

The overdue cron was also broken independently of the table: it ran monthly against
`status = 'PENDING'`, a status F-12 removed and which would have matched nothing once an invoice
was sent. It now runs daily against SENT / PARTIALLY_PAID / OVERDUE, chases on the spec's day
1/3/7 marks and weekly after that, and flips an overdue invoice to OVERDUE.

#### F-14 · GST invoice compliance fields are absent · FIXED

**Fixed and live-verified.** `common/finance/gst.util.ts` computes the tax lines an Indian invoice
needs, and the invoice now stores supplier and recipient GSTIN, both states, place of supply, SAC
code, taxable value and a CGST/SGST **or** IGST split — chosen by comparing the supplier's state to
the place of supply.

**On the missing GSTIN:** rather than blocking, an unregistered supplier issues a **Bill of
Supply**, which is the correct document, and the invoice flips to **Tax Invoice** the moment a
valid GSTIN is set. No GST is charged in the meantime, and the preview lists exactly what is still
missing. The supplier's identity lives in `system_settings` (`finance.supplier_gstin`,
`finance.supplier_state`, `finance.sac_code`, `finance.supplier_legal_name`), seeded empty —
**a GSTIN and SAC code are tax facts to be confirmed with a CA, not values to invent.**

Invoice numbers now come from the customer's own `bill_no_prefix` + `bill_seq`, incremented inside
the issuing transaction so two runs cannot collide. The old
`INV-YYYYMM-<first 6 chars of a placement id>` was neither sequential nor per-customer.

#### F-15 · One client with three staff gets three separate invoices · FIXED

**Fixed and live-verified.** `ConsolidatedInvoiceService` issues **one invoice per customer per
month**. Each staff member becomes a line-item group (salary, employer ESIC, employer PF,
management fee), only the fee is taxable, and every `payroll_records` row is linked to the invoice
that billed it so the same work cannot be billed twice.

`client_invoices.placement_id` is now nullable, because a consolidated invoice belongs to no single
placement. The management fee is re-pro-rated from the payroll's own `shift_days` rather than
billed as a full month — billing a whole month's fee against a part-month's salary would quietly
overcharge.

Preview and issue are separate endpoints: previewing computes the whole document without consuming
a number from the customer's series.

#### F-13 / F-14 / F-15 (original finding text)

`invoice_items`, `payment_reminders`, `refunds`, `salary_ledgers`, `esic_reports`, `pf_reports`,
`branch_financial_reports`, `payroll_batches`, `payroll_entries`, `payroll_payslips`,
`payslip_documents`.

These are dangerous precisely because their names imply a working feature. F-04 happened for
exactly this reason — the payslip bridge assumed `payroll_entries` was populated.

**Fix:** decide per table — populate it or drop it. No middle state.

#### F-14 · GST invoice compliance fields are absent

A valid Indian tax invoice needs supplier and recipient GSTIN, HSN/SAC code, place of supply,
taxable value, CGST/SGST or IGST split, and a continuous series. The current invoice number is
`INV-YYYYMM-<first 6 chars of placement id>` (`payroll.service.ts:319,447`) — neither sequential
nor per-customer.

`finance_customers` already carries `bill_no_prefix` and `bill_seq` (`schema.prisma:1205–1206`).
`client_invoices` simply doesn't use them.

#### F-15 · One client with three staff gets three separate invoices

Invoices are per-placement. Spec (§4) says "one consolidated invoice". A client with a driver, a
cook and a maid receives three invoices with three unrelated numbers each month — none of which
carries their name (F-02).

#### F-16 · PT and TDS are approximations, not slabs · FIXED

**Fixed and live-verified.** `StatutoryTaxService` computes both from stored rules, and both
payroll engines now call it — so they cannot disagree.

**The consequential finding: professional tax is levied by the state, and Delhi and Haryana do not
levy it at all.** Every HomeGenny employee is in Delhi. The flat `gross > 15000 ? 200 : 0` had been
deducting ₹200 a month from each of them for a tax their state does not charge. Maharashtra does
levy it, including a higher figure in the last month of the financial year, and that is now
modelled properly. A state with no rule on file deducts nothing and is reported as **unknown** —
deliberately distinct from a state that levies nothing, because one is a data gap and the other is
a fact.

**TDS is now an annual projection**: annualise, subtract the standard deduction, apply the slabs,
check the 87A rebate, add cess, then spread what remains over the months left in the financial
year. The old flat 5% above ₹50,000 took ₹3,000 a month from someone earning ₹60,000 whose annual
income sits inside the rebate and who owes nothing at all. It also could not do the thing TDS must
do — deduct more later in the year, as fewer months remain to collect the same liability.

Rates live in `professional_tax_slabs`, `professional_tax_states` and `income_tax_slabs` rather
than in code, because they move with every Budget and nobody should redeploy to correct a slab.
**Everything seeded is flagged `needs_confirmation`**, the flag reaches the payslip and the batch
result, and `POST /finance/tax/confirm` is a deliberate, auditable sign-off. Only the three states
HomeGenny operates in are seeded — padding the table with states nobody works in would mean
shipping numbers nobody will ever check.

> **Still needs you:** confirm the Maharashtra slabs and the FY 2026-27 income-tax figures with
> your CA, then mark them verified. Payroll runs meanwhile, with every figure flagged.

**This change broke two assertions in the F-10/F-11 suite, and that was correct.** Those tests
asserted `professionalTax === 200` for an employee in a Delhi branch — encoding the flat rule
rather than the right answer. They now assert that PT follows the state and that the payslip
explains the figure. Worth noting as a pattern: a test that fails when a bug is fixed was testing
the bug.

#### F-17 · Late-exit fee and full & final settlement are not automated · FIXED

**Fixed and live-verified.** `ExitSettlementService` applies the spec's matrix — during trial,
mutual trial exit, extended-trial exit, and the under-30 / 30–90 / over-90-day post-confirmation
bands — and computes the whole statement: cancellation fee, final month's pro-rata from days
actually worked, goodwill, and the deposit.

Two design points worth keeping:

- **The two sides are never netted into one number.** The cancellation fee is owed by the *client*;
  goodwill and final pay are owed to the *staff member*. A single net figure would hide which party
  owes what.
- **Settling resolves the deposit in the same transaction** — refunded or forfeited per the band —
  rather than leaving it for someone to remember separately, which is how the deposit ledger drifted
  in the first place (F-05).

Terminated-for-cause sits outside the published matrix: no fee is charged to a client who did
nothing wrong, and the deposit is forfeited. `placements.confirmed_at` was added because the band
depends on how long after confirmation the exit happened and nothing recorded when confirmation
occurred; existing rows were backfilled from `updated_at` as the best available proxy.

#### F-16 / F-17 (original finding text)

`enterprise-payroll.service.ts:156–159`: professional tax is a flat ₹200 when gross > ₹15,000; TDS
is a flat 5% when gross > ₹50,000. PT is state-specific (the code comment concedes it is an
approximation); TDS depends on annual projection, exemptions and regime choice. These figures are
printed on payslips, and employees will treat them as accurate.

#### F-17 · Late-exit fee and full & final settlement are not automated

The spec's exit fee matrix (nil during trial; 30 days' salary post-confirm <30d; 15 days + 7 days
goodwill at 30–90d; 7 days + 15 days goodwill >90d) exists nowhere in code — already flagged as
open in `PRODUCT_SPEC_REFERENCE.md` §6. Exit writes `exit_date` and `exit_scenario_code` only.
Fee, deposit resolution and final pro-rata are all manual.

#### F-18 · Credit notes flip a status and leave no record · FIXED

**Fixed and live-verified.** A credit note is now a real document in `credit_notes`: its own number
from a **separate per-customer series** (mixing credit notes into the invoice series is what makes
a numbering audit fail), the reason, the amount, and a **proportional GST reversal** — crediting a
quarter of an invoice reverses a quarter of the tax that was charged on it.

**Partial credits are supported**, because a dispute is usually about one staff member's line
rather than the whole month. `client_invoices.credited_amount` carries the running total, and a
second credit cannot exceed what is left.

Two bugs surfaced while building it, both caught by the live test rather than review:

- **The invoice stayed DRAFT after two partial credits had between them reversed all of it.** The
  status was keyed off "this note is a full reversal" rather than "the invoice is now fully
  credited" — different questions. It now flips on the cumulative total.
- **A partial credit against a DRAFT invoice slipped through unchecked** while the credit that
  completed it was refused by the state machine. Crediting is now restricted to SENT /
  PARTIALLY_PAID / OVERDUE, with an error that says to cancel an unsent invoice instead. You credit
  a document the client has actually received.

Revenue is finally reported net of credits: each invoice contributes in proportion to the share of
it that has not been credited back, so a partial credit is visible rather than invisible.
`GET /finance/analytics/credit-notes` reports what was reversed per period, separately, so a month
with heavy credits reads as that rather than as a weak month.

#### F-20 · The two engines compute PF on different bases · RESOLVED

**Resolved and live-verified.** One rule now applies across every payroll path, driven by the
`pf.base_rule` setting, and `GET /finance/tax/pf-base` reports the rule in force plus what each
alternative would produce per placement — so the choice can be seen in rupees before it is made.

This one was a policy question, not a defect, which is why it was surfaced rather than silently
picked during a bug fix.

#### F-18 (original finding text) · FIXED

**Fixed and live-verified.** `CreditNoteService` issues a real document: its own number from a
per-customer series (`CN/<prefix>/0001`), the amount, the reason, who issued it, and the GST
reversed — all persisted in `credit_notes`.

Three things the old version got wrong, beyond not storing anything:

- **Tax now reverses in proportion.** GST only ever sits on the management fee, so crediting half
  an invoice reverses half its CGST/SGST, not half the total. You cannot credit the fee back and
  quietly keep the tax charged on it.
- **Partial credits are supported**, because a dispute is usually about one line rather than a
  whole month. A partial credit records `credited_amount` and leaves the invoice **payable for the
  balance**; only a full reversal moves it to `CREDIT_NOTE`. Credits accumulate, and the invoice
  refuses further credits once fully reversed.
- **Revenue nets the reversal off.** `getRevenueDashboard()` scales each invoice by the share of it
  that has not been credited, so the books no longer show income that was given back — and a
  partial credit, previously invisible, now shows up proportionally.

#### F-18 (original finding text)

`issueCreditNote()` (`settlement.service.ts:100–120`) sets the invoice status to `CREDIT_NOTE` and
returns an object that is never persisted. No credit note number, amount, GST reversal or audit
trail. The original invoice's amount still counts in full in analytics.

---

## 6. Implementation plan

Phases are ordered by dependency. F1 first, because everything after it would otherwise be built
on wrong data.

### Phase F1 — Correct the money · ~1 week · ✅ DONE (see §9)

> Also done ahead of schedule, because they were small and fully unblocked:
> **F-19** (critical, found during F1), **F-10** and **F-11** — both High, both originally
> scheduled for F3.

1. **Give the enterprise batch real attendance** (F-01). Call `countAttendanceForEmployee()` and
   populate `presentDays` / `lwpDays` / `prorationRatio`.
2. **Fix the invoice joins** (F-02). Repoint invoice + settlement at `finance_customers`; select
   GSTIN and PAN while there.
3. **Make invoices reconcile** (F-03). Additive migration for `esic_employer` + `pf_employer`,
   populate real `invoice_items`, assert line items sum to `total_amount`.
4. **Reconnect the payslip bridge** (F-04). Point `FIELD_PAYROLL` at `payroll_records` via
   `employees.staff_applicant_id`.
5. **Fix the deposit ledger** (F-05). Move `DepositService` onto `deposits`; deprecate the
   `staff_applicants` deposit columns.
6. **Secure the webhook** (F-08). HMAC verification before any DB write.

**Exit criteria:** run one real staff member through one real month end to end — attendance →
payroll → invoice (with client name, line items summing to the total) → payslip visible in HR.
Verified over live HTTP, not a clean `tsc`.

### Phase F2 — Compliance-grade invoicing and controlled pricing · ~1.5 weeks

1. **GST fields** (F-14): supplier/recipient GSTIN, SAC code, place of supply, taxable value,
   CGST+SGST vs IGST split determined by comparing states.
2. **Invoice series** from `finance_customers.bill_no_prefix` + `bill_seq`, incremented inside the
   transaction. Retire the placement-id-derived format.
3. **Consolidated invoicing** (F-15): one invoice per customer per month, each staff member a line
   item group.
4. **Invoice status enum + state machine** (F-12): DRAFT → APPROVED → SENT → PAID, plus
   PARTIALLY_PAID / OVERDUE / CREDIT_NOTED. Block reverse transitions.
5. **Credit notes as real records** (F-18): own number, amount, reason, GST reversal, link to the
   original.
6. **Bind rate cards to placements.** When an RM sets placement terms, validate against the
   approved rate card; out-of-range requires Finance approval. This is the control identified in
   §3 as entirely absent today.

**Frontend:** `finance/customers` needs GSTIN / state / place-of-supply fields on the form (both are
in the schema, almost every row has them null). `finance/invoices` needs the tax-invoice layout —
GSTIN of both parties, SAC, CGST/SGST vs IGST split — plus a credit-note action and the new status
chips. A settings screen (or seeded `system_settings` rows) for the supplier GSTIN and SAC code.
`rm/placements` needs the rate-card validation surfaced, so an out-of-range fee reads as "needs
Finance approval" rather than a silent 400.

**Exit criteria:** a CA accepts a generated invoice without asking for a missing field.

### Phase F3 — Three engines into one · ~2–3 weeks

The largest piece, but it closes F-06, F-07, F-11, F-12 and F-13 together. Make the enterprise
batch the single engine — it already has approval, loans, bonuses and overtime.

1. **Introduce employee type**: `INTERNAL` vs `FIELD_EOR`. Field attendance comes from the
   pipeline, internal from HR — the projection services already bridge both directions.
2. **Compute and store employer contributions** (F-07) for both types.
3. **Make client billing an output of the batch**: for `FIELD_EOR` employees, generate the invoice
   on batch lock rather than from a separate code path.
4. **Turn EOR and HR payroll into wrappers** over the batch — keep the existing endpoints so
   mobile and web don't break, but write to one place.
5. **Statutory filing from the unified batch** (F-06) — the UNION becomes unnecessary.
6. **Resolve the dead tables** (F-13).

**Frontend:** the Legacy Disbursement tab and the Enterprise Pipeline tab currently describe two
different engines; once there is one, they collapse into a single payroll screen with an
employee-type filter. `finance/payroll/employees` and the HR payroll page both need to stop
implying they are separate runs.

**Exit criteria:** running one employee for one month through two different paths yields the same
number — or the second path no longer exists.

### Phase F4 — Automation, payouts and exit settlement · ~1.5 weeks

1. **Month-end close pipeline**: attendance freeze → batch draft → approval reminders → lock →
   payslip + invoice generation → notifications. Cron-driven, with every step's status visible.
2. **Payslip auto-generation on LOCK** — render, store into `payslip_documents`, notify the staff
   member. Making the payslip a side effect of locking is what guarantees a draft's half-finished
   numbers never reach an employee.
3. **Real payouts** (F-09): RazorpayX Payouts, staff bank details stored, `disbursed_at` set only
   on a real reference.
4. **Payment reminders**: finally use `payment_reminders` — Day 1/3/7 to Finance, RM and Client
   per spec §5.
5. **Exit settlement engine** (F-17): fee matrix + deposit refund/forfeit + final pro-rata, in one
   full & final statement.
6. **Real PT and TDS** (F-16): state-wise PT table, proper TDS projection.

**Frontend:** a month-end close board (which branch is at which stage, what is blocked, whose
approval is pending) — this is the dashboard §7 says Finance actually needs and does not have. Plus
a payslip tab on the employee page, bank-detail capture on the employee form (nothing collects
account numbers today), and an exit-settlement screen.

**Exit criteria:** a full month closes with no manual step beyond three approval clicks.

### Phase F5 — Tighten access · ~2–3 days

1. Restrict invoice, payroll, settlement and deposit to FINANCE + ADMIN. Give RM/BM a read-only
   view through a separate endpoint.
2. Audit-log every finance mutation — ESIC/PF already does this, invoice/settlement/deposit do not.
3. Make locked batches and PAID invoices immutable at the DB level.

**Frontend:** hide the write actions RM/BM will start getting 403s on, rather than letting them
click into an error.

---

## 7. Reports and dashboards

### Exists

| Report | Purpose | State |
|---|---|---|
| Revenue trend (12 months) | Management fee income, GST collected, payroll cost | Works |
| GST summary | Monthly GST liability | Works |
| ESIC / PF outflow | Statutory outflow trend | EOR data only |
| Invoice aging | 0–30 / 31–60 / 60+ days overdue | Works |
| Branch P&L | Branch revenue and margin | Formula wrong (F-10) |
| Department breakdown | Enterprise batch cost by department | Works |
| Statutory compliance | PF/ESIC/PT/TDS totals | Employer side missing (F-07) |

### Needs building

| Report | Purpose |
|---|---|
| **Payroll register** | The month's master sheet — every employee, every column from gross to net. The first document any audit asks for. |
| **Cost-to-company per placement** | True cost of a staff member vs what the client is charged — where the real margin becomes visible. |
| **Receivables aging by client** | Not per invoice — per client. Who is holding how much. |
| **Deposit liability register** | How much is held, how much refund is due, how much was forfeited. |
| **Month-end close status** | One board: which branch's payroll is at which stage, what is blocked, whose approval is pending. |
| **GSTR-1 export** | Outward supply register in GST portal format. |
| **Disbursement reconciliation** | Net salary calculated vs actually paid from the bank, with the delta. |

### What the Finance dashboard should show

Today's dashboard shows revenue trend. What a Finance team needs daily is **what is stuck**, not
what was earned:

- This month's payroll stage, and whose approval it is waiting on
- Overdue invoice count, amount, and age of the oldest
- Statutory due-date countdowns — ESIC 15th, PF 15th, GST 20th
- `CONFIRMED` placements with no `staff_salary` / `management_fee` set — their payroll silently
  skips (`assertValidSalaryTerms` throws and the cron logs a warn, nothing surfaces)
- Payroll rows that fail recompute — `EsicService` already flags these and nothing displays them
- Deposit refunds that are due

---

## 8. What is genuinely solid

Do not break these during the refactor:

- **One statutory util** — GST, ESIC, PF in a single place, with the PF ambiguity documented rather
  than silently resolved. Modules had diverged before; they can't now.
- **Real segregation of duties in the 3-tier approval** — both role and tier order are enforced. A
  FINANCE token could previously approve the ADMIN tier first; that is closed.
- **Two-way attendance mirroring** — pipeline→HR and HR→pipeline, and it never overwrites a row a
  human marked.
- **Unified payslip service** — three sources, one list, PDF rendered from live data rather than a
  stored file. The design is right; one source is simply mis-wired.
- **ESIC/PF reconciliation** — every row is recomputed and mismatches are flagged, not silently
  corrected. Exactly right for a government filing.
- **Per-placement wage rates** — `wage_config` carries client-specific PF/ESIC/GST rates instead of
  a blanket default.
- **Duplicate guards** on both payroll paths (one was missing and was added).
- **NaN guard** — placements with NULL salary now fail before payroll. Postgres `NUMERIC` accepts
  the literal string `'NaN'`, so this was a real catch.
- **Auto-invoice cron** — every `CONFIRMED` placement invoices itself on the 1st, best-effort, one
  failure not blocking the rest.

---

## 9. Phase F1 — implementation report

Implemented and live-verified 2026-08-31, same day as the audit. Six findings fixed; one new
critical found while doing it.

### What changed

| Finding | Change | Files |
|---|---|---|
| **F-01** | Enterprise batch now reads real attendance through the same `countAttendanceForEmployee()` the HR path uses, instead of `workingDays = 30, presentDays = 30`. `PayrollService` injected rather than the logic copied, so the two engines cannot drift apart again. | `enterprise-payroll.service.ts` |
| **F-02** | Invoice detail, invoice list, settlements list and the Finance payroll lookup all join `finance_customers` instead of the legacy `clients` table. GSTIN/PAN/address carried through, which F2's tax-invoice work needs. | `invoice.service.ts`, `settlement.service.ts`, `finance/payroll/payroll.service.ts` |
| **F-03** | `client_invoices` gained `esic_employer` + `pf_employer`; both payroll paths now write real `invoice_items` rows through one shared `insertInvoiceWithItems()` helper, which **refuses to commit** if the items don't sum to the total. `getInvoice()` serves the stored items and returns a `reconciles` flag. | `payroll.service.ts`, `invoice.service.ts`, schema |
| **F-04** | Payslip bridge reads `payroll_records` (what the EOR payroll actually writes) instead of `payroll_entries` (which nothing has ever written). Deployed staff payslips now reach HR. | `employee-payslip.service.ts` |
| **F-05** | `DepositService` rewritten onto the `deposits` table. Events are recorded on the deposit row itself, with amount validation, double-resolution rejected, and a `refund_due_count` for deposits held against staff who have already exited. Prior events backfilled from `staff_applicants.metadata`. | `deposit.service.ts`, `deposit.controller.ts`, schema |
| **F-08** | Webhook verifies HMAC-SHA256 over the raw body against `RAZORPAY_WEBHOOK_SECRET`, before touching the database. An unset secret now **closes** the webhook rather than accepting everything. `rawBody: true` enabled so the signed bytes survive parsing. | `settlement.service.ts`, `settlement.controller.ts`, `main.ts`, `app.config.ts` |
| **F-19** | Loan/advance recovery moved out of calculation and into `lockBatch()`. The draft records the per-loan split in `payroll_details.recovery_breakdown`; the lock replays it in the same transaction that locks the batch, capped at the live balance and stamped `recoveries_applied_at` so it is idempotent. Recalculating a draft no longer moves a single rupee. | `enterprise-payroll.service.ts`, schema |
| **F-10** | Branch P&L rebuilt: fee is revenue, GST is a liability, reimbursed salary + employer contributions are `pass_through`, and the branch's own payroll is finally counted. Delhi NCR went from a reported −₹17,920 to its real +₹6,000. | `analytics.service.ts`, `finance/analytics` page |
| **F-11** | HR payroll reads overtime, bonuses, reimbursements, PT, TDS, loan EMI and advances — the same tables the enterprise batch reads — and stores every deduction line, not just ESIC and PF. Balances are computed, never moved (F-19 discipline). | `payroll.service.ts` |
| **F-07** | Both engines compute and store employer PF/ESIC; `payroll_details` and `employee_payrolls` gained the columns; the compliance report separates withheld from employer-owed and totals the real liability. | `enterprise-payroll.service.ts`, `payroll.service.ts`, schema |
| **F-06** | Challan and ECR `UNION` all three engines, label every row and CSV line with its source, and include only approved/locked batches. PF reconciles against each engine's own base. | `esic.service.ts`, `finance/esic-pf` page |
| **F-12** | Invoice state machine in `common/finance/invoice-status.ts`, enforced on every mutation path and backed by DB CHECK constraints. EOR payroll gained approval + lock; only an APPROVED record is payable. | `invoice-status.ts`, `invoice.service.ts`, `settlement.service.ts`, `payroll.service.ts`, schema |
| **F-09** | RazorpayX Payouts replace Orders, with idempotency on the payroll id. `disbursed_at` is stamped only on settlement; an unconfigured rail records SIMULATED and says which env var is missing. New `staff_bank_accounts` table with validation and masked reads. | `payout.service.ts`, `finance/payroll/*`, schema |
| **F-13** | Four tables now written (`invoice_items`, `esic_reports`, `pf_reports`, `payment_reminders`), six empty ones dropped after an emptiness check, `payslip_documents` kept for F4. The overdue cron was rewritten — it had been querying a status that no longer exists. | `esic.service.ts`, `enterprise-cron.service.ts`, schema |
| **F-14** | GST util computing taxable value and a CGST/SGST-or-IGST split; invoices store both parties' GSTIN, states, place of supply and SAC. Bill of Supply until a supplier GSTIN exists, Tax Invoice after. Numbers come from the customer's own series. | `gst.util.ts`, `consolidated-invoice.service.ts`, schema |
| **F-15** | One invoice per customer per month, each staff member a line-item group, every payroll row linked to the invoice that billed it. `placement_id` is now nullable. Fee re-pro-rated from the payroll's own days. | `consolidated-invoice.service.ts`, `finance/invoices/consolidated` page |
| **F-16** | PT from state rules (Delhi and Haryana levy none — every Delhi employee had been charged ₹200/month regardless); TDS from an annual projection with standard deduction, 87A rebate and cess, spread over the remaining FY months. Rates are data, flagged unconfirmed until Finance signs off. | `statutory-tax.service.ts`, both payroll engines, `finance/tax-rules` page |
| **F-17** | The spec's fee matrix computed, with final-month pro-rata, goodwill and deposit in one statement. Client-owed and staff-owed reported separately. Settling resolves the deposit in the same transaction. | `exit-settlement.service.ts`, `finance/exit-settlements` page |
| **F-18** | Credit notes are real documents with their own per-customer series, proportional GST reversal, and support for partial credits that leave the invoice payable for the balance. Revenue nets off what was credited. | `credit-note.service.ts`, `analytics.service.ts`, `finance/invoices` page |
| **F-20** | Three PF bases collapsed into one rule — the agreed base, with the whole wage used where no breakdown exists. `pf.base_rule` makes it explicit, and an impact report shows what switching costs. | `statutory-tax.service.ts`, both payroll engines, `finance/tax-rules` page |

### Web app changes (this audit originally missed them)

The audit and the F1–F5 plan were written **backend-only**. That was a gap: several backend fixes
change the API contract, and the web app breaks or hides information if it isn't updated with them.
Corrected for F1; every phase below now names its frontend work.

Fixed in `homegenny/` alongside the F1 backend work:

| Page | Was broken by | Change |
|---|---|---|
| `finance/deposits` | The F-05 rewrite renamed the response fields (`deposit_amount` → `amount`, `deposit_paid` → `status`) and the rows are now keyed by deposit id, not staff id | Reads the new field names; sends `staff_id` to the event endpoint (it was sending the deposit id, so **recording a refund had never actually worked**); adds a refund-amount input for PARTIAL_REFUND, which the API now requires; disables the action on an already-resolved deposit; stat tiles show Refunded and Refund Due |
| `finance/payroll` → Processing Pipeline | F-01 now excludes employees with no attendance | Shows who was left out and why, so a shorter run isn't mistaken for a smaller payroll |
| `lib/api/client.ts` | PARTIAL_REFUND now needs an amount | `recordDepositEvent()` takes and forwards `refundAmount` |
| `finance/analytics` | F-10 renamed the branch P&L fields, because the old ones named the wrong quantities | Columns are now Fee Revenue / Pass-through / Internal Payroll / Contribution, each with a tooltip saying what it means; a negative contribution renders red instead of green |
| `hr/payroll` and `finance/payroll/employees` | F-11 added professional tax, TDS, loan EMI and advance recovery, but both payslip modals listed only ESIC and PF before jumping to Net — so the deductions shown no longer explained the net paid | Both list every deduction, with a Total Deductions line; the Finance one also breaks the earnings side down (basic / overtime / bonus / reimbursement) so gross reconciles too |
| `finance/esic-pf` | F-06 made the filing span three engines, and F-07 gave enterprise rows a PF base that isn't gross | A Source column and per-engine chips in the header (with mismatch counts); the PF wage base is read from the row instead of re-derived from gross, which had misstated every enterprise row; the React key is now source-scoped, since one person can legitimately appear once per engine |
| `finance/payroll` → Dashboard | F-07 split the statutory total in two | The panel now reads Withheld from salaries / Employer contribution (with its PF and ESIC split) and a Total payable to authorities — it previously showed only the withheld half while reading as the whole bill |
| `finance/invoices` | F-12 replaced the status vocabulary (`PENDING` is gone; DRAFT, PARTIALLY_PAID, CANCELLED are new) | Tabs and badges cover the real set, and the Approve / Send / payment-link buttons are driven by a client-side copy of the transition table — a button the API would reject with a 400 is simply not rendered |
| `finance/payroll` → Disbursement | F-12 added the approval gate; F-09 made "paid" mean paid | Rows offer **Approve** before **Pay**; a banner warns up front when payouts are not live; the confirm dialog says whether real money will move; the badge distinguishes Simulated / Processing / Paid / Failed instead of treating any `disbursed_at` as Paid; failure reasons render inline |
| `finance/invoices/consolidated` *(new)* | F-15 and F-14 | Month-end worklist of customers with un-invoiced payroll, a full preview of the document before a number is consumed, per-staff line-item grouping, and a panel naming exactly what is still missing before it can be a Tax Invoice rather than a Bill of Supply. Linked from the Invoices header |
| `finance/tax-rules` *(new)* | F-16 | PT rules per state with "levies PT" / "no PT" stated plainly, the income-tax slabs, a live calculator that shows the figure *and the reason for it*, and an unmissable banner until Finance marks the rates verified |
| `finance/exit-settlements` *(new)* | F-17 | Worklist of exits with no settlement, a preview that names which band applied and why, owed-to-staff and owed-by-client shown side by side rather than netted, and the draft → approve → settle lifecycle |
| `finance/invoices` | F-18 | A Credit Note action on any invoice the state machine allows it for, with a reason field and an optional partial amount; the dialog says that GST reverses in the same proportion and that the invoice stays payable for the balance |
| `finance/tax-rules` | F-20 | A Provident Fund base panel: the rule in force, how many placements carry an agreed base, how many would actually deduct differently, and a per-placement table when any do |

The payslip **PDF** needed no change: `EmployeePayslipService` builds its breakdown generically
from the stored `deductions` JSON, so the new lines appear on their own. Verified live —
gross ₹25,000 − deductions ₹3,500 (PF 1,800 + PT 200 + loan EMI 1,500) = net ₹21,500, and the
breakdown the payslip endpoint returns sums to exactly that.

`finance/invoices` needed no change — it maps `line_items` generically, so the two new employer
rows render on their own, and `client_name` simply stops being blank.

**Two more surfaces found by sweeping for the same defects, and fixed:**

- **The client's own invoice screen had the F-03 bug too, and worse.**
  `GET /client/invoices` (client-mobile.controller.ts) returned salary + fee + GST + total, with
  employer ESIC/PF nowhere — so the paying customer saw a breakdown that came up short of the
  amount being demanded. Now returns `employerEsic` and `employerPf` alongside the rest.
- **Every staff detail page showed "₹0 Pending" for the deposit.**
  `staff/[id]` reads `deposit_amount` / `deposit_paid` off `staff_applicants`, the columns F-05
  established that nothing writes. `StaffService.findById()` now reads the staff member's actual
  deposit row and returns the real amount, paid flag and status.

Both are the F-03 / F-05 defects on surfaces the original audit did not sweep. Worth noting as a
method point: fixing a finding on the screen where it was *found* is not the same as fixing the
finding.

### Verification

`npm run test:finance` → **281 passed, 0 failed** across eight suites, against a running server and
the live database. Each creates its own data and deletes it afterwards.

A third suite, `_live_test_finance_f10_f11.js` (26 checks), covers the two findings pulled forward
from later phases: it asserts the branch P&L identities (`client_billed = revenue + GST +
pass_through`, `contribution = revenue − internal payroll`) and prints what the old formula would
have produced for the same branch; then builds an employee with overtime, a bonus, a
reimbursement and a loan, and asserts each one reaches gross or deductions, that the totals
reconcile, and that neither previewing nor generating moves the loan balance.

`_live_test_finance_f1.js` (42 checks) seeds 20 attendance days for a real confirmed placement,
runs the payroll, and asserts on the resulting invoice and payslip:

- Pro-ration is real — 20 of 31 days produced a pro-rated gross, not a full month's salary.
- The invoice resolves its client by name, in both the detail view and the list.
- Line items sum to the invoice total to the paisa (verified at ₹14,165.42), employer ESIC and PF
  are itemised, and the stored columns independently reconstruct the same total.
- A field/EOR payslip appears in the HR payslip list for the period just run, with net = gross −
  deductions, and downloads as a real PDF.
- The deposits list matches the row count in the `deposits` table (8), and stats report money
  collected.
- Deposit events work end to end on a throwaway deposit: a PARTIAL_REFUND without an amount is
  rejected, a refund larger than the deposit is rejected, a valid one persists onto the deposit
  row, a resolved deposit is not overwritten, and passing a *deposit* id where a *staff* id belongs
  404s — the mistake the web console was making.
- An unsigned webhook and a wrongly-signed webhook are both rejected with 401.

**Also confirmed on the real automated path.** The month rolled over to 2026-09-01 mid-session and
`autoGenerateAttendanceInvoices` fired on its own, raising three genuine August invoices. All three
carry populated employer ESIC/PF, five reconciling line items, and a resolved customer name — the
F1 fixes working in production code nobody triggered by hand. (Those three invoices also show F-15
in the wild: one client, three separate invoices for the same month.)

`_live_test_finance_f19.js` (20 checks) builds an isolated employee with a ₹5,000 loan
(₹1,000 EMI) and full attendance, then:

- Runs the draft batch **twice** and asserts the loan is still ₹5,000 — the bug reproduced against
  the old code, gone against the new.
- Asserts the EMI is still deducted on the payslip and the breakdown names the loan, so deferring
  recovery did not quietly stop charging it.
- Approves L1 HR → L2 Finance → L3 Admin, locks, and asserts the loan moves ₹5,000 → ₹4,000
  exactly once, with `recoveries_applied_at` stamped and a re-lock rejected.
- Asserts on every pass that **no pre-existing loan moved**, and refuses to lock at all if the
  batch's breakdown contains any loan other than its own — so running the suite can never recover
  against a real employee.

This second suite also gave F-01 its batch-level proof (`present_days` = 30 from real attendance
rows), which was unsafe to obtain before F-19 was fixed.

Existing suites still green: `npm run test:hr` → 89 passed, 0 failed. No regressions.

Two notes for whoever runs these next:

- **`/auth/login` allows 5 requests per minute per IP** (`AUTH_THROTTLE` in `auth.controller.ts`),
  and the suites run back to back. The npm script waits 65s — a full window — between them, and the
  F19 suite sends the TOTP in the first request rather than letting a discovery request fail first,
  which halves what an ADMIN login costs. Running out shows up as
  `Could not log in as 9800000003`, which reads like a broken account rather than a throttle — it
  is not.
- **ADMIN requires 2FA** (Phase 1 hardening), so the F19 suite reads `users.metadata.totp_secret`
  and computes the code itself. That works only because the test has direct database access, which
  is precisely what a real caller does not have; it is not a bypass in the auth path.

  This bites `npm run test:hr` too, which has no cooldowns between its four suites and predates
  the ones in `test:finance`. A suite reporting "3 passed, 10 failed" or "Could not log in" right
  after another suite is almost always the throttle, not a regression — running it on its own is
  the quickest way to tell the difference. Worth adding the same cooldowns there.

### Migration

`npm run migrate:finance` runs **all seven** migration scripts, in order — every one additive,
transactional, and safe to re-run. It was called `migrate:f1` while F1 was the only phase; the
name was corrected once it grew to cover every finding, because "f1" implied the other phases
still needed running separately. `migrate:f1` still works as an alias.

The seven, and what each covers:

| Script | Findings |
|---|---|
| `_f1_finance_migration.js` | F-03 invoice columns + `invoice_items`, F-05 deposit event columns and backfill |
| `_f19_recovery_migration.js` | F-19 `recovery_breakdown`, `recoveries_applied_at` |
| `_f06_f07_migration.js` | F-06 / F-07 employer contribution columns |
| `_f09_f12_migration.js` | F-09 `staff_bank_accounts`, F-12 payroll approval + invoice status CHECK |
| `_f13_f14_f15_migration.js` | F-13 drops and fills, F-14 GST fields, F-15 consolidated invoicing |
| `_f16_f17_migration.js` | F-16 tax rule tables, F-17 `exit_settlements` |
| `_f18_f20_migration.js` | F-18 `credit_notes`, F-20 PF base rule |

Detail on the first two, which carry backfills:

- `scratch/_f1_finance_migration.js` — the two invoice columns, the `invoice_items` table and
  index, the deposit event columns, and a backfill of deposit events from
  `staff_applicants.metadata`.
- `scratch/_f19_recovery_migration.js` — `payroll_details.recovery_breakdown` and
  `payroll_processing_batches.recoveries_applied_at`.

Deliberately **not** `prisma db push --accept-data-loss`.

### The `db push` hazard, and how it was closed

`npm start`, `npm run start:prod` and `npm run render:start` all run
`prisma db push --accept-data-loss` before booting. That command makes the database match
`schema.prisma` and, with that flag, does so **without asking** — anything in the database but not
in the schema is dropped.

Because the remediation created its tables through raw SQL, several of them were never declared in
`schema.prisma`. `prisma migrate diff` against the live database showed exactly what the next
deploy would have destroyed:

| Would have been dropped | Consequence |
|---|---|
| `credit_notes`, `exit_settlements`, `professional_tax_slabs`, `professional_tax_states`, `income_tax_slabs`, `employee_tax_profiles` | Six whole tables — every tax rule, credit note and exit settlement in the system |
| `finance_customer_branches` | A table `customer.service.ts` creates and writes at runtime |
| `finance_wage_config` — 11 columns | **21 rows of live wage configuration**: PF/ESIC/bonus/LWF/GST applicability, shift pattern, GST type |
| `client_invoices.credited_amount` | F-18's running credit total |
| `finance_customers.credit_note_seq` | The credit-note numbering series |
| `placements.confirmed_at` | What F-17's fee band is calculated from |

All of it is now declared in `schema.prisma`, matched field-for-field against the live columns. The
same diff now reports **zero** `DROP TABLE` and **zero** `DROP COLUMN`:

```
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel   prisma/schema.prisma --script | grep -E "DROP TABLE|DROP COLUMN"
# (no output)
```

Two of these — `finance_customer_branches` and the eleven `finance_wage_config` columns — predate
this work entirely, so that deploy hazard was already present before any of it.

**This is worth re-running as a standing check**, because the risk returns the moment anyone adds a
table or column by raw SQL without declaring it. `--accept-data-loss` on a boot path is still the
wrong default; replacing it with real migrations remains the right fix.

### Still open after F1

- **HR attendance is effectively empty — one row in the entire `attendance` table.** Before F-01
  the enterprise batch silently paid all 14 active employees a full month based on nothing. It now
  excludes them with `"No attendance marked for this period"` and returns the list. That is the
  correct behaviour, but it means **the enterprise payroll cannot produce anything until
  attendance is actually being captured.** This is an operational gap, not a code one.
- `RAZORPAY_WEBHOOK_SECRET` is unset, so the webhook currently refuses everything. Set it in the
  Razorpay dashboard and the environment before going live, or real payment callbacks will 401.
- Old fixture placements (`priya001`, `lakshmi001`, `ramesh001`) carry `client_id` values that
  point at the legacy `clients` table, so they still show a blank client name. Their invoices
  predate the finance-customer model; new invoices resolve correctly.
- `dashboard.service.ts` still counts `clients` for its "active clients" figure — same legacy
  table, but a display count rather than a money path, so it was left for F2.

---
*Audit by code review 2026-08-31. Phase F1 plus F-19, F-10, F-11, F-07, F-06, F-12 and F-09
implemented and live-verified 2026-08-31 / 09-01 — 281 HTTP-level checks, see §9. No finding
remains as an unverified assertion.*
