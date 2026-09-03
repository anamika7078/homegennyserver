# One staff, many clients — hourly and permanent placements

Written 2026-09-03, after the model was settled in conversation:

> A maid works several houses in a day. Some placements are **permanent** — the
> staff member gives that client their whole day. Others are **temporary**,
> charged **per hour**, and the hourly rate can differ from client to client.
> **Salary is not fixed; it follows the hours actually worked.** ESIC and PF are
> computed once on the whole month's earnings, not per client. Each client is
> identified by a **unit code**, and their invoice — which may cover a single
> day — is built from their own placements only.

Every claim below carries the query or file that establishes it.

---

## 1. What already works

**One client, many staff.** Verified end to end: two staff placed with one
client, payroll run separately, produced a single invoice — 2 staff, 8 line
items, reconciling to the total. Nothing here needs changing.

**Client unit codes exist.** `finance_customers.unit_code` is already a unique
column. It is what the new invoice screen will look up.

**One invoice per client per month** is enforced by the database, not by
convention — a partial unique index on
`(client_id, period_month, period_year)`.

---

## 2. What blocks the other direction

### 2.1 The database allows a staff member one day, once

```
UNIQUE (staff_id, attendance_date)
```

A maid at Saxena in the morning and Kapoor in the afternoon cannot be recorded.
The second row is rejected. This is the hard blocker: **everything else is
downstream of it.**

`staff_daily_attendance.placement_id` is also **nullable**, so even where a day
exists there is no reliable way to say which client it belongs to.

### 2.2 Placements carry a monthly figure and nothing else

```
staffSalary      Decimal?   -- monthly
managementFee    Decimal?   -- monthly
```

There is no placement type and no hourly rate. Payroll pro-rates the monthly
figure by days:

```
gross = monthly_salary × billable_days / days_in_month
```

That is right for a permanent placement and meaningless for an hourly one.

### 2.3 The API refuses a second active placement

`placement.service.ts` rejects a staff member who already has a TRIAL or
CONFIRMED placement:

> *"Staff already has an active placement — exit that placement before creating
> a new one."*

Added deliberately, to stop duplicate rows for the same staff and client. Under
the settled model it is wrong as written: it must stop a duplicate of the *same*
client, not a placement with a *different* one.

---

## 3. The shape being proposed

```
placement ─┬─ PERMANENT  → monthly salary + monthly fee   (as today)
           └─ TEMPORARY  → hourly rate + hourly fee, per client

attendance = one row per (staff, placement, date) with hours worked
             ── the same staff can have several rows on one date

payroll   = sum of every placement's earnings for the month
            ESIC and PF computed ONCE on that total
            employer contributions split back across clients by share

invoice   = one per client, carrying only that client's placements
            can cover a single day
```

The important line is the last one in the payroll block. Statutory
contributions are a property of the person, not of the engagement: ESIC's
₹21,000 ceiling applies to what they earned altogether. Computing it per
placement would let someone earning ₹30,000 across three houses look like three
people earning ₹10,000, and each client would be charged ESIC that is not owed.

---

## 4. Schema changes

### S1 — attendance becomes per placement

```sql
ALTER TABLE staff_daily_attendance
  ADD COLUMN hours_worked NUMERIC(4,1);

-- the blocker
DROP INDEX staff_daily_attendance_staff_id_attendance_date_key;

CREATE UNIQUE INDEX uniq_attendance_staff_placement_date
  ON staff_daily_attendance (staff_id, placement_id, attendance_date);
```

`placement_id` must also become NOT NULL. Existing rows without one need
backfilling from the staff member's placement for that date before the
constraint can be added — there are few enough to do by hand.

**This is the one destructive step in the plan.** Dropping that index is what
allows two houses in a day; it also means a genuine duplicate entry for the same
client is caught by the new index instead of the old one.

### S2 — placements gain a type and a rate

```sql
ALTER TABLE placements
  ADD COLUMN placement_type VARCHAR(20) NOT NULL DEFAULT 'PERMANENT',
  ADD COLUMN hourly_rate    NUMERIC(10,2),
  ADD COLUMN hourly_fee     NUMERIC(10,2);

ALTER TABLE placements
  ADD CONSTRAINT placement_type_check
  CHECK (placement_type IN ('PERMANENT','TEMPORARY'));

-- a temporary placement must price itself
ALTER TABLE placements
  ADD CONSTRAINT temporary_needs_rate
  CHECK (placement_type = 'PERMANENT' OR hourly_rate IS NOT NULL);
```

Defaulting to PERMANENT keeps every existing placement behaving exactly as it
does now, so this migration changes no current figure.

---

## 5. Backend changes

### B1 — allow a second client, still refuse a duplicate

The guard changes from *"has any active placement"* to *"has an active
placement **with this client**"*. Same protection against the bug it was written
for, without blocking the model.

### B2 — earnings per placement

```
PERMANENT : monthly_salary × billable_days / days_in_month     (unchanged)
TEMPORARY : Σ hours_worked × hourly_rate
```

Management fee follows the same split — monthly fee pro-rated, or
`hours × hourly_fee`.

### B3 — statutory once, then apportioned

```
total_gross      = Σ every placement's earnings for the month
esic, pf         = computed on total_gross, once
client's share   = employer_esic × (that client's gross ÷ total_gross)
```

So three clients of a ₹30,000 earner each carry their proportion of one correct
ESIC figure, rather than three wrong ones.

### B4 — payroll rows stay per placement

`payroll_records` is already keyed by placement, which is exactly right: each
row is what one client owes for one person. What changes is that a staff member
now has several rows in a month, and the salary slip sums them.

**What this turned up.** Running payroll by staff code resolved *one*
placement — `lookupByCode` takes the most recently confirmed one and stops —
so a maid working three houses had one house billed and two silently left out,
with nothing on screen to say so. `generateAttendanceByCode` now runs every
house she works at and reports each; a house already run is skipped rather than
failing the call, so someone joining a second client mid-month is not blocked by
the first being done. The preview shows every house too — previewing one and
billing three is worse than no preview at all.

### B5 — the salary slip aggregates

HR's slip shows one net figure — the person is paid once — with a breakdown by
client underneath. The client invoice keeps showing only its own share.

Both HR views needed this, not just one: `listForEmployee` (a person's own
slips) and `listForPeriod` (HR's month-end list) each returned one row per
placement, so a three-house month showed as three salaries. Days paid is the
most days at any one house, never the sum — a month has no extra days to give.
The PDF lists the houses above the gross, so the total is checkable.

### B6 — single-day invoicing

`ConsolidatedInvoiceService` already builds from payroll records rather than
from a calendar month, so a client with one day of hours produces a one-line
invoice with no special case. Worth an explicit test rather than an assumption.

---

## 6. Frontend changes

### F1 — invoice screen driven by the unit code

The requested flow, and the main usability change:

```
[ unit code ]  →  client name, address, GSTIN, their placements
                  ── permanent and temporary listed separately
                  ── period picker
                  → [ Create invoice ]
```

One box, the client's details confirming you have the right one, and the button
right there. No separate page, no hunting.

As built, each person on the panel also carries their own state — days worked,
or `hours × rate` for an hourly placement, and whether payroll has run and
whether they are already on an invoice. The button underneath follows that
state rather than always offering the same thing: **Create invoice** when there
is un-invoiced payroll, **Add to this invoice** when a draft is open and someone
joined since, **Go to Payroll** when payroll has not run yet, and **View
invoice** once the period is fully billed. A greyed-out button is never the
answer — the screen always offers the action that is actually next.

Backend: `GET /finance/invoices/by-unit-code?unit_code&month&year`
(`ConsolidatedInvoiceService.lookupByUnitCode`). Frontend:
`src/app/finance/invoices/components/client-lookup.tsx`, sitting above the
invoice list — the list is the record of what has been done, the panel is the
thing Finance comes here to do.

### F2 — placement form takes a type

PERMANENT asks for monthly salary and fee; TEMPORARY asks for hourly rate and
hourly fee. The form shows one or the other, never both.

### F3 — attendance takes hours and a client

Marking a day asks which placement and how many hours. A staff member with
three placements shows three rows for the same date.

### F4 — invoice shows the working

For a temporary placement the line should read the way the client would check
it: `12 hours × ₹150 = ₹1,800`, not just a total.

---

## 7. Order of work

| # | Step | Why here | State |
|---|---|---|---|
| 1 | **S2** placement type + rates | Additive, defaults keep today's behaviour | done |
| 2 | **B1** allow a second client | Small, unblocks the rest | done |
| 3 | **S1** attendance per placement | The destructive one — backfill first | done |
| 4 | **B2 + B3** hourly earnings, statutory once | The real calculation | done |
| 5 | **F2 + F3** placement type, attendance hours | Data can now be entered | done |
| 6 | **B4 + B5** slip aggregation | Follows from B3 | done |
| 7 | **F1** unit-code invoice screen | The usability ask | done |
| 8 | **F4 + B6** hourly lines, single-day invoice | Presentation | done |

Steps 1 and 2 are safe to ship on their own. Step 3 changes stored data and
needs the backfill checked by hand before the constraint goes on.

### What the live tests cover

| Suite | Covers |
|---|---|
| `_live_test_f2_placement_type.js` | Both kinds created; one person at two houses; refused twice at one house; an hourly placement with no rate refused |
| `_live_test_f3_roster.js` | One row per house per day; marking refused without naming the house; hours kept per house; two attendance rows for one date |
| `_live_test_f1_unit_code.js` | Unit-code lookup; payroll issuing the client's invoice; a later joiner folded into the same invoice; hourly lines showing `hours × rate`; the hourly management fee actually billed |
| `_live_test_b5_salary_slip.js` | One slip per month across houses, with the houses listed under it, and its PDF |

### Two defects this work uncovered

**Invoice numbers could collide.** `bill_no_prefix` was `BILL/YYYYMM` — the
month the customer was onboarded — so every customer onboarded in the same
month shared a series, while `bill_seq` counts per customer. The second such
customer's first invoice took a number the first already held and died on the
unique constraint with a bare 500. Ten customers shared one prefix locally.
Production had not hit it only because it has two customers, created in
different months. New customers now take their unit code into the prefix, which
is unique by construction; existing ones keep their series (renumbering issued
invoices is an accounting event, not a migration) and the invoicing path skips
past a number already taken.

**Hourly placements were billed no management fee at all.** The invoice derived
the fee from the placement's *monthly* `management_fee`, which is null for an
hourly placement — so HomeGenny earned nothing on them. It now reads the fee
payroll actually computed and stored.

---

## 8. Still open

**What a permanent placement means for hours.** If a permanent staff member
works a short day, does the client pay less? Today they do not — the monthly
figure is pro-rated by days, not hours. Leaving it that way is the smaller
change and matches "permanent = whole day".

**Overtime on a permanent placement.** `overtime_hours` already exists on
attendance and nothing reads it. Once hours are recorded it becomes usable, but
whether overtime is billed, and at what multiple, is a business decision.

**Minimum billing.** A temporary placement of one hour currently bills one
hour. Most staffing agreements carry a minimum — per visit or per month. There
is none in the system, and adding the wrong one is as costly as having none.
