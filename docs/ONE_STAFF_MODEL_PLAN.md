# One staff, one client invoice — remediation plan

Written 2026-09-02, after the business model was settled in conversation:

> **There is only one kind of staff — the person RM assigns to a client.**
> That person moves through the pipeline, and at `S5_DEPLOY` becomes an HR
> employee. There are no separate internal office employees.
> **Invoices are issued per client, not per staff member.**

Everything below follows from those two sentences. Each claim carries the file
or query that establishes it, so the next person can check rather than trust.

---

## 1. What is already correct

Four things were built right and need no change. Worth knowing before touching
anything, so they are not rebuilt by accident.

**Consolidated invoicing exists.** `ConsolidatedInvoiceService` already issues
one invoice per customer per month, with each staff member as a line-item group
(salary, employer ESIC, employer PF, management fee), and GST only on the fee.
Its own header comment states the intent:

> *"A client with a driver, a cook and a maid used to receive three unrelated
> invoices every month, each with its own number — the spec has always said
> 'one consolidated invoice'."*

**The invoice is built from what was actually paid.** It reads the month's
`payroll_records`, so the invoice cannot disagree with the payslips.

**The customer ↔ placement link is sound.** `consolidated-invoice.service.ts`
joins on `p.client_id = finance_customers.id`. Verified against production: all
4 placements resolve to the one `finance_customers` row. The join works.

**The HR bridge exists.** `EmployeeOnboardingService.onboardFromPipeline()`
converts an `S5_DEPLOY` candidate into an `employees` row **with
`staffApplicantId` set**, refuses any candidate at an earlier stage, and refuses
to onboard the same person twice. This is exactly the model the business
described.

---

## 2. What contradicts the model today

### 2.1 The monthly cron issues one invoice per placement

`enterprise-cron.service.ts:41` loops over placements, not customers:

```js
const placements = await this.prisma.placement.findMany({
  where: { status: 'CONFIRMED' }, select: { id: true },
});
```

Each one goes down the older path in `payroll.service.ts:305`, which builds the
invoice number out of the **placement id**:

```js
const invoiceNo = `INV-${year}${month}-${placementId.slice(0,6).toUpperCase()}`;
```

So `ConsolidatedInvoiceService` is reachable only from a manual endpoint, while
the wrong path runs automatically on the 1st of every month. This already
happened: the cron fired on 2026-09-01 and produced three separate August
invoices.

**This is the most urgent item.** It repeats on 1 October.

### 2.2 There are two doors into `employees`

| Route | Frontend | Links to pipeline? |
|---|---|---|
| `onboardFromPipeline` | `hr/onboarding` | **yes** — sets `staffApplicantId` |
| `createEmployee` | `hr/employees/create` | **no** |

The second door is how production ended up with two employees whose
`staff_applicant_id` is `NULL`:

```
ANAMIKA001   Caretaker    salary 18000   staff_applicant_id = NULL
JJ001        Office Boy   salary 18000   staff_applicant_id = NULL
```

Their designations — *Caretaker*, *Office Boy* — are domestic-staff roles, not
office roles. And "Anamika Indore" exists twice: as `anamika002` in
`staff_applicants` and as `ANAMIKA001` in `employees`, with nothing joining them.

Under the settled model, **every** employee must come from the pipeline. An
employee with no `staffApplicantId` should not be creatable.

### 2.3 Three payroll engines for one population

| Engine | Table | Attendance source |
|---|---|---|
| Field / EOR | `payroll_records` | `shift_logs`, `staff_daily_attendance` |
| HR | `employee_payrolls` | `attendance` |
| Enterprise batch | `payroll_details` | `staff_daily_attendance` |

One person can be paid by more than one of these. Nothing prevents it. Today
production has 0 rows in all three, so no double payment has occurred — but the
exposure is real the moment payroll runs.

**`payroll_records` is the one to keep**, because the consolidated invoice is
built from it. Keeping either of the others as a second source of truth would
mean the invoice and the payslip could disagree.

### 2.4 The enterprise payroll module does not fit this business

The tab showing *Salary Structures*, *Employee Salaries & Bank* and a 10-step
approval pipeline is built for a company with internal salaried departments —
its own dashboard names *Engineering*, *Sales & Marketing*, *Human Resources*.
HomeGenny has none of these.

This module's 17 tables were never deployed to production. **That was correct,
not an oversight.** They should stay undeployed:

```
payroll_details            payroll_processing_batches   payroll_approval_workflows
payroll_settings           payslip_documents            bank_transfer_batches
salary_structures          salary_components            salary_revisions
employee_salary_profiles   employee_loans               salary_advances
bonus_records              overtime_records             overtime_rules
reimbursement_requests     right_to_refuse_log
```

### 2.5 The payroll dashboard invents numbers when the API fails

`payroll-dashboard-tab.tsx:42` falls back to hardcoded figures — ₹12,45,000
gross, 42 employees — whenever the API call fails, and every call is wrapped in
`.catch(() => null)`. Production has 2 employees and 0 payroll records. A
Finance user reading that screen sees a plausible, entirely fictional report.

### 2.6 The Commercial module is disconnected

`finance_wage_config` is read by `commercial.service.ts` and nothing else.
`finance_rate_cards` and `finance_commercial_calculations` are read nowhere
outside that module. The RM placement form starts from a hardcoded
`DEFAULT_WAGE_CONFIG` with `management_pct: '15'`, while Finance's configured
rate is **10%** across all 13 categories.

Real placements show a third and fourth answer: two with hand-typed fees and no
`wage_config` metadata at all, one recorded at 12%.

Production holds **0** calculations, **0** quotations, **0** rate cards.

---

## 3. Backend changes

> **Status, 2026-09-02.** B1, B2, B3, B4, F1, F2 and F4 are done and verified —
> 281 finance checks, 89 HR checks, and 10 new B1 checks, all passing against a
> clean build. B5 is waiting on a business answer; F3, B6 and F5 are not started.
>
> Two things found while verifying, both worth knowing:
>
> **The local database was behind `schema.prisma`.** `staff_applicants` was
> missing `aadhaar_number`, which made every Prisma read of that table throw and
> took 16 HR checks down with it. Nothing to do with this work — the column
> arrived in a merge and the local database was never updated, because the team
> avoids `db push`. Added locally; local now matches the schema exactly, with no
> missing tables or columns.
>
> **Several backend instances were fighting over port 3001** (`EADDRINUSE`), so
> an earlier "281 passed" was measured against a stale process and could not be
> trusted. Every result quoted here was re-measured against a single freshly
> built backend running `node dist/main`, with no watch-mode recompiles able to
> restart it mid-run.

### B1 — Point the monthly cron at the consolidated service — **DONE**

The cron now runs in the two passes the model actually has:

```
Pass 1: every CONFIRMED placement -> payroll   (each staff paid from own attendance)
Pass 2: every customer with un-invoiced payroll -> ONE invoice
```

Pass 1 calls the new `PayrollService.generateAttendancePayrollOnly()`, which
records payroll without touching invoices. Pass 2 uses
`ConsolidatedInvoiceService.pendingForPeriod()` and `generate()`. Both passes
are best-effort per row, so one bad placement or customer cannot block the
month's billing.

Verified by `scratch/_live_test_b1_consolidated_cron.js` — 10 checks, which
boot the real Nest context and call the real cron against a fixture of one
client with two placements. It asserts one invoice, numbered from the client
prefix, with both staff as line items, both payroll records linked, items
reconciling to the total, and no double-billing or double-payment on a second
run.

### B2 — Make double invoicing impossible — **DONE, local and production**

`scratch/_b2_one_invoice_per_client_migration.js` creates:

```sql
CREATE UNIQUE INDEX CONCURRENTLY uniq_client_invoice_period
  ON client_invoices (client_id, period_month, period_year)
  WHERE status <> 'CANCELLED';
```

It first checks whether stored data already violates the rule and, if so,
refuses and lists the offending client/period combinations rather than failing
half-way through building the index. Which of two existing invoices is the real
one is a business decision, not something a migration should pick.

The index is scoped to `is_consolidated = true`. On its first run it correctly
refused: local held seven, and production two, invoices issued under the old
one-per-placement model — real documents, some already SENT or APPROVED. Those
are history, and picking "which one was really the invoice" is not a choice a
script should make. Since B3 removed the per-placement writer, scoping the index
this way still constrains everything the system can now produce.

Verified by inserting a second consolidated invoice for a client and period that
already had one: Postgres rejected it with
`duplicate key value violates unique constraint "uniq_client_invoice_period"`.

**Production, 2026-09-02.** Period 9/2026 held three invoices for one client:
`BILL/202608/0002` (consolidated, SENT, ₹6,676.37, 4 line items, both payroll
records attached) and two per-placement leftovers — `INV-202609-2FC0CE` and
`INV-202609-59C1D6`, both DRAFT, **₹0.00**, with no payroll attached at all. The
real invoice had already absorbed both staff; the other two were debris from the
path B3 removed.

On the owner's instruction the two empty drafts were set to CANCELLED (not
deleted, so the record survives) and the index was created. Verified on
production the same way as local: a second consolidated invoice for an
already-invoiced client and period was rejected by Postgres.

### B3 — Retire the per-placement invoice path — **DONE**

`insertInvoiceWithItems()` is gone. It was the function that minted
`INV-<period>-<first 6 of placement id>`, and it was the only other writer of
`client_invoices`. **The consolidated service is now the single INSERT site in
the codebase.**

Both `runMonthlyPayroll()` and `runAttendancePayroll()` now record payroll and
then call the new `ConsolidatedInvoiceService.generateOrAmend()`, which:

- issues the client's invoice for the period if there is none, or
- **folds the new payroll into the DRAFT invoice already open**, keeping its id
  and number — a client told "your invoice is BILL/0007" must not find it
  renumbered — or
- refuses if that invoice is already APPROVED or SENT, pointing at a credit
  note. The client has seen that document; editing it silently would be wrong.

Billing happens outside the payroll transaction. If it fails, the payroll still
stands and the client is simply left un-invoiced for month-end to pick up —
refusing to record real work because billing is closed would be the wrong trade.

Two duplicate-run guards were also corrected. Both asked
`client_invoices WHERE placement_id = ?`, which a consolidated invoice always
leaves `NULL`, so both had silently stopped working. They now key off
`payroll_records`.

### B4 — Close the second door into `employees` — **DONE**

`POST /employees` now refuses a request with no `staffApplicantId`, and
validates it through the new `EmployeeOnboardingService.assertOnboardable()` —
candidate exists, is at `S5_DEPLOY`, and is not already onboarded. The rule
lives in one place because two endpoints enforce it.

The endpoint survives for HR corrections; what it can no longer do is mint an
employee belonging to no client. `employees.service.ts` carried a comment
saying "Direct HR hires leave it null" — exactly the assumption the business
has now overturned — which is corrected too.

Verified by the HR suite: 89 checks, 0 failures.

### B5 — Remove the orphan employees — **DONE on production**

The owner's call was to remove them, and investigation supported it: Anamika's
`staff_applicants` row (`anamika002`) had only reached **S2_VERIFY**, so she had
never been deployed and the employee record could not have been legitimate. Both
designations — *Caretaker*, *Office Boy* — are placed-staff roles.

`scratch/_b5_remove_orphan_employees.js` deletes employees with a null
`staff_applicant_id`, but **refuses** any that carry attendance, payroll,
documents or a tax profile: every FK into `employees` is `ON DELETE CASCADE`, and
losing real records as a side effect of tidying identity rows would be the wrong
trade. Production's two carried nothing. Local's orphans do, so the script
correctly refused there and local was left alone.

Production now has **0 employees, 0 orphans**. Anamika's pipeline record and her
staff login (`9975280366`, linked to `anamika002`) were untouched.

Logins are deliberately outside the script's remit — a `users` row has no FK to
`employees`. It reports which are left ownerless instead. That surfaced
`0808080809` (jj), created only for the deleted employee record, which was then
**deactivated** rather than deleted, on the owner's instruction, so its audit
trail survives.

### B6 — Settle on one payroll engine — **DONE**

The owner chose to retire `employee_payrolls`. That means **stop writing, keep
reading**: those rows are still read by payslips, ESIC and PF filings, analytics
and the invoice list, and closing those paths would lose historical records and
statutory reports. Both databases held zero rows when the writer was closed, so
nothing was lost either way.

Four changes:

1. **`runEmployeePayroll` refuses**, naming the person and pointing at the route
   that does work.
2. **An employee code now resolves to its placement.** `lookupByCode` joins
   `employees → staff_applicants → placements`, so an HR code and a staff code
   reach the same engine. This is what actually retires the second engine —
   closing the door alone would just have broken those users.
3. **TypeScript found the dead branches.** With nothing returning `EMPLOYEE` any
   more, the `EMPLOYEE` arms of `previewAttendanceByCode` and
   `generateAttendanceByCode` were unreachable, and so was the whole
   `INSERT INTO employee_payrolls` block. All removed. **No writer to that table
   remains anywhere in the codebase.**
4. **A third stale guard surfaced and was fixed.** `previewAttendanceByCode`
   still asked `client_invoices WHERE placement_id = ?` to decide whether a
   period had already been run — always empty for a consolidated invoice, so the
   "already generated" warning never fired. It now asks `payroll_records` and
   reports the client's real invoice number.

`payroll_records` is now the only writable payroll engine, and it is the one the
client invoice is built from, so a payslip and an invoice cannot disagree.

**One consequence worth stating plainly.** Overtime, bonus, reimbursement and
loan-EMI deduction were only ever computed by `previewEmployeePayroll`. Placement
payroll computes gross, ESIC, PF and net — and nothing else. So those four are
now **previewable but not recordable**.

Nothing live is lost: all four sit on tables among the seventeen that were never
deployed to production (`overtime_records`, `bonus_records`,
`reimbursement_requests`, `employee_loans`), so they have never worked there. But
the capability is now disconnected rather than merely duplicated, and wiring any
of it into placement payroll is separate work that nobody has asked for yet.

Four suites exercised the retired path and were updated rather than deleted:

- **The two HR suites** now run payroll through the placement, which is a better
  test than before — it follows the real route a field check-in takes to a
  client's invoice. One of them also caught a genuine mistake while being
  rewritten: `/payroll/run` counts approved `shift_logs`, not
  `staff_daily_attendance`, so it produced a zero-day payroll until the
  attendance route was used instead.
- **F-10/F-11** now reads the surviving preview endpoint by employee id, so the
  component calculations stay guarded, and asserts that the generate attempt is
  *refused with an explanation* — a silent failure being the thing that matters
  here.
- **F-06/F-07** seeds an `employee_payrolls` row directly, the way a historical
  one would sit in the table, and proves the ESIC challan and PF ECR still
  aggregate it. That is B6's promise — reads stay open — turned into a test.

### B7 — Leave the enterprise payroll tables undeployed

No action, deliberately recorded so nobody "fixes" the missing tables later.
The migration scripts already skip these columns when the table is absent and
print the reason.

---

## 4. Frontend changes

### F1 — Hide the enterprise payroll tabs — **DONE**

*Salary Structures* and *Employee Salaries & Bank* are removed from
`finance/payroll`, along with the header's "Salary Templates" button.

One thing found while doing it, and fixed: the tab carrying this business's
**actual** payroll was labelled **"Legacy Placement Payroll"** and greyed out as
deprecated, while the enterprise batch tabs took top billing. That was exactly
backwards. It is now "Placement Payroll", styled like the live feature it is.
The page header, which described a 10-step enterprise pipeline, now describes
what the page does: staff paid from their own attendance, one invoice per client.

### F2 — Delete the dashboard's mock fallback — **DONE**

The four `.catch(() => null)` wrappers and their hardcoded fallbacks are gone.
The screen now has a real error state (with a retry) and a real empty state that
says *"No payroll data for this period"* and points at the Pipeline tab.

Two smaller lies went with them: a fixed *"+4.2% from previous month"* under the
gross figure, now the real batch count; and a `|| 1` padded into every pie slice
so each drew even when the underlying deduction was zero.

Same principle as the tax rates, where every seeded figure carries
`needs_confirmation`: an unverified number must not present itself as fact.

### F3 — Make invoicing client-first

`finance/invoices` should list by client and period, with staff appearing as
line items inside an invoice rather than as invoice subjects. The consolidated
page already exists at `finance/invoices/consolidated`; it should become the
default view rather than a separate one.

### F4 — Route employee creation through onboarding — **DONE**

Both "Add Employee" buttons — on `hr/employees` and on `hr/attendance`'s empty
state — now read **Onboard Employee** and point at `/hr/onboarding`, because the
first step is choosing the person who reached `S5_DEPLOY`, not filling a blank
form.

`hr/employees/create` is kept as a redirect rather than deleted, so existing
links and bookmarks land somewhere useful instead of a 404. After B4 that form
could not have succeeded anyway, and leaving it reachable would have been a
trap.

### F5 — Hide Commercial — **DONE**

The owner chose to hide it. All five sidebar entries — Calculator, Quotations,
Rate Cards, Reports, Approval — are gone, along with the `'Commercial': true`
default-open state.

**The pages and routes still work.** Nothing was deleted; the module is simply
no longer advertised. If the rate card is ever wired into the placement at S4,
restoring the menu entry is a one-line change.

The reason is recorded at the removal site: the approved rate card never reached
the placement, so the approval chain could be bypassed by typing a different
number, and production bore that out — 13 wage configs at 10%, but 0
calculations, 0 quotations, 0 rate cards, against real placements at 12%, 15%
and hand-typed figures. A menu entry that is configured and ignored teaches
people to distrust the menu.

---

## 5. Sequence

Ordered by risk, not by size.

| # | Change | Status |
|---|---|---|
| 1 | **B1** cron → consolidated | **done** — 10 checks |
| 2 | **B3** retire per-placement path | **done** — one INSERT site left |
| 3 | **F2** remove mock fallback | **done** |
| 4 | **F1** hide enterprise tabs | **done** |
| 5 | **B2** unique index | **done** — local and production, both verified |
| 6 | **B4** close the second door | **done** — 89 HR checks |
| 7 | **F4** single onboarding entry point | **done** |
| 8 | **B5** remove the orphan employees | **done** — production has 0 orphans |
| 9 | **F3** client-first invoice UI | **done** — 7 checks |
| 10 | **B6** retire the second payroll engine | **done** |
| 11 | **F5** hide Commercial | **done** |

All eleven are complete. `npm run test:finance` now runs the B1 and F3 suites as
well — 298 checks — and `npm run migrate:finance` ends with the B2 index.

---

## 7. What is left for a person

Nothing in this plan. Two items carry over from the finance audit and are
unrelated to it:

- **Tax slabs still need a CA's confirmation** before `tax.slabs_confirmed` is
  set. Until then every seeded rate is flagged `needs_confirmation` and payroll
  marks each figure it uses.
- **`finance.supplier_gstin` is still blank**, so invoices are issued as a Bill
  of Supply rather than a Tax Invoice. That is the correct document for an
  unregistered supplier; filling the setting switches every subsequent invoice
  with no code change.

Two things worth deciding eventually, recorded so they are not forgotten.

**The Commercial module is hidden, not wired in.** Management fee — the only
margin this business earns — is still typed by hand per placement with no
Finance approval. Hiding the tab stopped it misleading anyone; it did not put a
control in place.

**Overtime, bonus, reimbursement and loan EMI are disconnected.** They can be
previewed but not recorded (§B6). Nothing live depends on them, because they sit
on tables production never received. If any of them is actually needed, it has
to be built into placement payroll.

---

## 6. What still needs a person

Neither of these is a coding task.

**Which payroll engine survives** (B6). Recommendation: `payroll_records`,
because the invoice is built from it.

**What Commercial is for** (F5). Either the approved rate card binds the
placement, or the module is hidden.

Two items carried over from the finance audit remain open and unrelated to this
plan: tax slabs still need a CA's confirmation before `tax.slabs_confirmed` is
set, and `finance.supplier_gstin` is still blank, so invoices are issued as a
Bill of Supply rather than a Tax Invoice.
