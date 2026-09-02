# Deploy Runbook — finance remediation

What to do, in what order, to get this release onto Render without breaking
anything. Written after reading the actual boot path rather than assuming it.

---

## What actually runs on Render

The `Dockerfile` ends with:

```dockerfile
CMD ["sh", "scratch/render_start.sh"]
```

So `npm run render:start` — the script that contains
`prisma db push --accept-data-loss` — **is not what production runs.** The real
boot sequence is `scratch/render_start.sh`:

1. `node scratch/render_pre_migrate.js` — clears known-broken migration states
2. **`npx prisma migrate deploy`** — applies pending migrations
3. `node scratch/apply_security_triggers.js`
4. `node scratch/seed_users_now.js` (failure tolerated)
5. `exec node dist/main`

**This is good news and bad news.**

Good: production does **not** run `db push --accept-data-loss`, so the
drop-everything hazard does not apply to the real deploy path. The earlier
warning about it was aimed at the wrong script.

Bad: `migrate deploy` only applies migrations that exist as folders under
`prisma/migrations/`. **None of this release's tables are in a migration
folder** — they were created by the raw-SQL scripts in `scratch/`. So
`migrate deploy` will apply nothing new, the tables will not exist, and every
new finance endpoint will fail.

**Therefore the migration scripts must be run against the Render database
manually, before the new code starts serving.**

---

## Before you begin

Have ready:

- The Render Postgres **External Database URL** (Render dashboard → your
  Postgres instance → Connections → External Database URL).
- A **backup**. Render's paid Postgres plans keep automatic backups; check
  yours exists and note its timestamp before step 2. On the free plan there is
  no automatic backup — take one first:
  ```
  pg_dump "<render url>" > backup_$(date +%Y%m%d_%H%M).sql
  ```

Nothing below is irreversible except step 3, and that is the step the backup
covers.

---

## Step 1 — Look, change nothing

```powershell
$env:DATABASE_URL="<render external database url>"
node scratch/_preflight_check.js
```

This only reads. It reports which tables and columns the new code needs and
this database does not have, plus the row counts a bad deploy would put at
risk.

**Expect:** a long list of `MISSING`. That is correct at this point — it is
what you are about to fix.

**Stop and reconsider if:** the connection fails, or the row counts look
nothing like production (wrong database).

---

## Step 2 — Check nothing will be destroyed

```powershell
npx prisma migrate diff `
  --from-schema-datasource prisma/schema.prisma `
  --to-schema-datamodel   prisma/schema.prisma --script | Select-String "DROP"
```

**This diff is a diagnostic. Never pipe it into the database.**

On the 2026-09-02 production run it emitted 152 statements, and beyond the
tables it would add it also dropped nineteen foreign-key constraints, five
indexes, and the `DEFAULT` on `client_indemnities.id` — which would have broken
every insert into that table. `schema.prisma` has drifted from what production
actually looks like, so "make the database match the schema" is not currently a
safe instruction. Read the output; apply only step 3.

**Expect:** `DROP TABLE` lines only for the six dead tables F-13 removes
(`payroll_batches`, `payroll_entries`, `payroll_payslips`, `refunds`,
`salary_ledgers`, `branch_financial_reports`). Step 3 drops those itself, and
only after checking each is empty.

**If a `DROP TABLE` names anything else — stop** and send the output.

---

## Step 3 — Create the tables

```powershell
npm run migrate:finance
```

Runs all seven migration scripts in order. Each one:

- uses `IF NOT EXISTS`, so re-running is safe
- only drops a table after checking it is **empty** — it refuses otherwise
- runs inside a transaction and rolls back completely on any error

**Expect:** a list of `ok` lines ending in `F13/F14/F15 migration applied.` and
similar, then `F18/F20 migration applied.`

**If it fails:** it has already rolled itself back. Send the error; nothing was
half-applied.

---

### What happened on the real run — 2026-09-02

Steps 1–4 have already been carried out against the Render database
(`homegenny_gbwq`). Recorded here so the next person is not surprised.

**All seven migrations applied. No data was lost** — row counts were captured
before and after for all 70 tables and every populated table matched exactly
(`scratch/_render_snapshot_before.json` holds the "before"). Seven tables were
added, and the six empty dead tables were dropped.

Two things had to be fixed before it would run:

**1. TLS.** The migration scripts connected in plaintext and Render answered
`FATAL: SSL/TLS required`. All seven now select TLS from the host name, the
same way `_preflight_check.js` already did.

**2. Production is missing the entire enterprise payroll module.** Not just the
finance tables — **24 tables in `schema.prisma` do not exist on Render**, and
only seven of those belong to this release. The other seventeen are the batch
payroll and HR compensation module:

```
payroll_details            payroll_processing_batches   payroll_approval_workflows
payroll_settings           payslip_documents            bank_transfer_batches
salary_structures          salary_components            salary_revisions
employee_salary_profiles   employee_loans               salary_advances
bonus_records              overtime_records             overtime_rules
reimbursement_requests     right_to_refuse_log
```

That module's **code is deployed but its tables never were**, so those
endpoints have been failing in production independently of this release. It is
a separate piece of work and someone should decide about it deliberately —
creating seventeen tables for an untested-in-production module is not something
to slip into a finance deploy.

Two of them, `payroll_details` and `payroll_processing_batches`, are the only
ones this release wanted to add columns to. Those steps now check whether the
table exists and skip it with a printed reason. Nothing is lost by skipping:
the columns are declared in `schema.prisma`, so they arrive with the table
whenever that module is deployed. `_preflight_check.js` reports them under
**not applicable** rather than counting them against the verdict.

---

## Step 4 — Confirm

```powershell
node scratch/_preflight_check.js
```

**Expect:** every table `present`, columns `all present`, dead tables
`all removed`, and the verdict `This database has everything the new code
needs. Safe to deploy.`

Do not proceed until this is green.

---

## Step 5 — Deploy the code

**As of 2026-09-02 this has not happened yet.** Probing the live API showed the
old code still serving: `/finance/deposits` answers `401` (route exists) while
`/finance/tax/status`, `/finance/exit-settlements`, `/finance/credit-notes` and
`/finance/invoices/consolidated/preview` all answer `404`. So auto-deploy is
either off or has not picked up the commit.

Trigger it from the Render dashboard: **Manual Deploy → Deploy latest commit**.
Backend and frontend are separate services — deploy both.

**First, confirm the service and the migrated database are the same one.**
Open the backend service → Environment → `DATABASE_URL` and check the host
matches the one you migrated. This could not be verified from outside; if the
service points somewhere else, steps 1–4 landed on the wrong database and the
new pages will still fail.

---

## Step 6 — Verify it is actually working

```powershell
# health
curl https://homegennyserver-po5u.onrender.com/api/v1/health

# a new endpoint that did not exist before this release
# (needs a FINANCE bearer token)
curl -H "Authorization: Bearer <token>" `
  https://homegennyserver-po5u.onrender.com/api/v1/finance/tax/status
```

`/finance/tax/status` returns `{ confirmed: false, message: ... }` when the new
tables are live. A 500 means step 3 did not take effect on the database this
service is pointed at.

Then in the web app, open: **Tax Rules**, **Exit Settlements**, **Month-end
Invoicing**. All three are new. Each should load rather than error.

---

## If something goes wrong

**New finance pages error, everything else is fine.** The migrations did not
reach the right database. Re-run step 1 against the URL the *service* uses
(Render dashboard → service → Environment → `DATABASE_URL`), which may differ
from the one you used.

**The whole API is down.** Not caused by these migrations — they only add.
Check the Render deploy log; the likeliest cause is a build failure or a
missing environment variable.

**You need to undo.** The database changes are additive: the old code ignores
the new tables and columns entirely, so **rolling the code back to the previous
commit is sufficient** and safe. There is no need to reverse the migrations.

---

## Rotate the database password

The external `DATABASE_URL` used for the 2026-09-02 run was pasted into a chat
session, so treat it as disclosed. Rotate it once the deploy is verified:
**Render dashboard → the Postgres instance → Settings → Reset Password**, then
update `DATABASE_URL` on every service that uses it.

The local copy lives in `.env.render.local`, which `.gitignore:13` (`.env.*.local`)
already excludes — it has never been committed. Delete it when you are done.

---

## After the deploy — two things that still need a person

Neither blocks the deploy; both matter before the numbers are trusted.

**1. Confirm the tax rates.** Professional tax and TDS now come from seeded
tables flagged as unverified. Payroll runs and flags every figure. Have your CA
check the Maharashtra PT slabs and the FY 2026-27 income-tax slabs, then
confirm them on the **Tax Rules** page.

**2. Set the GST identity.** Until `finance.supplier_gstin` and
`finance.sac_code` are set in `system_settings`, invoices are issued as a
**Bill of Supply** rather than a Tax Invoice, and no GST is charged. That is the
correct document for an unregistered supplier — but if you are registered, fill
these in and every subsequent invoice becomes a Tax Invoice with no code
change.

Also note: `RAZORPAYX_ACCOUNT_NUMBER` is unset, so salary disbursement records
a `SIMULATED` result rather than moving money. That is deliberate — it never
claims a payment happened. Real payouts need a RazorpayX account and staff bank
details on file.

---

## The deeper fix, for later

This release had to be applied by hand because the migration history is
inconsistent between environments. Production **does** have a
`_prisma_migrations` table with 22 rows, so `migrate deploy` works there — but
the local development database has none at all, which is why the team fell back
to `db push` locally and why nothing in this release was ever authored as a
migration folder. `render_pre_migrate.js`, which marks four specific migrations
as rolled back on every boot, exists to work around the same drift.

The 24 missing tables above are the visible cost: schema changes that reached
`schema.prisma` and local databases through `db push` never became migrations,
so `migrate deploy` had nothing to apply and production silently fell behind.

The fix is to **baseline**: generate one migration representing the current
schema, mark it applied without running it, and let `migrate deploy` work
normally from then on. After that, every change ships as a versioned migration
and no step in this runbook is needed again.

That is a separate piece of work and does not block this deploy.
