# Staff app — integration status (start here)

**Audience:** the Flutter developer on `homegennyapp`.
**Checked against:** `homegennyapp` `main` @ `4b30810` ("training module api functionality", 2026-09-29), 2026-09-30.
Everything below is live on the Hostinger server (`https://homegenny.com/api/v1`).

| Brief | Covers |
|---|---|
| [MOBILE_BRIEF_TRAINING_QUIZ.md](MOBILE_BRIEF_TRAINING_QUIZ.md) | Training home, study material, quiz states, submit, result, notifications |
| [MOBILE_BRIEF_STAFF_DOCUMENTS.md](MOBILE_BRIEF_STAFF_DOCUMENTS.md) | Staff uploads their own documents, HR verifies |
| [MOBILE_BRIEF_SELF_REGISTRATION.md](MOBILE_BRIEF_SELF_REGISTRATION.md) | Staff / client sign-up |

## Already done in the app ✅

- Base URL defaults to `https://homegenny.com/api/v1` (no longer Render).
- Training module on the real API: `GET /training/mine`, quiz start / questions / submit / result.
- Quiz model: `correctIndex` removed, answer-type (`TEXT`) questions, all quiz states (`LOCKED`, `SCHEDULED`, `UNDER_REVIEW`, `PASSED`, `FAILED`, …).
- Quiz notifications deep-link from `notifications_screen.dart`.
- Self-registration: `/auth/register/staff` and `/auth/register/customer` wired in `auth_datasource.dart`.
- Video certification upload handles the cloud bucket (absolute signed URL, posted without the Bearer token).

Every path in `ApiConstants` on `main` (107) was checked against the live backend: all the ones the app actually calls exist.

## Still to do

### 1. Staff documents — show the new statuses
`POST /staff/documents` now works (it used to 404). A staff upload lands as
`Pending Verification` until HR verifies it; HR can reject it with a reason.
`GET /staff/documents` rows now include `uploadedBy` and `rejectionRemark`.
The app doesn't handle these yet:

| `status` | Show |
|---|---|
| `Pending Verification` | "Waiting for HR to check" |
| `Rejected` | "Rejected: {rejectionRemark}" + **Upload again** |
| `Verified` / `Expiring Soon` / `Expired` / `Not Available` | as today |

Also handle **409** on upload ("already accepted by HR — ask HR to replace it")
and **413** (over 5 MB). Contract: [MOBILE_BRIEF_STAFF_DOCUMENTS.md](MOBILE_BRIEF_STAFF_DOCUMENTS.md).
Prefer sending `document_type` with HR's exact names (`Police Verification Certificate`, not `Police Verification`).

### 2. Remove dead constants and helpers

| Remove | Where | Why |
|---|---|---|
| `uploadImage`, `uploadVideo`, `uploadDocument` constants + the `uploadImage()/uploadVideo()/uploadDocument()` helpers | `api_constants.dart`, `lib/core/network/api_service.dart` | `/upload/*` was removed from the backend (it never stored files); now 404. Nothing calls the helpers. |
| `staffTasks` (`/staff/tasks/today`) | `api_constants.dart` | No such route; tasks come in `GET /staff/dashboard` → `todayTasks`, which the app already reads. |
| `clientInvoice` (`/client/payments/invoice`) | `api_constants.dart` | No such route and unused; invoice detail is `/client/invoices/{invoiceNumber}`. |

### 3. Video certification on iPhone
The bucket stores every certification video as `video/mp4`. iOS cameras
record `.mov` by default, which may not play in the RM's browser. Record MP4
where the camera plugin allows. (Upload limit 500 MB; send every field in
`fields` unchanged, then `file` last. All earlier video-cert records were
deleted on 2026-09-30, so every prompt starts as "not uploaded".)

## Testing

| Role | Phone | Password |
|---|---|---|
| Trainer | 9800000005 | `hg` |
| HR | 9800000008 | `hg` |
| RM | 9800000002 | `hg` |

For a staff login, ask the backend team for a test staff account — staff
passwords are personal and aren't shared here.
