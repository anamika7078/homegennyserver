# Mobile app change — Aadhaar eKYC is now a real 2-step OTP flow (S2)

## What changed on the backend (already live)

Aadhaar eKYC (`verification.service.ts`) used to be a mock-only scaffold
aimed at direct UIDAI integration (`UIDAI_AUA_CODE`/`UIDAI_LICENSE_KEY`) —
that was never realistic, since UIDAI doesn't grant direct API access to
companies. It's now wired to **Sandbox** (sandbox.co.in), a licensed
KYC-API aggregator, using real credentials.

Sandbox's actual Aadhaar contract is a genuine **2-step OTP flow**, not a
single call — you cannot submit an OTP before one has been requested:

```
POST /verification/aadhaar/generate-otp
Body: { aadhaar_number }
→ { reference_id, message }
   (sends a real OTP via UIDAI to the mobile number linked to that Aadhaar;
   nothing persisted yet)

POST /verification/aadhaar/verify-otp
Body: { reference_id, otp, aadhaar_number, staff_id? }
→ { aadhaar_number_last4, name, dob, gender, address, verified }
   (this is where the VerificationTrack row is written — pass staff_id so
   it round-trips into GET /verification/:staffId and the S2/S5 gates)
```

The old single-shot `POST /verification/aadhaar` is gone — replaced by the
two endpoints above.

**Mock mode is unchanged behavior-wise.** No `SANDBOX_API_KEY`/
`SANDBOX_API_SECRET` configured (the default locally) → both endpoints
return deterministic fake results, no real OTP sent, safe for local dev.
Production (Render) now has real Sandbox credentials configured, so real
calls send a real OTP to a real phone.

## Also live: S2_VERIFY is now actually gated server-side

Previously, `POST /rm/pipeline/:staffId/advance` had no check at
S2_VERIFY exit — the RM app's S2 hub screen showed an "Advance" button
disabled until all required tracks (Aadhaar/PV/medical/DL/eChallan per
series) cleared, but that was client-side only. A stale app build or a
raw API call could skip S2 with nothing verified. The backend now enforces
the same requirement server-side, returning a 400 naming what's missing —
already handled by the existing error-snackbar pattern on the Advance
button, no mobile change needed for that part.

## What changed in the Flutter app (already done in this pass)

`rm_track1_aadhaar_screen.dart` — rebuilt as a genuine 2-step screen:

1. **Step 1**: Aadhaar number field + "Send OTP" button →
   `RmRepository.generateAadhaarOtp(aadhaarNumber)` → stores the returned
   `reference_id` in local screen state.
2. **Step 2** (shown once `reference_id` is set): an info banner
   ("OTP sent for Aadhaar ending ####") + OTP field + "Verify Aadhaar"
   button → `RmRepository.verifyAadhaarOtp(referenceId, otp, aadhaarNumber,
   staffId)`. A "Change" link resets back to step 1 (re-enter a different
   number, or resend).

Repository/datasource layer:
- `RmRemoteDataSource.generateAadhaarOtp({required aadhaarNumber})` →
  `Future<String>` (the reference_id)
- `RmRemoteDataSource.verifyAadhaarOtp({required referenceId, required otp,
  required aadhaarNumber, staffId})` → `Future<AadhaarResult>` (same
  `AadhaarResult` model as before — response shape didn't change, only how
  you get there)
- `ApiConstants.verificationAadhaarGenerateOtp` /
  `verificationAadhaarVerifyOtp` replace the old single
  `verificationAadhaar` constant.

Nothing else in the S2 hub (`rm_verification_dashboard_screen.dart`) needed
to change — it already reads `GET /verification/:staffId` for the
aggregate status and only navigates into the Aadhaar track screen, which
now internally handles both steps.

## Test plan

1. Local (mock mode, default): open a staff's S2 Verification hub → tap
   Aadhaar → enter any 12-digit number → Send OTP → step 2 appears
   immediately → enter any 6 digits → Verify → result card shows
   "MOCK APPLICANT", VERIFIED.
2. Production, with a real staff member's consent and their own Aadhaar
   number: same flow, but Send OTP triggers a real SMS from UIDAI to their
   registered mobile — confirm the real OTP verifies correctly and the
   staff's S2 hub tile flips to CLEAR.
