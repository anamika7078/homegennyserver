# HomeGenny — Staff Mobile App: Video Certification Upload (Pillar 5)

You are working on the **HomeGenny Flutter mobile application**, specifically the **STAFF** role's
video self-certification flow. This is the only side of the flow that lives in this app — the
Trainer role does not exist in this mobile app at all (confirmed: no `trainer` feature folder, no
`TRAINER` in `UserRole`), and Trainer review already happens correctly on the **web app**
(`/trainer/video-cert`), which is real and correctly wired today. Do not build any reviewer-side
UI here — only fix the staff upload side.

---

## 1. Confirmed: the backend already routes this correctly — no backend fix needed

Before touching anything, this was verified by reading the backend source directly: once a video
is properly registered, `TrainerService.getVideoCerts()` (the query backing both
`GET /trainer/video-certifications` and the Trainer dashboard's pending list) joins
`video_certifications → staff_applicants` and filters by `staff_applicants.branch_id = <trainer's
own branchId>`. As long as the uploading staff member's branch matches a trainer's branch, the
video **will** appear in that trainer's real review queue automatically. There is no missing
backend wiring for "does the video reach the trainer" — the only broken link is that the mobile
app's current upload screen never calls the real API at all.

---

## 2. The full loop — who does what

This is a two-actor flow, same shape as the PV flow (`PV_VERIFICATION_CLAUDE_PROMPT.md` §2):

```text
Staff (this app): record + upload video for each prompt   → §4 below
Trainer (web app, already real): review + approve/reject   → PUT /trainer/video-certifications/:id/review
RM (mobile or web): advance the stage once training is done → POST /rm/pipeline/:staffId/advance
                                                                 { to_stage: "S4_AGREEMENTS" }
   ↓
Staff app: GET /staff/pipeline (already real, already wired — confirmed `remote: _remote.getPipeline`
   in staff_repository_impl.dart) automatically shows S3_TRAIN as "completed" the moment RM's
   advance call lands — no separate staff-side wiring needed for this part, same as the PV flow.
```

⚠️ Unlike PV, there is currently **no backend gate** enforcing that a candidate's video certs are
actually approved (or an assessment passed) before RM can advance S3_TRAIN → S4_AGREEMENTS — this
is a separate, already-flagged backend gap (tracked elsewhere, not part of this prompt). It doesn't
change what to build here: upload real videos, let the real Trainer review flow work as designed,
and trust `GET /staff/pipeline` to reflect whatever the backend's true stage is — don't build any
client-side logic that tries to infer or force "S3 complete" locally.

## 3. Confirmed: the current screen is 100% local/dummy — this is the actual bug

`lib/features/staff/presentation/screens/video_certification/video_certification_screens.dart`
reads from `staffVideoCertProvider`, which calls
`staffRepositoryProvider.getVideoCertPrompts()`/`.uploadVideoCert()`. In
`staff_repository_impl.dart`:
```dart
Future<Result<List<VideoCertPrompt>>> getVideoCertPrompts() =>
    _executor.fetch(local: () async => ..., dummy: _dummy.getVideoCertPrompts);

Future<Result<void>> uploadVideoCert(String promptId) =>
    _executor.mutateVoid(dummy: () async { await _local.uploadVideoCert(promptId); await _dummy.uploadVideoCert(promptId); });
```
Neither call has a `remote:` argument — compare to a correctly-wired method in the same file, e.g.
`getDashboard()`, which does `_executor.fetch(remote: _remote.getDashboard, ...)`. Confirmed
`StaffRemoteDataSource` (`staff_datasource.dart`) has **zero** video-cert methods defined at all —
this needs to be added from scratch, following the exact pattern already used for every other
correctly-wired staff feature in that same class.

---

## 4. Real APIs to wire

```text
GET  /video-cert/prompts/:series
Roles: STAFF, RM, BM, ADMIN
→ returns the list of required prompts for the staff's own series (DR/SC/UC/MAID)

POST /video-cert/upload-url
Roles: STAFF, ADMIN
Body: { staffId, series, filename, sha256Hash? }
→ returns { uploadUrl, gcsKey, fields }
```
⚠️ **Read `uploadUrl` from the response and use it as-is — do not hardcode either GCS or the local
endpoint.** The backend is currently running in a local-disk storage jugaad (no GCS bucket
configured yet): in that mode `uploadUrl` comes back as the relative path
`/api/v1/video-cert/local-upload` and the app must `POST` the raw file there as
`multipart/form-data` (field name `file`, plus a `key` field set to the returned `gcsKey`) —
against the same base URL as every other API call. Once a real GCS bucket is configured later,
`uploadUrl` will instead be a real signed GCS POST URL with `fields` to submit alongside the file —
handle both shapes generically by always trusting what the response says, so this keeps working
with zero app changes when the backend switches modes.

```text
POST /video-cert/verify-hash          (optional — sanity check before finalize)
Body: { key, expectedHash }
→ { valid: boolean }

POST /video-cert/finalize             (preferred over /register — this one re-verifies the hash)
Roles: STAFF, ADMIN
Body: { staffId, promptKey, gcsKey, expectedHash, attemptNumber? }
→ creates the real VideoCertification DB row with reviewStatus: 'PENDING' — this is the point at
  which the video becomes visible to the Trainer.

GET  /video-cert/list/:staffId
Roles: STAFF, RM, BM, ADMIN
→ the staff's own upload history with reviewStatus (PENDING/APPROVED/REJECTED) per prompt — use
  this to drive the screen's per-prompt status badges, not local state.
```

Compute the SHA-256 hash client-side after recording (before calling `upload-url`/`finalize`) —
standard hashing, any Dart crypto package already in the project's dependencies.

---

## 5. Flow to implement

```text
Load prompts (GET /video-cert/prompts/:series, staff's own series from their profile)
 ↓
For each incomplete prompt:
   Record video
    ↓
   Compute SHA-256 locally
    ↓
   POST /video-cert/upload-url  → { uploadUrl, gcsKey, fields }
    ↓
   Upload the raw file to `uploadUrl` (multipart, per §3's local/GCS handling)
    ↓
   POST /video-cert/finalize  → { staffId, promptKey, gcsKey, expectedHash: <the hash>, attemptNumber }
    ↓
   Refresh GET /video-cert/list/:staffId → prompt now shows "Pending Trainer Review"
```

Do not mark a prompt as "done" locally before `finalize` succeeds. Do not skip `upload-url` and
guess a key — the key format embeds series/staffId/timestamp and must come from the server.

---

## 6. Repository/datasource changes

Add to `StaffRemoteDataSource`: `getVideoCertPrompts(series)`, `getUploadUrl(...)`,
`uploadLocalFile(uploadUrl, key, bytes)` (or a generic multipart uploader if one already exists
elsewhere in the app — reuse it), `finalizeUpload(...)`, `getVideoCertList(staffId)`. Wire
`staff_repository_impl.dart`'s existing methods to call these via `remote:`, matching the pattern
every already-correct method in that file uses. Keep the `dummy:`/`local:` fallbacks only for
offline/demo mode if the app's executor pattern requires one (check how other real features handle
this — don't invent a new convention).

---

## 7. Error handling / states

Loading/empty/error/retry on prompt list and upload history. Disable the record/upload button
while a request is in flight. Show upload progress if the executor/network layer supports it — a
500MB video (the backend's own upload limit) can take a while on mobile data. Surface the backend's
actual error message on `finalize` hash-mismatch or any 400, don't show a generic failure.

---

## 8. End-to-end test — the actual proof this works

Test the **full loop across both apps**, not just the upload API calls in isolation:

1. As Staff: record + upload all required prompts for your series, through to `finalize`.
2. As Staff: reload the video-cert screen — confirm every prompt now shows "Pending Trainer
   Review" (from `GET /video-cert/list/:staffId`), not still "Not Started."
3. On the web app, log in as Trainer: confirm the same uploads appear in `/trainer/video-cert`
   (proves the branch-scoped backend query in §1 actually picked them up).
4. As Trainer (web): approve each one.
5. As RM: once satisfied, call `POST /rm/pipeline/:staffId/advance` with
   `to_stage: "S4_AGREEMENTS"`.
6. As Staff: reload `GET /staff/pipeline` — confirm S3_TRAIN now shows `completed`. If this last
   step doesn't update, the bug is in the staff pipeline screen not re-fetching, not in the upload
   flow built here.

## 9. Final deliverable

Report:
- `StaffRemoteDataSource` methods added, listed.
- `staff_repository_impl.dart` methods now calling `remote:` instead of only `dummy:`/`local:`.
- Confirm the full record → hash → upload-url → upload → finalize sequence was tested against the
  real local backend and a resulting `VideoCertification` row appeared with `reviewStatus:
  'PENDING'`.
- Confirm the §8 end-to-end test was actually run across both apps (staff upload → web Trainer
  approval → RM advance → staff sees S3 completed), not just the upload calls checked in isolation.
- Confirm you did NOT build any Trainer-facing screen in this app.
