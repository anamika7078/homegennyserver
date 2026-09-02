# Testing Finance and HR with the journey fixture

One staff member, carried all the way from intake to a client invoice, so you
can walk the whole thing by hand.

```
node scratch/_seed_full_journey_fixture.js
```

Local only — it refuses to run against a remote database. Re-running rebuilds
the fixture; nothing accumulates.

By default it builds **last month**, because attendance for a month still
running is partial and payroll for it is not something you would really issue
yet. To pick a period: `node scratch/_seed_full_journey_fixture.js 8 2026`.

---

## What it makes

| | |
|---|---|
| **Client** | JOURNEY Test Household · New Delhi · GSTIN `07AAAPL1234C1ZV` · bill prefix `JOURNEY/BILL` |
| **Staff** | Sunita Devi · `journey001` · MAID series · at **S5_DEPLOY** |
| **Employee** | `JOURNEY001` · Field Operations / Housemaid · linked to the pipeline row |
| **Placement** | CONFIRMED · salary **₹18,000** · management fee **₹2,000** |
| **Attendance** | a full month — 25 present, 5 weekly offs (Sundays), 1 absent |

Each pipeline stage left the artefact it is supposed to leave, so the RM screens
have something real to show rather than a staff row with a stage flag set:

- **S2** four verification tracks — Aadhaar, police, health, reference — all CLEAR
- **S2.5** assessment result PASS
- **S3** training video, review APPROVED
- **S4** agreement SIGNED (OTP verified), a scope of work, a client indemnity
- **S5** the confirmed placement

**Payroll and the invoice are deliberately not created.** Those are what you are
here to test.

### Logins

| Role | Phone | Password |
|---|---|---|
| Finance | 9800000004 | `HomeGenny@2024` |
| HR | 9800000008 | `HomeGenny@2024` |
| RM | 9800000002 | `HomeGenny@2024` |

---

## Before you start

Two terminals:

```
cd homegennyserver && npm run start:dev     # port 3001
cd homegenny       && npm run dev           # port 3000
```

Do not use `npm start` for the backend — it runs `prisma db push
--accept-data-loss` first. `start:dev` does not.

If a page 500s, check the backend terminal before anything else. And if you see
several "EADDRINUSE" lines there, an older backend still holds port 3001 and
you are talking to stale code — kill it and start one.

---

## 1 · RM — the pipeline reached the end

**Login as RM → Pipeline.**

Find **Sunita Devi (`journey001`)** in the **S5 Deploy** column.

Open her. What to look for:

- all four verification tracks show **Clear**
- assessment shows **Pass**
- the video certification shows **Approved**
- the agreement shows **Signed**
- the placement shows **JOURNEY Test Household**, ₹18,000 salary, ₹2,000 fee

**The point:** everything downstream depends on this being real. If the
placement has no salary or fee, payroll refuses — deliberately, because an
invoice built on a blank number is worse than no invoice.

---

## 2 · HR — she exists as an employee, linked to the pipeline

**Login as HR → Employees.**

`JOURNEY001` is there. Open it and check **her pipeline link is present** — she
came from the pipeline, she is not a free-standing hire.

Then try **HR → Onboarding**: she should **not** be in the pending list, because
she has already been onboarded.

**Also worth trying:** HR → Employees → *Onboard Employee*. It now leads to the
onboarding list rather than a blank form. There is no way left to create an
employee who belongs to no client.

---

## 3 · HR — attendance for the month

**HR → Attendance**, set the month to the fixture's period.

You should see the full month for her: 25 present, 5 leave, 1 absent.

Change one day — mark the 17th (the absent one) as **Present**. It should save,
and the day should stop being counted as absent.

**Change it back to Absent before moving on**, or the payroll figures below
will be one day off.

---

## 4 · Finance — preview the payroll

**Login as Finance → Invoices → Run Staff Payroll.**

Enter `journey001`, pick the fixture's month and year, and preview.

Expected, for 25 present days in a 31-day month:

| | |
|---|---|
| Billable days | **25** |
| Gross salary | **₹14,516.13** — 18,000 × 25/31 |
| Employee ESIC | ₹108.87 |
| Employee PF | ₹1,741.94 |
| Net salary | **₹12,665.32** |
| Management fee | **₹1,612.90** — 2,000 pro-rated the same way |

Things worth checking specifically:

- **Professional tax must be ₹0.** She is in Delhi, and Delhi does not levy it.
  If you see ₹200 here, something has regressed to the flat rule.
- **ESIC applies at all**, because gross is under the ₹21,000 statutory limit.
  Raise her salary above that and it should disappear.
- **Every tax figure carries an "unconfirmed" flag** until a CA confirms the
  slabs on the Tax Rules page. That is intended: an unverified number should not
  present itself as fact.

---

## 5 · Finance — run it, and watch where the invoice goes

Generate from the same screen.

The success message should say **"Payroll recorded — added to the client's
invoice JOURNEY/BILL/0001"**, not "invoice generated". The distinction is the
whole point: the invoice belongs to the client, and she is a line on it.

Now open **Invoices**. The new invoice shows:

| | |
|---|---|
| Number | **JOURNEY/BILL/0001** — from the client's prefix, not a placement id |
| Client | JOURNEY Test Household |
| Staff billed | **1 staff** |
| Total | **₹18,342.74** |

Open it. Four line items:

```
Sunita Devi — Staff Salary      14,516.13
Sunita Devi — Employer ESIC        471.77
Sunita Devi — Employer PF        1,741.94
Sunita Devi — Management Fee     1,612.90
                                ─────────
                                18,342.74
```

**Check the arithmetic yourself.** The line items must sum to the total — the
code refuses to issue an invoice where they do not, and this is the place to
confirm that holds.

**On GST:** the document says **Bill of Supply**, not Tax Invoice, and GST is
₹0. That is correct while `finance.supplier_gstin` is unset — an unregistered
supplier cannot charge GST. Fill that setting in and the next invoice becomes a
Tax Invoice with 18% on the management fee only (₹290.32), never on salary.

---

## 6 · The test that matters most — a second staff member

This is the bug the whole release was about, so it is worth proving.

Add a second person to the same client:

```sql
-- run against local
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

Adjust `make_date(2026, 8, …)` if you seeded a different period.

Now run payroll for `journey002` from the Finance screen.

**Expected — and this is the assertion:**

- **No second invoice appears.** Still one, still `JOURNEY/BILL/0001`.
- Its **Staff billed** column now reads **2 staff**.
- Opening it shows **eight** line items, four per person.
- The total has grown by Ramesh's salary, contributions and fee.

Before this release each of them would have received their own invoice,
numbered from their placement id. If you see two invoices here, something has
regressed.

Then try it once more for the same person and period: it should refuse with
*"Payroll already exists for placement …"*. Nobody gets paid twice.

---

## 7 · Payslips

**HR → Employees → JOURNEY001 → Payslips**, or Finance's payslip view.

Her payslip for the period should list the same figures as the invoice's line
items for her — same gross, same deductions. They come from the same
`payroll_records` row, which is why they cannot disagree.

Download the PDF and check the net salary matches.

---

## 8 · What should refuse

Worth trying deliberately, because a silent failure is the dangerous kind:

| Try this | It should |
|---|---|
| Run payroll twice for the same person and period | refuse — *"Payroll already exists for placement …"* |
| Approve the invoice, then run another staff member's payroll for that client | refuse to amend, and point you at a credit note |
| `POST /employees` without a `staffApplicantId` | refuse — every employee comes from the pipeline |
| Look for **Salary Structures** or **Employee Salaries & Bank** | they are gone — that module is for a business with internal salaried departments |
| Look for **Commercial** in the sidebar | hidden — its rate cards never reached the placement |

---

## Cleaning up

Re-running the seed resets everything downstream. Two things it deliberately
does not remove:

- **`pipeline_events`** — append-only at the database level, with a trigger
  refusing UPDATE and DELETE. That is an audit guarantee, not an obstacle.
- **the staff and client rows themselves** — the FK from `pipeline_events` is
  RESTRICT, so they cannot be deleted once a history exists. They are updated in
  place instead.

If you added `journey002` by hand, remove it the same way you added it.
