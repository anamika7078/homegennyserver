# HomeGenny Auth API — Register, Login & Sessions

Internal API reference for the mobile app team. Covers Customer/Staff
self-registration, login, token refresh, and session management.

**Base URL:** `http://<host>/api/v1/auth`

---

## How registration works

A Customer or Staff record can be created two ways: by an admin in the Admin
Panel, or by the person themselves through the app. Both paths write to the
**same tables** — there's no separate "app account" table — so the moment
someone registers, they appear in the right internal list automatically.

**Customer registers** (`register/customer`)
1. `users` row created — role `CLIENT`
2. Linked `finance_customers` row created — status `ACTIVE`
3. Shows up in Finance's customer list immediately

**Staff registers** (`register/staff`)
1. `users` row created — role `STAFF`
2. Linked `employees` row created — status `PENDING_HR_REVIEW`
3. Shows up in HR's employee list, flagged incomplete

**Either way:** registration **auto-logs in** — no separate login call
needed. The response is `access_token` + `refresh_token` + `user`, exactly
like `/login`. From there both roles use the same session endpoints.

> **Staff registered from the app start incomplete on purpose.** Branch,
> category, designation and salary are HR-owned decisions the app can't know.
> A self-registered Staff record is created with placeholders
> (`department`, `designation`, `employment_type` = `"Not Assigned"`,
> `salary` = `0`) and `status: "PENDING_HR_REVIEW"`. They can log in right
> away, but the app should treat that status as "your HR profile isn't
> finished yet" until an admin completes it in the Admin Panel.

---

## Conventions

**Success envelope**
```json
{
  "success": true,
  "data": { "...": "endpoint-specific payload" },
  "timestamp": "2026-08-06T05:39:25.323Z"
}
```

**Error envelope**
```json
{
  "statusCode": 409,
  "timestamp": "2026-08-06T05:38:57.803Z",
  "path": "/api/v1/auth/register/staff",
  "message": {
    "message": "An account with this phone number or email already exists",
    "error": "Conflict",
    "statusCode": 409
  }
}
```

**Auth header** — required on every endpoint marked 🔒 below:
```
Authorization: Bearer <access_token>
```

**Token lifetimes**

| Token | Lifetime | Notes |
|---|---|---|
| `access_token` | 15 minutes | Send on every authenticated request |
| `refresh_token` | 7 days | Exchange for a new access_token via `/refresh` |

> Only **one active session per account** is allowed — logging in again on a
> new device silently evicts the previous session's refresh token. Store
> both tokens in secure storage (Keychain / EncryptedSharedPreferences),
> never in plain AsyncStorage/localStorage.

---

## `POST /register/customer` — public, 5 req/min per IP

Creates the login account (role `CLIENT`) and a linked `finance_customers`
record in one transaction. If the customer record fails to create (e.g.
duplicate PAN), the login account is rolled back — no orphaned accounts.

**Request body**

| Field | Type | | Notes |
|---|---|---|---|
| `full_name` | string | required | 2–200 chars |
| `phone` | string | required | 10–15 digits, used as login ID |
| `email` | string | optional | valid email |
| `password` | string | required | 8–72 chars, ≥1 letter + ≥1 number |
| `business_name` | string | optional | defaults to `full_name` |
| `pan_card` | string | required | must be unique |
| `address` | string | required | |
| `city` | string | optional | |
| `state` | string | optional | |
| `pincode` | string | optional | |
| `gstn` | string | optional | |

```json
POST /api/v1/auth/register/customer
Content-Type: application/json

{
  "full_name": "Ravi Kumar",
  "phone": "9812300001",
  "email": "ravi@example.com",
  "password": "Passw0rd123",
  "business_name": "Ravi Traders",
  "pan_card": "ABCDE1234F",
  "address": "12 MG Road",
  "city": "Delhi",
  "state": "Delhi",
  "pincode": "110001"
}
```

**Response — 200**
```json
{
  "success": true,
  "data": {
    "access_token": "eyJhbGciOi...",
    "refresh_token": "eyJhbGciOi...",
    "user": {
      "id": "7683bc7a-c0ba-4ea8-9fd1-564249c81d1b",
      "full_name": "Ravi Kumar",
      "role": "CLIENT",
      "phone": "9812300001",
      "is_active": true,
      "branch_id": null
    }
  }
}
```

**Errors**
- `409` — phone/email already registered, or PAN already exists
- `400` — validation failed (bad phone format, weak password, missing PAN/address)

---

## `POST /register/staff` — public, 5 req/min per IP

Creates the login account (role `STAFF`) and a linked `employees` record
with placeholder branch/category and `status: "PENDING_HR_REVIEW"`. Same
rollback guarantee as customer registration.

**Request body**

| Field | Type | | Notes |
|---|---|---|---|
| `full_name` | string | required | 2–200 chars |
| `phone` | string | required | 10–15 digits, used as login ID |
| `alternate_phone` | string | optional | |
| `email` | string | optional | |
| `password` | string | required | 8–72 chars, ≥1 letter + ≥1 number |
| `date_of_birth` | string | required | ISO date, e.g. `1995-05-10` |
| `gender` | string | required | `MALE` / `FEMALE` / `OTHER` |
| `address` | string | required | |
| `city` | string | required | |
| `state` | string | required | |
| `pincode` | string | required | |

```json
POST /api/v1/auth/register/staff
Content-Type: application/json

{
  "full_name": "Sunita Devi",
  "phone": "9812300002",
  "email": "sunita@example.com",
  "password": "Passw0rd123",
  "date_of_birth": "1995-05-10",
  "gender": "FEMALE",
  "address": "45 Nehru Nagar",
  "city": "Delhi",
  "state": "Delhi",
  "pincode": "110002"
}
```

**Response — 200**
```json
{
  "success": true,
  "data": {
    "access_token": "eyJhbGciOi...",
    "refresh_token": "eyJhbGciOi...",
    "user": {
      "id": "4db8f89f-a9ee-42df-ae78-394726773b9f",
      "full_name": "Sunita Devi",
      "role": "STAFF",
      "phone": "9812300002",
      "is_active": true,
      "branch_id": null
    }
  }
}
```

**Errors**
- `409` — phone or email already registered
- `400` — validation failed (bad date, invalid gender, missing address fields)

---

## `POST /login` — public, 5 req/min per IP

Works for both Customer and Staff accounts — role comes back in the
response, use it to route the app's UI.

**Request body**

| Field | Type | | Notes |
|---|---|---|---|
| `phone` | string | required* | *or `email` / `identifier` |
| `password` | string | required | |

```json
POST /api/v1/auth/login
Content-Type: application/json

{ "phone": "9812300001", "password": "Passw0rd123" }
```

**Response — 200**
```json
{
  "success": true,
  "data": {
    "access_token": "eyJhbGciOi...",
    "refresh_token": "eyJhbGciOi...",
    "user": {
      "id": "7683bc7a-...", "full_name": "Ravi Kumar", "role": "CLIENT",
      "phone": "9812300001", "is_active": true, "branch_id": null
    }
  }
}
```

**Errors**
- `401` — wrong phone/email or password, or account inactive
- `429` — too many attempts — back off and retry

---

## `POST /refresh` — public

Call this when the access token expires (every ~15 min of continuous use)
to get a new one without asking for the password again.

**Request body**

| Field | Type | | Notes |
|---|---|---|---|
| `userId` | string | required | note: camelCase, unlike other endpoints |
| `refresh_token` | string | required | from login/register response |

```json
POST /api/v1/auth/refresh
Content-Type: application/json

{ "userId": "7683bc7a-...", "refresh_token": "eyJhbGciOi..." }
```

**Response — 200**
```json
{ "success": true, "data": { "access_token": "eyJhbGciOi..." } }
```

**Errors**
- `401` — refresh token invalid, expired, or already superseded by a newer login

---

## `GET /me` 🔒 requires token

Returns the full profile plus — this is the important part for the app —
whichever of `customer_profile` / `employee_profile` applies, so you can
show onboarding/verification status without a second call.

```
GET /api/v1/auth/me
Authorization: Bearer eyJhbGciOi...
```

**Response — 200 (Customer)**
```json
{
  "success": true,
  "data": {
    "id": "7683bc7a-...", "full_name": "Ravi Kumar", "phone": "9812300001",
    "email": "ravi@example.com", "role": "CLIENT", "is_active": true, "branch_id": null,
    "permissions": [],
    "customer_profile": { "id": "14f51989-...", "unit_code": "RAVIT-01", "status": "ACTIVE" },
    "employee_profile": null
  }
}
```

**Response — 200 (Staff, pending HR)**
```json
{
  "success": true,
  "data": {
    "id": "4db8f89f-...", "full_name": "Sunita Devi", "role": "STAFF",
    "customer_profile": null,
    "employee_profile": { "id": "41f5cdf9-...", "employee_id": "SUNITA001", "status": "PENDING_HR_REVIEW" }
  }
}
```

> Use `employee_profile.status === "PENDING_HR_REVIEW"` as the signal to
> show a "your profile is being reviewed" state in the Staff app until HR
> finishes onboarding them.

**Errors**
- `401` — missing/expired/invalid access token

---

## `POST /logout` 🔒 requires token

Invalidates the current session's refresh token. Call this and discard both
stored tokens on the device.

```
POST /api/v1/auth/logout
Authorization: Bearer eyJhbGciOi...
```

**Response — 200**
```json
{ "success": true, "data": { "success": true } }
```

---

## `POST /logout-all` 🔒 requires token

Use for a "sign out everywhere" security setting, or after a password reset.

```
POST /api/v1/auth/logout-all
Authorization: Bearer eyJhbGciOi...
```

---

## Rate limits

Applied per client IP, on top of standard input validation. Build the app's
error handling to expect a `429` on these three specifically.

| Endpoint | Limit |
|---|---|
| `POST /register/customer` | 5 requests / 60s |
| `POST /register/staff` | 5 requests / 60s |
| `POST /login` | 5 requests / 60s |

---

## What's coming next

**Phone OTP verification is not enforced yet.** Accounts are created and
usable immediately with just phone + password. Every account already
carries a `phone_verified: false` flag internally — when OTP is switched
on, existing accounts won't need a schema change, just a verification step
before certain actions unlock. No app-side change needed until that ships;
this doc will be updated when it does.
