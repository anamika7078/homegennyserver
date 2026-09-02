# Testing the flow

The whole system, in one sentence:

> **A staff member is placed with a client. Their attendance is marked — by HR,
> or by themselves from the app. From that attendance come two things: the
> client's invoice, and the staff member's salary slip.**

There are two Finance screens and one HR screen. Nothing else.

| Screen | What it is for |
|---|---|
| **Finance → Payroll** | work out what a staff member earned |
| **Finance → Invoices** | issue and send each client's one monthly bill |
| **HR → Salary Slips** | see what everyone was paid |

---

## Build the test data

```
node scratch/_seed_full_journey_fixture.js
```

Local only — it refuses to run against a remote database. Re-running rebuilds
it; nothing accumulates. It builds **last month** by default, because
attendance for a month still running is partial. To pick one:
`node scratch/_seed_full_journey_fixture.js 8 2026`.

### What it makes

| | |
|---|---|
| **Client** | JOURNEY Test Household · New Delhi · bill prefix `JOURNEY/BILL` |
| **Staff** | Sunita Devi · `journey001` · placed with that client, at **S5_DEPLOY** |
| **Employee** | `JOURNEY001` — her HR record, linked to the pipeline row |
| **Placement** | CONFIRMED · salary **₹18,000** · management fee **₹2,000** |
| **Attendance** | a full month — 25 present, 5 Sundays off, 1 absent |

Payroll and the invoice are **deliberately not created**. Those are what you
are here to produce.

### Logins

| Role | Phone | Password |
|---|---|---|
| Finance | 9800000004 | `HomeGenny@2024` |
| HR | 9800000008 | `HomeGenny@2024` |
| RM | 9800000002 | `HomeGenny@2024` |

### Start it

```
cd homegennyserver && npm run start:dev     # port 3001
cd homegenny       && npm run dev           # port 3000
```

Not `npm start` for the backend — that one runs
`prisma db push --accept-data-loss` first.

If a page 500s, read the backend terminal before anything else. Several
`EADDRINUSE` lines there mean an older backend still holds port 3001 and you
are talking to stale code.

---

## The four steps

### 1 · Attendance is already there

**HR → Attendance**, set the month to the fixture's period. Sunita Devi shows
25 present, 5 leave, 1 absent.

This is the only ledger that matters. Whether HR marks a day here or the staff
member marks it from their phone, it lands in the same place — and that is what
both the invoice and the salary slip are counted from.

**Try it:** change the 17th (the absent one) to Present, and it saves. **Change
it back to Absent** before the next step, or every figure below shifts by a day.

---

### 2 · Finance runs payroll — once

**Finance → Payroll.** The screen opens on **last month**, because payroll is
run for a month that has finished — a month still in progress has partial
attendance, and paying from it would short everyone.

Press **Run Payroll**. It processes every confirmed placement that has not been
paid yet for the period and skips the rest, so pressing it again is safe and a
staff member placed mid-month can still be run. The toast tells you exactly what
happened — *"Payroll run for 1 staff member · 11 skipped, no attendance"*.

Sunita Devi's row appears. To see the working before committing to it, use
**Run Staff Payroll** and enter `journey001` to preview first:

| | |
|---|---|
| Billable days | **25** |
| Gross salary — 18,000 × 25/31 | **₹14,516.13** |
| Employee ESIC | ₹108.87 |
| Employee PF | ₹1,741.94 |
| **Net salary — what she receives** | **₹12,665.32** |
| Management fee | ₹1,612.90 |
| GST | **not charged** — see below |
| **Total client charge** | **₹18,342.74** |

Worth checking specifically:

- **Professional tax is ₹0.** She is in Delhi, which does not levy it. ₹200 here
  would mean a regression.
- **GST says "not charged"**, and the total is ₹18,342.74. That is correct while
  `finance.supplier_gstin` is unset — an unregistered supplier cannot charge
  GST, so the document is a Bill of Supply. Fill that setting in and the next
  invoice becomes a Tax Invoice with 18% on the fee only (₹290.32), never on
  salary.
- The preview and the invoice must agree. They are the same numbers now; if you
  ever see the preview promise a figure the invoice does not charge, that is a
  bug worth reporting.

Now generate. The message reads **"Payroll recorded — added to the client's
invoice JOURNEY/BILL/0001"**, not "invoice generated". She is a line on the
client's bill, not the subject of her own.

---

### 3 · The invoice, in the client's name

**Finance → Invoices.**

| | |
|---|---|
| Number | **JOURNEY/BILL/0001** — the client's prefix |
| Client | JOURNEY Test Household |
| Staff billed | **1 staff** |
| Total | **₹18,342.74** |

Open it. Four lines:

```
Sunita Devi — Staff Salary      14,516.13
Sunita Devi — Employer ESIC        471.77
Sunita Devi — Employer PF        1,741.94
Sunita Devi — Management Fee     1,612.90
                                ─────────
                                18,342.74
```

**Add them up yourself.** The code refuses to issue an invoice whose lines do
not sum to its total; this is where you confirm that holds.

Then **Approve**, then **Send**. Sending now actually emails the client and
drops a notification in their portal — it no longer just flips the status.

**If the client has no email on file it refuses**, naming the client, rather
than marking it SENT. That is deliberate: an invoice wrongly marked sent is one
nobody chases. Add an email on **Finance → Customers** and try again.

---

### 4 · The salary slip reaches HR by itself

**HR → Salary Slips**, same month. Sunita Devi is already there — nobody
generated anything here.

| Column | Shows |
|---|---|
| Days | 25 |
| Gross | ₹14,516.13 |
| Deductions | ₹1,850.81 |
| **Net** | **₹12,665.32** |
| Billed | **on invoice** |

Her net here and her lines on the client's invoice come from the same payroll
row, which is why they cannot disagree. The **Billed** column tells you whether
her pay reached the client's bill — "not billed" means payroll ran but the
invoice could not be touched, usually because it had already been sent.

Download the PDF and check the net matches.

---

## The test that matters most

A client with two staff must receive **one** invoice, not two. This is the bug
the release was about, so prove it.

Add a second person to the same client:

```sql
-- local only
INSERT INTO staff_applicants (id, staff_code, full_name, mobile, date_of_birth,
                              address, series, pipeline_stage, branch_id,
                              created_at, updated_at)
SELECT gen_random_uuid(), 'journey002', 'Ramesh Kumar', '9700000002',
       '1988-07-02', 'Dwarka, New Delhi', 'DRIVER', 'S5_DEPLOY', branch_id,
       now(), now()
  FROM staff_applicants WHERE staff_code = 'journey001';

INSERT INTO placements (id, staff_id, client_id, branch_id, status,
                        staff_salary, management_fee, confirmed_at,
                        created_at, updated_at)
SELECT gen_random_uuid(), s.id, p.client_id, p.branch_id, 'CONFIRMED',
       22000, 2500, p.confirmed_at, now(), now()
  FROM staff_applicants s, placements p
 WHERE s.staff_code = 'journey002'
   AND p.staff_id = (SELECT id FROM staff_applicants WHERE staff_code = 'journey001');

INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id,
                                    attendance_date, status, marked_by,
                                    created_at, updated_at)
SELECT gen_random_uuid(), s.id, p.id, p.branch_id,
       make_date(2026, 8, d), 'PRESENT',
       (SELECT id FROM users WHERE role = 'RM' LIMIT 1), now(), now()
  FROM staff_applicants s
  JOIN placements p ON p.staff_id = s.id,
       generate_series(1, 26) AS d
 WHERE s.staff_code = 'journey002';
```

Change `make_date(2026, 8, …)` if you seeded a different period.

Run payroll for `journey002` from **Finance → Payroll**.

**Expected — this is the assertion:**

- **No second invoice.** Still one, still `JOURNEY/BILL/0001`.
- **Staff billed** now reads **2 staff**.
- **Eight** line items, four per person.
- Total **₹41,290.80**.
- **HR → Salary Slips** shows two rows, both marked *on invoice*.

Before this release each of them received their own invoice, numbered from
their placement id. Two invoices here means something regressed.

---

## What should refuse

A silent failure is the dangerous kind, so try these deliberately.

| Try this | It should |
|---|---|
| Run payroll twice for one person and period | refuse — *payroll already exists* |
| Press **Run Payroll** twice | second press does nothing, and says so — nobody is paid twice |
| Send an invoice for a client with no email | refuse, and name the client |
| Approve an invoice, then run another staff member for that client | refuse to amend, and point at a credit note |
| Open `/finance/payroll/attendance` or `/hr/payroll` expecting to run payroll | redirect — payroll runs in one place |
| Look for *Salary Structures*, *Employee Salaries & Bank*, or *Commercial* | be gone — they belong to a different kind of business |

---

## Cleaning up

Re-running the seed resets everything downstream. Two things it deliberately
leaves alone: `pipeline_events`, which is append-only at the database level with
a trigger refusing UPDATE and DELETE, and the staff and client rows themselves,
which that table's RESTRICT foreign key pins in place once a history exists.
Both are updated rather than recreated, which is what makes re-running safe.

If you added `journey002` by hand, remove it the same way.
