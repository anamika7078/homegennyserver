# Mobile app change needed — staff document upload

**Audience:** the Flutter developer working on the staff app's Documents screens.
**Backend status:** live on the Hostinger server from 2026-09-30.

## What changed

1. **`POST /staff/documents` now exists.** The app's *Upload Document* screen
   (`upload_document_screen.dart` → `staff_datasource.dart uploadDocument`) has
   been posting here all along, and until now got a 404 — every upload failed.
2. **A staff upload is not accepted automatically.** It is saved as
   `Pending Verification`, shows up on HR's document screen, and only counts
   once HR verifies it. HR can also reject it with a reason, which the app
   shows; the staff member then uploads again.
3. **`/upload/image`, `/upload/video` and `/upload/document` are gone.** They
   never stored anything (they returned a fake `storage.homegenny.com` URL) and
   no screen called them. Remove `ApiConstants.uploadImage/uploadVideo/uploadDocument`
   and the matching `uploadImage/uploadVideo/uploadDocument` helpers in
   `lib/core/network/api_service.dart`.

Files are stored in a private cloud bucket. The app only ever gets them back
through `previewUrl` / `downloadUrl` below, with the staff member's token.

## `POST /staff/documents`

Staff token only. `multipart/form-data`:

| Field | Required | Notes |
|---|---|---|
| `file` | yes | PDF, JPG or PNG, **max 5 MB** |
| `document_type` | yes* | e.g. `Aadhaar Card`, `PAN Card`, `Passport Size Photo`, `Police Verification Certificate`, `Driving License`, `Address Proof`, `Other` |
| `name` | — | *Used as the type when `document_type` is missing — this is what the current app sends, so it already works. Prefer sending `document_type`. |

The current app also sends `type` = the file extension (`PDF` / `FILE`); it is
ignored — the server reads the real file type itself.

Names the current app uses are mapped to HR's names: `Police Verification` →
`Police Verification Certificate`. Send HR's exact names where you can, so the
upload lines up with the onboarding checklist.

**201:**
```json
{ "id": "…", "type": "Police Verification Certificate", "status": "Pending Verification", "uploadedAt": "…" }
```

**Errors:**
- `413` — file over 5 MB
- `400` — not PDF/JPG/PNG, or no type
- `400` — "Your employment record is not set up yet…" (HR hasn't created the employee record)
- `409` — HR already accepted this document type; the staff member can't replace it from the app (show the message — they have to ask HR)

Uploading the same type again while it's still `Pending Verification` or
`Rejected` replaces the earlier upload.

## `GET /staff/documents` — two new fields

```json
{
  "documents": [
    {
      "id": "…", "type": "Police Verification Certificate", "status": "Rejected",
      "uploadedBy": "STAFF",
      "rejectionRemark": "Photo blurry, upload a clear scan",
      "previewUrl": "/staff/documents/…/preview", "downloadUrl": "/staff/documents/…/download",
      "…": "…"
    }
  ],
  "total": 1
}
```

| `status` | Show |
|---|---|
| `Pending Verification` | "Waiting for HR to check" |
| `Rejected` | "Rejected: {rejectionRemark}" + **Upload again** |
| `Verified` / `Expiring Soon` / `Expired` | as today |
| `Not Available` | HR marked it unavailable |

- `uploadedBy` — `STAFF` (uploaded from the app) or `HR`.
- `rejectionRemark` — set only when `status` is `Rejected`.

`previewUrl` / `downloadUrl` are relative to the API host and need the
`Authorization: Bearer …` header.
