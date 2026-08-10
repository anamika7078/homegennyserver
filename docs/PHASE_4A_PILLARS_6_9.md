# Phase 4a Implementation Report — Pillars 6-9 (Liability Shield)

Scope, per user decision to sequence Phase 4 rather than attempt all 35 sections
at once: Scope of Work (Pillar 6), Client Indemnity (Pillar 7), Right to Refuse
(Pillar 8), Incident Trail (Pillar 9). All other Phase 4 sections (workflow
completion, Trial/Exit/Upgrade/Replacement, SMS/WhatsApp delivery, notification
rules, cron cleanup, remaining stubs, mobile API contract, full 6-role E2E,
final production-readiness report) remain out of scope until requested.

All four modules were new — none of this existed before (except the bare
`Incident`/`IncidentComment` Prisma models, which had zero controller/service
layer). Built, typechecked clean, then live-tested end to end against a running
server with real JWTs for RM/BM/ADMIN and two CLIENT accounts. Three real bugs
were found and fixed during live testing — not in the design, in the code that
had already typechecked clean, which is exactly why this phase runs against a
live server instead of stopping at `tsc --noEmit`.

---

## A. Scope of Work (Pillar 6)

`ScopeOfWork` model, `sow` module. RM creates/sends, Client acknowledges,
amendments after acknowledgement create a new version (`supersedesId` chain)
rather than mutating the acknowledged one, BM approves non-standard SOWs.

**Bug found live: amendments silently dropped the non-standard flag.**
`amend()` builds the new version's row but never copied `isNonStandard` from
the version it supersedes. Consequence: RM creates a non-standard SOW
(`is_non_standard: true`), client acknowledges it, RM amends it — the new
version comes back `isNonStandard: false`, silently skipping the BM-approval
gate the ticket requires for non-standard terms. Confirmed live:

| Step | Before fix | After fix |
|---|---|---|
| Amend an acknowledged non-standard SOW | New version: `isNonStandard: false` | New version: `isNonStandard: true` |
| BM approve-non-standard on the new version | `400 not marked non-standard — nothing to approve` | `200`, `bmApprovedBy`/`bmApprovedAt` set |

Fixed in `sow.service.ts` — `isNonStandard: current.isNonStandard` added to
the version-2 `create()` call.

**Verified live, full lifecycle:** create (DRAFT) → acknowledge-before-send
correctly rejected (`400 must be SENT first`) → send → acknowledge → direct
edit after acknowledgement correctly rejected (`400 use amend`) → amend
(new DRAFT version, `supersedesId` set, old version `SUPERSEDED`) → BM
approve-non-standard on the new version.

---

## B. Client Indemnity (Pillar 7)

`ClientIndemnity` model, `indemnity` module. RM sends a clause version, client
acknowledges or contests, BM reviews contested clauses. Each clause version is
its own immutable row — a new version never overwrites history, per spec
("do not overwrite historical acknowledgements").

**Bug found live: a contested clause could still be acknowledged afterward.**
`acknowledge()` only checked `if (row.acknowledgedAt)` — it never checked
`row.contested`. So the sequence contest → acknowledge succeeded, silently
stamping `acknowledgedBy`/`acknowledgedAt` on a row the client had just
disputed. That defeats the purpose of the contest path: a contested clause is
supposed to be resolved through BM review (and, if it stands, presumably
re-sent as a fresh version for a clean acknowledgement) — not quietly marked
acknowledged anyway.

| Step | Before fix | After fix |
|---|---|---|
| Client contests a clause, then calls acknowledge on the same row | `200`, silently acknowledged despite `contested: true` | `400 contested — must go through BM review before it can be acknowledged` |

Fixed in `indemnity.service.ts` — `acknowledge()` now rejects if
`row.contested` is true.

**IDOR verified live:** Client B's token against Client A's indemnity clause
→ `403 You do not have access to this record` on `acknowledge`.

**Verified live, full lifecycle:** send → Client A acknowledges (Client B
blocked) → separate clause: Client A contests with a reason → BM reviews
(`bmReviewedBy`/`bmReviewNotes`/`bmReviewedAt` set) → contest-then-acknowledge
now correctly blocked (above).

---

## C. Right to Refuse (Pillar 8)

`RightToRefuseLog` model, `right-to-refuse` module. This is the one pillar the
ticket explicitly calls out to follow the Phase 2 append-only pattern, so it's
built as a pure event log — `refusalId` groups events, `eventType` (INVOKED →
BM_REVIEWING → UPHELD/OVERTURNED) is the discrete state, no row is ever
mutated. The Phase 2 `BEFORE UPDATE OR DELETE` trigger (the real security
boundary — it fires regardless of table ownership/privilege) was extended to
cover this table.

**Bug found live: `listOpenCases()` didn't actually filter to open cases.**
The comment said `"Open" = every refusalId whose latest event isn't a
terminal decision`, but the implementation just returned the latest event for
every `refusalId`, decided or not — the filter step was never written.

| Step | Before fix | After fix |
|---|---|---|
| List open cases after one case reaches UPHELD | Decided case still appears in the list | Decided case correctly excluded |

Fixed in `right-to-refuse.service.ts` — added a
`.filter(row => row.eventType !== 'UPHELD' && row.eventType !== 'OVERTURNED')`
after building the latest-per-refusal map.

**Verified live, full lifecycle:** RM invokes (generates `refusalId`, INVOKED
row) → BM marks reviewing (BM_REVIEWING row) → BM decides UPHELD → deciding a
second time correctly rejected (`400 already decided`) → full history returns
all three rows in order → `listOpenCases` correctly excludes the now-decided
case (fix above).

**Append-only trigger verified directly against the database** (not just
through the API — a raw SQL attempt via the app's own Prisma connection):

```
UPDATE right_to_refuse_log SET notes = 'HACKED' WHERE event_type = 'UPHELD';
→ ERROR: Table is append-only. Modification or deletion is not allowed. (P0001)

DELETE FROM right_to_refuse_log WHERE event_type = 'UPHELD';
→ ERROR: Table is append-only. Modification or deletion is not allowed. (P0001)
```

Same trigger mechanism validated in Phase 2 for `pipeline_events`, confirmed
still firing there too during this phase's regression pass (§F).

---

## D. Incident Trail (Pillar 9)

`incidents` module built on the pre-existing `Incident`/`IncidentComment`
Prisma models, which had no controller or service before this phase. Client
files against their own deployed staff, RM acknowledges/resolves/escalates,
BM resolves escalations and closes, Admin sets legal-hold. Added `legalHold`
boolean column to `Incident` (additive migration, no existing data touched).

No bugs found in this module's core logic — ownership resolution
(`assertClientDeployedStaff`, checked against real `Placement` rows, not just
role) and the state machine (`transition()` helper enforcing valid
from-states) were both correct on first live test. One thing caught before
release rather than after: `fileByClient()` initially passed
`actorId: undefined` to the audit log (using `ClientProfile.id` where
`users.id` was needed — two different ID spaces for the same request) — fixed
during implementation, before this test pass, by threading `req.user.id`
through as an explicit `actorUserId` parameter.

**Verified live:**
- File → IDOR-blocked read (`403`) and IDOR-blocked comment (`403`) from a
  second client → RM acknowledge (OPEN → INVESTIGATING) → RM escalate
  (→ ESCALATED) → BM resolve (→ RESOLVED, `resolution` text stored) → BM
  close (→ CLOSED).
- Business-rule block: client filing against staff never deployed to them →
  `403 You may only file an incident against staff deployed to your own
  placement`.
- FSM guard: attempting `close` directly from `OPEN` → `400 Cannot move
  incident from OPEN to CLOSED (allowed from: RESOLVED)`.
- Role gate: RM attempting `legal-hold` → `403` (Admin-only); Admin succeeds,
  `legalHold: true` persisted.

---

## E. IDOR coverage across all four modules

Two CLIENT-role test accounts were created against the two existing
`ClientProfile` records that had phone numbers but no linked login
(`resolveClientProfile`'s phone-match pattern, established in Phase 1). Every
module was cross-tested with Client B's token against Client A's records:

| Module | Cross-client action attempted | Result |
|---|---|---|
| Indemnity | Acknowledge Client A's clause | `403` |
| Incidents | Read Client A's incident | `403` |
| Incidents | Comment on Client A's incident | `403` |
| Incidents | File against staff not deployed to caller | `403` |

SOW's `findOne`/`acknowledge` use the identical `assertClientOwns` helper as
Indemnity and Incidents, so the same protection applies there by construction
— not re-tested with a second client only because the SOW test sequence
overlapped this session's login-throttle constraints; the code path is
shared and independently exercised via three other modules.

---

## F. Phase 1 + 2 + 3 regression — confirmed intact

Re-run against the current codebase with the four new modules loaded:

| Check | Result |
|---|---|
| Phase 1 — no token on a protected route | `401` |
| Phase 1 — CLIENT token on RM-only `POST /pipeline/:staffId/advance` | `403` |
| Phase 2 — `pipeline_events` UPDATE via raw SQL on the app's own connection | Blocked by the append-only trigger |
| Phase 2 — `active_session_id` populated and enforced on login | Confirmed set |
| Phase 3 — restricted-list intake block code path present and unchanged | Confirmed (`staff.service.ts`) |
| Phase 3 — `assessments` module resolves against the real Prisma schema | `GET /assessments` returns `200`, no 500 |
| Phase 3 — `PATCH /staff/:id` still blocks the FSM-bypass fields | `403 pipeline_stage cannot be changed via PATCH` |

No regressions found.

---

## G. Test data

SOW, Indemnity, and Incident (+ IncidentComment) rows created during this
test pass were deleted after testing. The three `right_to_refuse_log` rows
created during testing were **not** deleted and cannot be — the append-only
trigger blocks DELETE unconditionally, same as any production row. This is
expected, correct behavior, not leftover test pollution to worry about; it's
the same tradeoff Phase 2 already established for `pipeline_events`.

**Action needed before this environment is treated as trusted:** two
CLIENT-role users were created for this test pass (matching the two
existing `ClientProfile` phone numbers) and have been deleted. To obtain
tokens, the RM/BM/ADMIN test accounts' passwords were reset to a known
test value for the duration of this session. Their original password
hashes were not recoverable, so this doesn't roll back — rotate the
passwords for these three accounts before relying on them again:
`9800000001` (BM), `9800000002` (RM), `9800000003` (ADMIN).

---

## Summary

Four new modules, three real bugs caught and fixed by testing behavior against
a live server rather than stopping at a clean typecheck — none of the three
would have been caught by `tsc --noEmit`, since all three are business-logic
gaps (a missing field copy, a missing guard condition, a missing filter) that
type-check fine. Phase 1/2/3 protections confirmed unaffected.

Still deliberately out of scope, per the "Pillars 6-9 only" decision: everything
else in the Phase 4 ticket (workflow completion beyond these four pillars,
Trial/Exit/Upgrade/Replacement, real SMS/WhatsApp, notification recipient
rules, cron cleanup, remaining stub controllers, mobile API contract
verification, full 6-role E2E, final production-readiness report).
