# Mobile app — cloud storage (bucket) changes

**Audience:** the Flutter developer on `homegennyapp`.
**As of:** 2026-10-01. Everything below is live on the Hostinger server (`https://homegenny.com/api/v1`).

Since 2026-09-30 the server stores uploaded files in a **private Google Cloud
Storage bucket** instead of its own disk. This page lists only what that
changes for the app. Files are never public: every file comes back either as
a short-lived signed bucket link or through an API URL that needs the user's
Bearer token.

## 1. Video certification

The server now returns a bucket upload target instead of its own
`/video-cert/local-upload` path:

- `uploadUrl` is `https://storage.googleapis.com/homegenny/` plus a set of
  policy `fields`. POST it as multipart: **every** field in `fields`
  unchanged, then `file` last. **Don't send the Bearer token** to this URL.
- Max **500 MB**. The bucket stores every certification video as
  `video/mp4`. iOS cameras record `.mov` by default, which may not play in
  the RM's browser, so record MP4 where the camera plugin allows.
- After the upload, `verify-hash` and `finalize` work as before.
  `finalize` returns **400** (not 500) if `staffId`, `promptKey`, `gcsKey`
  or the hash is missing.
- All earlier video-cert records were deleted on 2026-09-30, so every
  prompt starts as "not uploaded".

## 2. Study material videos

A training video's `viewUrl` is now a signed bucket link
(`https://storage.googleapis.com/…`). Play it as-is with **no** auth
header. It expires after 1 hour, so fetch a fresh one instead of caching it.
PDF `viewUrl`s are unchanged: relative, and they need the Bearer header.

## 3. Staff documents

`POST /staff/documents` now stores the file in the bucket (it used to 404).
A staff upload lands as `Pending Verification` until HR verifies it, and HR
can reject it with a reason. `GET /staff/documents` rows now include
`uploadedBy` and `rejectionRemark`.

| `status` | Show |
|---|---|
| `Pending Verification` | "Waiting for HR to check" |
| `Rejected` | "Rejected: {rejectionRemark}" + **Upload again** |
| `Verified` / `Expiring Soon` / `Expired` / `Not Available` | as today |

- Limits: PDF / JPG / PNG, **5 MB**. Over 5 MB → `413`. Wrong type → `400`.
  If HR has already accepted that document type → `409`, and the staff
  member has to ask HR to replace it.
- Send `document_type` using HR's exact names, e.g. `Police Verification Certificate`
  rather than `Police Verification`.
- `previewUrl` / `downloadUrl` are relative and need the Bearer header.

Full contract: [MOBILE_BRIEF_STAFF_DOCUMENTS.md](MOBILE_BRIEF_STAFF_DOCUMENTS.md).

## 4. Client complaint photos

`POST /client/complaints` used to accept `images[]` and throw them away
(`imagesStored: 0`). They are now stored. The request stays the same: the
`images[0]`, `images[1]`, … fields work as they are.

- Limits: up to **5** photos, **JPG / PNG / WebP**, **5 MB** each. Over
  the size limit → `413`. Wrong type or more than 5 → `400`, and in both
  cases **no complaint is created**, so show the message and let the client
  fix the selection. iOS HEIC isn't accepted; `image_picker` returns JPEG
  by default.
- The response has `imagesReceived` and `imagesStored`. It includes a
  `warning` only if a photo failed to save after the complaint was filed.
- To show them, call `GET /incidents/:id`. It returns
  `photos: [{ index, mimeType, url }]`, where `url` is relative
  (`/incidents/:id/photos/0`) and needs the client's Bearer token. A
  client can only open photos on their own complaints.

## 5. Removed upload endpoints

`/upload/image`, `/upload/video` and `/upload/document` were removed. They
never stored anything (they returned a fake URL) and now return 404. Delete
these from the app:

| Remove | Where |
|---|---|
| `uploadImage`, `uploadVideo`, `uploadDocument` constants | `api_constants.dart` |
| `uploadImage()`, `uploadVideo()`, `uploadDocument()` helpers | `lib/core/network/api_service.dart` |

## Testing

| Role | Phone | Password |
|---|---|---|
| Trainer (adds study material) | 9800000005 | `hg` |
| HR (verifies documents) | 9800000008 | `hg` |
| RM (reviews video certs and complaints) | 9800000002 | `hg` |

For a staff or client login, ask the backend team for a test account.
Their passwords are personal and aren't shared here.
