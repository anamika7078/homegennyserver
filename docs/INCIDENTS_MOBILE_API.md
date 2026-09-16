# Incidents & Client Complaints — Mobile API

API reference for the HomeGenny Flutter app. Covers the **CLIENT** role (filing and
tracking a complaint) and the **RM/BM** roles (working an incident through to close).

Base URL: `{host}/api/v1` · All endpoints require `Authorization: Bearer <access_token>`.

Responses are wrapped by the global interceptor as `{ success, data, timestamp }` — the
shapes below describe the **`data`** payload.

---

## 1. Concepts

A **complaint** and an **incident** are the same record. A client "files a complaint";
internally it becomes an `Incident` row that RM/BM work through a status machine.

```
OPEN ──acknowledge(RM)──▶ INVESTIGATING ──resolve──▶ RESOLVED ──close(BM)──▶ CLOSED
  │                             │                        ▲
  └────────escalate(RM)─────────┴──▶ ESCALATED ──resolve─┘
```

An incident is **separate from the staff pipeline**. Filing one does not change the staff
member's `pipeline_stage`, does not defer them, and does not terminate them. Do not build
UI that implies otherwise.

### Enums

`status` — `OPEN`, `INVESTIGATING`, `ESCALATED`, `RESOLVED`, `CLOSED`

`type` — **six live values.** These are the only ones the API accepts today:

| Value | Label |
|---|---|
| `CLIENT_COMPLAINT` | Client Complaint |
| `STAFF_MISCONDUCT` | Staff Misconduct |
| `SAFETY_ISSUE` | Safety Issue |
| `ATTENDANCE_FRAUD` | Attendance Fraud |
| `DRIVING_VIOLATION` | Driving Violation |
| `LATE_EXIT` | Late Exit |

> ⚠️ **Do not send any other value.** Five further categories —
> `SCOPE_VIOLATION`, `ABSENTEEISM`, `CONDUCT`, `PROPERTY_DAMAGE`,
> `INVOICE_DISPUTE` — appear in the spec and in a migration file, but the
> migration has not been applied and the Prisma enum was never updated to match.
> Sending one returns **500**, not a 400, because Prisma rejects it before any
> validation runs. Keep your type list to the six above; the other five will be
> announced when they go live.

---

## 2. CLIENT — file a complaint

### `POST /client/complaints` — multipart

This is the endpoint the existing `ClientRemoteDataSource.raiseComplaint()` already targets.

```
Content-Type: multipart/form-data

subject        required   string
description    required   string
images[]       optional   file[]      ⚠️ see "Images" below
staff_id       optional   uuid        defaults to your active placement's staff
type           optional   enum        defaults to CLIENT_COMPLAINT
title          optional   string      defaults to subject
evidence_urls  optional   string[]    plain URLs — these ARE stored
```

**201**
```json
{
  "success": true,
  "ticketNumber": "8f1c…",
  "status": "OPEN",
  "imagesReceived": 2,
  "imagesStored": 0,
  "warning": "Image uploads are not stored yet — send evidence_urls for evidence that must persist.",
  "message": "Complaint submitted to RM and Branch Manager."
}
```

`ticketNumber` is the incident id — use it for `GET /incidents/:id` and for commenting.

**Errors**
| Code | Meaning |
|---|---|
| 400 | `No customer account linked to this login` — the login has no `FinanceCustomer` |
| 400 | `No active placement to file a complaint against` |
| 403 | The `staff_id` is not deployed to this client |

### Images

`images[]` is **optional** and currently **not persisted**. The server accepts the upload
and discards it; the response reports `imagesReceived` / `imagesStored: 0` and adds a
`warning` when files were sent.

Recommended app behaviour for now:
- Keep the attach-photo control optional.
- If `imagesStored` is `0` while `imagesReceived > 0`, do **not** show the photos as
  attached to the submitted ticket.
- For evidence that must survive, upload via your existing upload flow and pass the
  resulting URLs in `evidence_urls`.

File storage for this endpoint is a separate piece of work; `imagesStored` will start
returning a non-zero count when it lands, so gate the UI on that field rather than on a
build flag.

### `POST /incidents` — JSON alternative

Same result, no file upload. Use when there is nothing to attach.

```json
{
  "staff_id": "…",              // REQUIRED here (unlike /client/complaints)
  "type": "SCOPE_VIOLATION",
  "title": "Asked to do work outside the agreed scope",
  "description": "…",           // optional
  "evidence_urls": ["https://…"] // optional
}
```

---

## 3. CLIENT — read complaints back

### `GET /client/complaints`

> **This endpoint exists and works.** The app currently resolves `getComplaints()` from
> dummy data because of a stale comment in `client_repository_impl.dart` claiming the
> endpoint is missing. Wire the `remote:` branch to this.

```json
{
  "complaints": [
    {
      "ticketNumber": "8f1c…",
      "type": "CLIENT_COMPLAINT",
      "status": "INVESTIGATING",
      "title": "Staff arrived 2 hours late",
      "description": "…",
      "staffName": "Pooja",
      "staffCode": "pooja001",
      "resolution": null,
      "resolvedAt": null,
      "raisedAt": "2026-09-16T06:35:04.778Z"
    }
  ],
  "total": 1
}
```

Newest first. `resolution` fills in once RM/BM resolve it — good thing to surface in the
client's ticket detail screen.

> Note the field names here differ from the `/incidents` shapes: this endpoint returns
> `ticketNumber` (not `id`), `raisedAt` (not `createdAt`), and flattens the staff member
> to `staffName` / `staffCode`. It is the only endpoint shaped this way.

### `GET /incidents` (CLIENT)

Returns this client's incidents in the richer list shape (see §4). Either endpoint works;
`/client/complaints` has the flatter, app-friendlier shape.

### `GET /incidents/:id`

Full detail including the comment thread.

Verified against a live response:

```json
{
  "id": "8f1c…",
  "staffId": "…", "clientId": "…", "placementId": "…", "rmId": "…", "branchId": "…",
  "type": "CLIENT_COMPLAINT",
  "status": "INVESTIGATING",
  "title": "…",
  "description": "…",
  "evidenceUrls": [],
  "resolution": null,
  "legalHold": false,
  "metadata": {},
  "resolvedAt": null,
  "createdAt": "…",
  "updatedAt": "…",
  "staff": { "id": "…", "staffCode": "pooja001", "fullName": "Pooja", "series": "MAID", "pipelineStage": "S5_DEPLOY" },
  "comments": [ { "id": "…", "actorId": "…", "body": "Visiting site tomorrow.", "createdAt": "…" } ]
}
```

403 if the incident is not this client's.

### `POST /incidents/:id/comment`

```json
{ "body": "The staff member was on time all week since." }
```

Clients **can** comment on their own incidents. Clients **cannot** acknowledge, escalate,
resolve or close — those return **403**. Show the status as read-only on the client side.

---

## 4. RM / BM — work the incident

### `GET /rm/incidents?status=`

RM inbox, scoped to the incidents assigned to the calling RM. Optional `status` filter.

### `GET /incidents?status=`

Role-scoped list, same row shape:

| Role | Sees |
|---|---|
| CLIENT | their own |
| RM | assigned to them |
| BM | their action queue — `ESCALATED` + `RESOLVED` |
| ADMIN | everything |

Row shape (verified against a live response):
```json
{
  "id": "…", "staffId": "…", "clientId": "…", "placementId": "…", "rmId": "…", "branchId": "…",
  "type": "CLIENT_COMPLAINT", "status": "OPEN",
  "title": "…", "description": "…", "evidenceUrls": [],
  "resolution": null, "legalHold": false, "metadata": {},
  "resolvedAt": null, "createdAt": "…", "updatedAt": "…",
  "staff": { "id": "…", "staffCode": "pooja001", "fullName": "Pooja", "series": "MAID" },
  "_count": { "comments": 3 }
}
```

`staff` and `_count.comments` are included so a list row is renderable without a second
request per row.

### `POST /rm/incidents` — RM raises one

```json
{
  "staff_id": "…",        // optional, but send it — routing depends on it
  "type": "STAFF_MISCONDUCT",
  "title": "…",
  "description": "…",     // optional
  "evidence_urls": []     // optional
}
```

The server derives `rm_id` from the staff member's assigned RM (not from whoever is
logged in) and back-fills `client_id` / `placement_id` from the staff member's active
placement. An RM may only raise one against their own assigned staff (403 otherwise).

### Workflow actions

| Endpoint | Roles | Legal from | Body |
|---|---|---|---|
| `POST /incidents/:id/acknowledge` | RM, ADMIN | `OPEN` | — |
| `POST /incidents/:id/escalate` | RM, ADMIN | `OPEN`, `INVESTIGATING` | — |
| `POST /incidents/:id/resolve` | RM, BM, ADMIN | `OPEN`, `INVESTIGATING`, `ESCALATED` | `{ "resolution": "…" }` **required, non-blank** |
| `POST /incidents/:id/close` | BM, ADMIN | `RESOLVED` | — |
| `POST /incidents/:id/comment` | RM, BM, ADMIN, CLIENT | any | `{ "body": "…" }` |
| `POST /incidents/:id/legal-hold` | ADMIN | any | `{ "hold": true }` |

An illegal transition returns **400** with the allowed set in the message:
```
Cannot move incident from RESOLVED to INVESTIGATING (allowed from: OPEN)
```
A role that is not permitted returns **403**.

Gate buttons on **both** the caller's role and the current status so the user is never
offered a move that will 400. `CLOSED` is terminal — there is no reopen endpoint.

Escalating also raises a BM-visible escalation record; resolving or closing clears it.
The app does not need to do anything for that.

---

## 5. Known gaps

Things that are deliberately not wired yet — build around them, don't work around them:

1. **Image uploads are not stored.** See §2. Use `evidence_urls`.
2. **No SLA or auto-timeout.** An incident stays `OPEN` indefinitely; nothing nudges. If
   you want an "ageing" badge, compute it client-side from `createdAt`.
3. **No push notification on status change.** Poll or pull-to-refresh.
4. **No incident → pipeline effect.** Repeated complaints do not flag, defer, or terminate
   a staff member. Don't imply escalation consequences in copy.
5. **No reopen.** Once `CLOSED`, a new incident has to be filed.
6. **Five incident types are not live.** See §1 — sending one is a 500.

## 5b. Verification status

The RM/BM half of this document is verified end-to-end against a running server
(`scratch/_live_test_client_complaints.js`, 26 checks): filing, routing to the assigned
RM, every status transition, the role gates, and the response shapes above.

The CLIENT half — `POST /client/complaints`, `GET /client/complaints` — is documented from
the controller source and has **not** been exercised over HTTP, because no client test
credential was available. Treat the CLIENT request/response shapes as accurate but
unproven; if something does not match, say so rather than working around it.

---

## 6. Quick reference

```
CLIENT
  POST   /client/complaints          multipart: subject, description, images[]?
  POST   /incidents                  json: staff_id, type, title, description?
  GET    /client/complaints          list (flat shape)
  GET    /incidents                  list (rich shape)
  GET    /incidents/:id              detail + comments
  POST   /incidents/:id/comment      { body }

RM / BM
  GET    /rm/incidents?status=       RM inbox
  POST   /rm/incidents               raise
  GET    /incidents?status=          role-scoped list
  GET    /incidents/:id              detail + comments
  POST   /incidents/:id/acknowledge  RM  · from OPEN
  POST   /incidents/:id/escalate     RM  · from OPEN|INVESTIGATING
  POST   /incidents/:id/resolve      RM/BM · { resolution } required
  POST   /incidents/:id/close        BM  · from RESOLVED
  POST   /incidents/:id/comment      { body }
  POST   /incidents/:id/legal-hold   ADMIN · { hold }
```

Live Swagger: `{host}/api/docs` → **Incidents** and **Client Mobile App** tags.
