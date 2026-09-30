# Staff app — integration guide (start here)

**Audience:** the Flutter developer on `homegennyapp`.
**As of:** 2026-09-30. Everything below is live on the Hostinger server.

This is the entry point. Detailed request/response contracts are in the
linked briefs; this file says what to change in the app, file by file.

| Brief | Covers |
|---|---|
| [MOBILE_BRIEF_TRAINING_QUIZ.md](MOBILE_BRIEF_TRAINING_QUIZ.md) | Training home, study material, quiz states, submit, result, notifications |
| [MOBILE_BRIEF_STAFF_DOCUMENTS.md](MOBILE_BRIEF_STAFF_DOCUMENTS.md) | Staff uploads their own documents, HR verifies |
| [MOBILE_BRIEF_SELF_REGISTRATION.md](MOBILE_BRIEF_SELF_REGISTRATION.md) | Staff / client sign-up |

---

## 1. Point the app at Hostinger (do this first)

`lib/core/constants/api_constants.dart` still defaults to the retired Render
server:

```dart
static const String baseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'https://homegennyserver-po5u.onrender.com/api/v1',   // ← old
);
```

Change the default to:

```dart
  defaultValue: 'https://homegenny.com/api/v1',
```

Why it matters: Render has none of the training, document or registration
endpoints, and still has an unfixed login security bug. It's the only place
the Render URL appears in `lib/`.

You can still override per build: `flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3001/api/v1`
for a local backend on the Android emulator.

**Backend coverage check (done 2026-09-30):** all 97 paths in `ApiConstants`
were compared against the live backend's route list. 93 exist. The other 4:
- `uploadImage`, `uploadVideo`, `uploadDocument` (`/upload/*`) — **removed on purpose**, see §5
- `staffTasks` (`/staff/tasks/today`) — unused; today's tasks come inside `GET /staff/dashboard` (`todayTasks`), which the app already reads. Delete the constant.

---

## 2. Training module — replace the dummy data

The screens and routes already exist; only their data is fake. Today every
training call in `staff_repository_impl.dart` is dummy-only:

```dart
getTrainingCategories() => _executor.fetch(dummy: _dummy.getTrainingCategories);
getTrainingCourses(...)  => _executor.fetch(dummy: ...);
getTrainingCourse(id)    => _executor.fetch(dummy: ...);
getQuiz(courseId)        => _executor.fetch(dummy: ...);
submitQuiz(courseId, answers) => _executor.mutate(dummy: ...);
```

The real backend is organised differently — a staff member is in a **batch**,
which has **materials** and **quizzes** — so these methods don't map 1:1.
Replace them rather than bolting `remote:` onto each.

### Data layer

| Replace | With |
|---|---|
| `getTrainingCategories`, `getTrainingCourses`, `getTrainingCourse` | one call, `GET /training/mine` → batches[] with `materials[]` and `quizzes[]`, plus `videoCert {approved, required}` |
| `getQuiz(courseId)` | `POST /training/quizzes/:quizId/start` → attempt + questions (resumes an open attempt) |
| `submitQuiz(courseId, Map<String,int>)` | `POST /training/quizzes/attempts/:attemptId/submit` with `answers: [{question_id, selected_option}]` or `{question_id, answer_text}` |
| — (new) | `GET /training/quizzes/attempts/:attemptId/result` |

Models in `lib/features/staff/domain/models/staff_models.dart`:
- `TrainingCategory` — no backend equivalent; drop it.
- `TrainingCourse` → split into **Material** (`id, type VIDEO|PDF|NOTE, title, body, sizeBytes, viewUrl`) and **Quiz** (`id, title, questionCount, totalPoints, passMarks, state, opensAt, attemptId, rescheduleNote, lastResult, attempts`).
- `QuizQuestion` — **remove `correctIndex`** (the server never sends the answer key); add `type` (`MCQ`/`TEXT`), `points`; `options` is `null` for `TEXT`.
- `QuizResult {score,total,passed}` → `{state, score, maxScore, passMarks, passed, pendingReview}`; `score`/`passed` are `null` while `UNDER_REVIEW`.

### Screens (`lib/features/staff/presentation/screens/training/training_screens.dart`)

| Screen | Change |
|---|---|
| `StaffTrainingScreen` (home, `/staff/training`) | Build from `GET /training/mine`. Top: batch card — batch code, trainer, classroom, start–end date, quiz date. A "Video certification {approved}/{required}" line. Then **Study material** list, then **Quizzes** list, each card driven by `state` (table in the quiz brief). Keep showing it after the staff reaches S4/S5 — a quiz can be rescheduled later. |
| `StaffTrainingCategoriesScreen` | Remove (no categories on the backend) — or turn into a filter by material `type`. |
| `StaffVideoPlayerScreen` (`/training/video/:id`) | Play `viewUrl`. If it starts with `http` it's a signed bucket link — use as-is, **no auth header**, expires in 1 h (re-fetch `/training/mine`, don't cache it). Otherwise prefix the host and send `Authorization: Bearer …` (`VideoPlayerController.networkUrl(uri, httpHeaders: …)`). Since 2026-09-30 the server is on the bucket, so expect the `http` case. |
| `StaffPdfReaderScreen` (`/training/pdf/:id`) | `viewUrl` is always relative (`/api/v1/training/materials/pdf-file?key=…`) and needs the Bearer header — download the bytes with the token, then render. Note: `viewUrl` already starts with `/api/v1`, so prefix only the host (`https://homegenny.com`), not `baseUrl`. |
| (new) Note viewer | `NOTE` materials have no URL — show `body` text. |
| `StaffQuizScreen` (`/training/quiz/:id`, id = **quiz id**) | Call start, render the returned `questions`. MCQ → radio list; `TEXT` → multi-line text field. Keep answers in memory, submit once. Warn before submitting with unanswered questions (they count as wrong). On **409** show the message (locked / rescheduled / under review / passed / failed) and go back. |
| `StaffTrainingResultScreen` (`/training/result/:id`, id = **attempt id**) | `GET …/attempts/:attemptId/result`. Show `score/maxScore`, pass marks, Pass/Fail, and ✔/✘ per question with the option the staff picked. There is **no** correct-answer field by design. `UNDER_REVIEW` → "Trainer is checking your answers". |
| `StaffCertificateScreen` | No certificate endpoint — hide the button in the result screen for now. |

### Notifications (`notifications_screen.dart`)

`GET /staff/notifications` rows now carry `type` + `data`. Route on tap:
`QUIZ_PASSED` / `QUIZ_FAILED` → `/staff/training/result/{data.attemptId}`,
`QUIZ_RESCHEDULED` → `/staff/training`. `type` can be `null` on old rows.

---

## 3. Video certification — already works, now on the cloud bucket

`staff_repository_impl.dart uploadVideoCert` + `staff_datasource.dart uploadVideoCertFile`
already handle both server modes: an absolute `uploadUrl` is posted with a
bare `Dio()` (so the Bearer token never goes to Google), a relative one
through the authenticated client. **No code change is required.** Verified
2026-09-30 by running the app's exact sequence against the bucket:
upload-url → POST to `storage.googleapis.com` (204) → verify-hash →
finalize → RM plays it back.

Things to know:
- The server switched to the bucket on 2026-09-30, so `uploadUrl` is now
  `https://storage.googleapis.com/homegenny/` plus policy `fields`. Send
  **every** field in `fields` unchanged, then `file` last.
- Max 500 MB. The object is always stored as `video/mp4` (the policy fixes
  it), so record MP4 where the camera plugin allows — iOS defaults to `.mov`.
- `promptKey` is the app's `prompt_1…prompt_N` id; finalize/register now
  return **400** (not 500) if `promptKey`, `staffId`, `gcsKey` or the hash is missing.
- A staff member can only request upload links for their own record (403 otherwise).
- All earlier video-cert records were deleted on 2026-09-30, so every
  prompt starts as "not uploaded".

---

## 4. Staff documents

`POST /staff/documents` now exists (the Upload Document screen always called
it and got 404). Uploads land as `Pending Verification` until HR verifies.
`GET /staff/documents` adds `uploadedBy` and `rejectionRemark`. Full contract
and status table: [MOBILE_BRIEF_STAFF_DOCUMENTS.md](MOBILE_BRIEF_STAFF_DOCUMENTS.md).

---

## 5. Removed endpoints — delete from the app

| Remove | Where |
|---|---|
| `uploadImage`, `uploadVideo`, `uploadDocument` constants | `api_constants.dart` |
| `uploadImage()`, `uploadVideo()`, `uploadDocument()` helpers | `lib/core/network/api_service.dart` |
| `staffTasks` constant | `api_constants.dart` |

`/upload/*` never stored anything (it returned a fake URL) and nothing
called it; it now returns 404.

---

## 6. Testing

| Role | Phone | Password |
|---|---|---|
| Trainer (creates batch, material, quiz; checks answers) | 9800000005 | `hg` |
| HR (verifies documents) | 9800000008 | `hg` |
| RM (reviews video certs) | 9800000002 | `hg` |

For a staff login, ask the backend team for a test staff account on the
Hostinger server — staff passwords are personal and aren't shared here.

End-to-end check for the training module:
1. Trainer → Batches → create a batch (no quiz date), add the staff, open
   *Manage Material & Quiz*, add a note/PDF/video and a quiz with one MCQ and
   one answer-type question.
2. App → Training: batch + material + quiz (`AVAILABLE`) appear.
3. Take the quiz → `UNDER_REVIEW`.
4. Trainer → Assessments → Check → mark the text answer ✘ → Finalize → staff gets `QUIZ_FAILED`, card shows `FAILED`.
5. Trainer → Reschedule to a few minutes ahead → staff gets `QUIZ_RESCHEDULED`, card shows `SCHEDULED`, then `AVAILABLE`.
6. Retake → trainer marks ✔ → `PASSED`, result screen shows ✔/✘ per question.
