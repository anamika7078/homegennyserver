# Mobile app change needed — Staff Training module (study material + quiz)

**Audience:** the Flutter developer building the staff app's Training screens.
**Backend status:** built and live-tested locally on 2026-09-29 (52/52 checks),
**not yet deployed to the Hostinger server** — you'll get a heads-up when it is.

## Read this first — two things that will bite you

1. **Point the app at Hostinger, not Render.** `lib/core/constants/api_constants.dart`
   still defaults `baseUrl` to `https://homegennyserver-po5u.onrender.com/api/v1`.
   That server is retired, doesn't have any of these endpoints, and still has an
   unfixed login security bug. Build with
   `--dart-define=API_BASE_URL=<Hostinger URL>/api/v1` or change the default.
2. **The existing dummy quiz model is not compatible — replace it, don't adapt it.**
   See [What changes vs the current dummy code](#what-changes-vs-the-current-dummy-code).
   Most important: the real API **never sends the correct answer** to the app.
   `QuizQuestion.correctIndex` must go — the server marks answers, not the phone.

## How the feature works (product rules)

- A trainer puts staff in a **batch** (start date, end date, optional quiz date).
  The batch has **study material** (video / PDF / note) and one or more **quizzes**.
- Each quiz question is **MCQ** or **answer-type** (free text), each with its own
  **marks**. The trainer sets **pass marks** per quiz (default 60% of the total).
- A quiz opens on the batch's **quiz date** (if one is set). Before that it is `LOCKED`.
- On submit, MCQ is marked instantly. Answer-type questions wait for the trainer
  to mark ✔/✘ on the web (`UNDER_REVIEW`). An unanswered question counts as ✘.
- **Failing never blocks the staff's pipeline.** There is **no automatic retake** —
  the quiz stays `FAILED` until the trainer reschedules it. Then it shows as
  `SCHEDULED` with a date/time, and opens at that time.
- After grading, the staff sees their marks and ✔/✘ per question, but **not the
  correct answer** (the retake uses the same questions).
- The Training module must stay visible even after the staff moves on to
  S4/S5 — a rescheduled quiz can arrive later. Don't hide it by pipeline stage.

## Endpoints

All need the staff's Bearer token. Responses use the usual `{ success, data }`
envelope — shapes below are the `data` part.

| What | Method + path |
|---|---|
| Training home (everything) | `GET /training/mine` |
| Quiz list only (same quiz objects) | `GET /training/quizzes/mine` |
| Start / resume a quiz | `POST /training/quizzes/:quizId/start` |
| Questions for an attempt (if you need them again) | `GET /training/quizzes/attempts/:attemptId/questions` |
| Submit answers | `POST /training/quizzes/attempts/:attemptId/submit` |
| Result | `GET /training/quizzes/attempts/:attemptId/result` |
| Open a PDF / video | the material's `viewUrl` (see below) |
| Notifications (existing) | `GET /staff/notifications` |

### `GET /training/mine` — the training home screen

One call gives the whole screen. Real response, trimmed:

```json
{
  "staff": { "id": "9056ec93-…", "fullName": "Hunesh Sharma", "staffCode": "hunesh001", "series": "MAID", "pipelineStage": "S3_TRAIN" },
  "videoCert": { "approved": 0, "required": 9 },
  "batches": [
    {
      "id": "98ff0d3c-…",
      "batchCode": "TRN-M3X-2026-0975076",
      "series": "MAID",
      "trainerName": "Sunita Trainer",
      "classroom": "Room A",
      "status": "UPCOMING",
      "startDate": "2026-09-29",
      "endDate": "2026-10-04",
      "quizDate": "2026-10-02",
      "enrolledAt": "2026-09-29T07:36:26.968Z",
      "materials": [
        { "id": "…", "type": "NOTE",  "title": "Read this", "body": "Notes body", "sizeBytes": null, "viewUrl": null, "createdAt": "…" },
        { "id": "…", "type": "PDF",   "title": "Safety rules", "body": null, "sizeBytes": 182044, "viewUrl": "/api/v1/training/materials/pdf-file?key=…", "createdAt": "…" },
        { "id": "…", "type": "VIDEO", "title": "Day 1 intro", "body": null, "sizeBytes": null, "viewUrl": "/api/v1/training/materials/local-file?key=…", "createdAt": "…" }
      ],
      "quizzes": [ { "…": "quiz object, see next section" } ]
    }
  ]
}
```

- `startDate` / `endDate` / `quizDate` are plain `YYYY-MM-DD` dates (no time,
  no timezone) — show them as-is, don't parse them into a UTC `DateTime`, or they
  can shift a day.
- `batches` is newest first. Usually there is one; a re-trained staff can have more.
- `videoCert` is for a progress line like "Video certification 3/9 approved" —
  S3 can only be completed once it's full (or the RM overrides).

### Material `viewUrl`

- `NOTE` → no URL, show `body`.
- `PDF` → a **relative** URL on our API. Prefix the API host (without the
  trailing `/api/v1` duplication — the value already starts with `/api/v1`) and
  send the `Authorization: Bearer …` header. A PDF viewer that can't send headers
  won't work; download the bytes with the token, then show the file.
- `VIDEO` → today also a relative URL that needs the Bearer header
  (`video_player`'s `VideoPlayerController.networkUrl(..., httpHeaders: {...})`
  supports this). Later, when cloud storage is switched on, this becomes a full
  `https://storage.googleapis.com/…` signed URL that needs **no** header and
  expires after 1 hour. **Handle both:** if `viewUrl` starts with `http`, use it
  as-is; otherwise prefix the host and add the header. Don't cache the URL —
  re-fetch `/training/mine` to get a fresh one.
- A staff can only open material from batches they're enrolled in (403 otherwise).

### The quiz object and its `state`

```json
{
  "id": "c4ba5028-…",
  "batchId": "98ff0d3c-…",
  "batchCode": "TRN-M3X-2026-0975076",
  "title": "Day 1 Recap",
  "questionCount": 3,
  "totalPoints": 6,
  "passMarks": 4,
  "quizDate": "2026-10-02",
  "state": "FAILED",
  "opensAt": null,
  "attemptId": "1fc8e604-…",
  "rescheduleNote": null,
  "lastResult": { "attemptId": "1fc8e604-…", "score": 2, "maxScore": 6, "passed": false, "gradedAt": "…" },
  "attempts": [
    { "attemptId": "1fc8e604-…", "attemptNumber": 1, "status": "GRADED", "score": 2, "maxScore": 6, "passed": false, "submittedAt": "…", "gradedAt": "…" }
  ]
}
```

Drive the quiz card entirely off `state` — don't re-derive it from dates yourself:

| `state` | Show | Button |
|---|---|---|
| `LOCKED` | "Quiz opens on {opensAt}" — `opensAt` is a `YYYY-MM-DD` date | none |
| `SCHEDULED` | "Retake on {opensAt}" — `opensAt` is a full ISO date-time; show `rescheduleNote` if present | none |
| `AVAILABLE` | "{questionCount} questions · {totalPoints} marks · Pass {passMarks}" (+ `rescheduleNote` if it's a retake) | **Start** |
| `IN_PROGRESS` | "Continue your quiz" | **Continue** (calls start again — it resumes) |
| `UNDER_REVIEW` | "Submitted — trainer is checking your answers" | none |
| `PASSED` | "Passed · {lastResult.score}/{lastResult.maxScore}" | **View result** |
| `FAILED` | "{lastResult.score}/{lastResult.maxScore} — trainer will reschedule" | **View result** |

`SCHEDULED` turns into `AVAILABLE` by itself once `opensAt` passes. Refresh the
screen when it comes back to the foreground — there's no push for that moment.

### `POST /training/quizzes/:quizId/start`

No body. Starts a new attempt, or resumes the open one. Returns the attempt
**with its questions**, so you usually don't need the separate questions call:

```json
{
  "id": "68c7f72e-…",
  "quizId": "c4ba5028-…",
  "status": "IN_PROGRESS",
  "title": "Day 1 Recap",
  "totalPoints": 6,
  "passMarks": 4,
  "questions": [
    { "id": "125cbf7b-…", "questionText": "What is the speed limit near a school?", "type": "MCQ", "options": ["20 km/h", "40 km/h", "60 km/h"], "orderIndex": 0, "points": 2 },
    { "id": "47f73c2d-…", "questionText": "How would you handle a medical emergency?", "type": "TEXT", "options": null, "orderIndex": 2, "points": 3 }
  ]
}
```

There is no `correctOption` / `correctIndex` in this payload, by design.

**409 Conflict** means the quiz can't be started right now — `LOCKED`,
`SCHEDULED` (not open yet), `UNDER_REVIEW`, `PASSED`, or `FAILED` (waiting on the
trainer). Show the `message` and refresh `/training/mine`. **403** means the staff
isn't in that batch.

### `POST /training/quizzes/attempts/:attemptId/submit`

```json
{
  "answers": [
    { "question_id": "125cbf7b-…", "selected_option": 1 },
    { "question_id": "47f73c2d-…", "answer_text": "Call the family, then 108, and keep the patient still." }
  ]
}
```

- `selected_option` is the **0-based index** into that question's `options`.
- Send `answer_text` for `TEXT` questions. Leaving a question out, or sending
  empty text, marks it ✘ — warn the staff before submitting with gaps.
- Submit once. There's no draft-save; keep answers in memory/Hive until submit.

Response:

```json
{ "attemptId": "68c7f72e-…", "state": "UNDER_REVIEW", "pendingReview": true,  "score": null, "maxScore": 6, "passMarks": 4, "passed": null }
{ "attemptId": "68c7f72e-…", "state": "FAILED",       "pendingReview": false, "score": 2,    "maxScore": 6, "passMarks": 4, "passed": false }
```

`UNDER_REVIEW` whenever the quiz has an answered TEXT question; an MCQ-only quiz
comes back `PASSED`/`FAILED` immediately.

### `GET /training/quizzes/attempts/:attemptId/result`

```json
{
  "attemptId": "68c7f72e-…",
  "title": "Day 1 Recap",
  "state": "PASSED",
  "score": 5, "maxScore": 6, "passMarks": 4, "passed": true,
  "gradedAt": "2026-09-29T07:36:27.637Z",
  "questions": [
    { "questionId": "…", "questionText": "…", "type": "MCQ",  "options": ["20 km/h","40 km/h","60 km/h"], "points": 2, "yourSelectedOption": 1, "yourAnswerText": null, "correct": true,  "pointsAwarded": 2 },
    { "questionId": "…", "questionText": "…", "type": "MCQ",  "options": ["Yes","No"],                     "points": 1, "yourSelectedOption": 0, "yourAnswerText": null, "correct": false, "pointsAwarded": 0 },
    { "questionId": "…", "questionText": "…", "type": "TEXT", "options": null,                             "points": 3, "yourSelectedOption": null, "yourAnswerText": "…", "correct": true, "pointsAwarded": 3 }
  ]
}
```

Show ✔/✘ and marks per question, and highlight the option **the staff picked** —
there is intentionally no field telling you which option was right. For an
attempt still under review this returns `state: "UNDER_REVIEW"` with an empty
`questions` list. Past attempts: every entry in the quiz's `attempts` list has
an `attemptId` you can pass here.

## Notifications

The existing `GET /staff/notifications` now also returns `type` and `data`:

```json
{ "id": "…", "title": "Quiz rescheduled", "body": "\"Day 1 Recap\" ab 5 Oct 2026, 10:00 am ko khulegi. Trainer: Q3 dobara padh lein",
  "read": false, "sentAt": "…", "type": "QUIZ_RESCHEDULED", "data": { "quizId": "…", "availableAt": "2026-10-05T04:30:00.000Z" } }
```

| `type` | When | `data` | Tap → |
|---|---|---|---|
| `QUIZ_RESCHEDULED` | trainer reschedules (also sent when they change the date) | `quizId`, `availableAt` | Training home |
| `QUIZ_PASSED` | graded, passed | `quizId`, `attemptId`, `score`, `max` | Result screen |
| `QUIZ_FAILED` | graded, failed | `quizId`, `attemptId`, `score`, `max` | Result screen |

These are in-app only (no FCM push yet). `type` can be `null` on older
notification rows — fall back to just showing the text.

## What changes vs the current dummy code

The current screens run on `staff_dummy_api.dart`. Mapping to the real API:

| Dummy (`staff_models.dart` / datasource) | Real API |
|---|---|
| `TrainingCategory` / `TrainingCourse` (course list with `progress`) | No categories or per-course progress. The unit is a **batch** with materials + quizzes from `GET /training/mine`. Drop the categories screen, or group materials by `type`. |
| `TrainingCourse.type` = `video` / `pdf` / `quiz` | Materials have `type` `VIDEO` / `PDF` / `NOTE` (uppercase, and `NOTE` is new). Quizzes are a separate list, not a material type. |
| `getQuiz(courseId)` | `POST /training/quizzes/:quizId/start` — returns the questions. Keyed by **quiz id**, not course id. |
| `QuizQuestion { id, question, options, correctIndex }` | `{ id, questionText, type, options, points }`. **Remove `correctIndex`.** Add `type` (`MCQ` / `TEXT` — TEXT needs a text field, `options` is `null`) and `points`. |
| `submitQuiz(courseId, Map<String,int> answers)` | `POST /training/quizzes/attempts/:attemptId/submit` with a **list** of `{question_id, selected_option}` or `{question_id, answer_text}`. Keyed by **attempt id** (from start). |
| `QuizResult { score, total, passed }` | Submit returns `{ state, score, maxScore, passMarks, passed, pendingReview }`. `score`/`passed` are **null while `UNDER_REVIEW`** — a result is not always immediate any more. Full breakdown from the result endpoint. |
| Pass/fail computed on the phone | Never compute it on the phone. The server decides, against the quiz's own `passMarks`. |
| `trainingCertificate` route | No certificate endpoint exists. Leave that screen out for now. |

Routes already declared in `staff_routes.dart` (`/staff/training`,
`/training/video/:id`, `/training/pdf/:id`, `/training/quiz/:id`,
`/training/result/:id`) fit fine. Use the quiz id for `quiz/:id` and the
**attempt id** for `result/:id`.

## Test account

Staff `9194951111` (Hunesh Sharma, series MAID, at S3) — ask for the current
password; it's a shared test login. Ask the trainer side (`9800000005`) to put
this staff in a batch and create a quiz, then walk through: locked → start →
submit → under review → trainer marks → failed → trainer reschedules →
notification → retake → passed.

## Backend files, if useful

- `src/modules/training/training-staff.controller.ts` — `GET /training/mine`
- `src/modules/training/training-quiz.controller.ts` / `training-quiz.service.ts` — quiz states, start, submit, result
- `src/modules/training/training-materials.controller.ts` — material files + enrollment check
- `src/modules/staff/staff-mobile.controller.ts` — `GET /staff/notifications`
