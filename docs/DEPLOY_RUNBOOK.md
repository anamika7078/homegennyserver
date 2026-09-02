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

**Expect:** no output.

**If any `DROP` appears — stop.** It means the Render database holds something
`schema.prisma` does not describe. Nothing in step 3 will drop it, but it is a
sign the two environments have diverged and worth understanding first. Send the
output before continuing.

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

The code is already on `main` in both repos, so:

- **If Render auto-deploys on push to `main`**, a deploy may already be running
  or finished. In that case steps 1–4 were the urgent part and you have just
  repaired a service that was erroring on the new endpoints.
- **If auto-deploy is off**, trigger it now from the Render dashboard
  (Manual Deploy → Deploy latest commit).

Backend and frontend are separate services — deploy both.

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

This release had to be applied by hand because the migration history is broken:
`prisma/migrations/` holds 23 folders, but the database has no
`_prisma_migrations` table at all — so `migrate deploy` has no idea any of them
ever ran. `render_pre_migrate.js`, which marks four specific migrations as
rolled back on every boot, exists to work around exactly that.

The fix is to **baseline**: generate one migration representing the current
schema, mark it applied without running it, and let `migrate deploy` work
normally from then on. After that, every change ships as a versioned migration
and no step in this runbook is needed again.

That is a separate piece of work and does not block this deploy.
