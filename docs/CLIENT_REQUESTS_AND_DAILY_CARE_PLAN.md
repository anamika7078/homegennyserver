# Client Requests + Daily Care / Cook Tracking — Plan

Date: 2026-10-12
Scope: backend (`homegennyserver`) + web (`homegenny`). Mobile app ke liye har phase ke baad
ek hi doc `docs/MOBILE_BRIEF_CLIENT_CARE_COOK.md` mein uska section joda jaayega (Phase F).

Source: sir ka message (11/10/2026), "app ready karo routine checks aur inputs ke performa ke saath,
Nursing aur Cooking ke liye", plus is session mein liye gaye decisions.

---

## Decisions (final)

| # | Decision |
|---|---|
| D1 | Abhi sirf 3 categories active: **UNSKILLED_CARE (UC), SKILLED_CARE (SC), COOK (CK, naya)**. MAID aur DRIVER band, delete nahi. |
| D2 | Band karne ka tarika: **flag** (`ACTIVE_SERIES`), code comment nahi. Purane Maid/Driver staff ke records, placement, payroll aur invoice chalte rahenge. |
| D3 | **Stage 2.5 band.** Ye sirf Driver ke practical test ke liye thi. Flag Driver se juda hai, Driver wapas aaye to 2.5 bhi apne aap wapas. |
| D4 | Cook ka koi practical test nahi. |
| D5 | Staff request **client (app) aur RM (web) dono** daal sakte hain. Purana flow (RM seedha placement banaye) bhi chalta rahega. |
| D6 | Care plan aur menu **client khud banayega**, app se. |
| D7 | Cook ki dish photo **optional**. |
| D8 | Backend + web hum banayenge. Mobile team ko flow + API ka brief doc denge. |

---

## Codebase ki zaroori baatein (jo plan ko affect karti hain)

1. `StaffSeries` enum (`schema.prisma`) mein COOK nahi hai. Finance ke rate card aur payroll mein "Cook" category pehle se hai.
2. **Enum ka owner `postgres` hai, app `homegenny_user` se chalta hai.** `ALTER TYPE ... ADD VALUE 'COOK'` owner credential se hi chalega (jaise `incident_type` ke time atka tha). Prod pe chalane se pehle credential chahiye.
3. **`mapSeriesFromShort()` anjaan value ko chupchaap `SKILLED_CARE` bana deta hai** (`common/mappers/staff.mapper.ts:75`). COOK add karte waqt ye nahi badla to har cook SC ban jaayega, bina kisi error ke. Series ke do representations (DB ka lamba naam, app ka short code) ki wajah se ye bug class pehle 3 baar aa chuki hai.
4. Series ke hisaab se `Record<series, ...>` maps kai jagah hain: verification tracks (3 copies), PV rule, `REQUIRED_VIDEO_PROMPTS`, `routeScenario()` (anjaan series pe throw karta hai), `TRAINING_DAYS`/`TRIAL_DAYS` (web), video-cert prompts, series labels/badges. COOK sabme chahiye.
5. Local DB mein abhi sirf MAID staff hain (10: 9 S5, 1 S3). Testing ke liye UC/SC/COOK fixtures banane padenge. Prod pe deploy se pehle check karna hai ki koi staff S2.5 pe to nahi.
6. `Placement.clientId` → `finance_customers.id`. Finance customer banana bhaari hai (PAN, bill prefix, unit code zaroori), isliye naye lead ke liye request customer ke bina bhi ban sakni chahiye.
7. `care_logs` / `medication_logs` tables bani hain par khaali aur unused hain, aur `deployments` se judi hain (aaj ka flow `placements` pe hai). Inhe **chhodenge** aur nayi tables `placement_id` pe banayenge. Purani tables drop nahi karni.
8. Pehle se kaam aane wali cheezein: `replacement_requests`, `ScopeOfWork`, `right-to-refuse`, `escalation_logs`, notifications (FCM push + in-app + email), file storage (GCS, complaint photos wala), attendance/`shift_logs`.

---

## Phase A — Categories (UC, SC, Cook) + Stage 2.5 band

> **Status (2026-10-12): ✅ Local pe poora.** Backend + web done, `npm run test:series` 39/39, `test:rm` green.
> COOK enum local DB mein jud gaya. **Prod pe baaki:** `scratch/_cook_series_migration.js` ko
> `MIGRATION_DATABASE_URL` (postgres owner) ke saath chalana hai, aur deploy se pehle check karna hai ki koi staff S2_5 pe to nahi.
> Mobile brief: `docs/MOBILE_BRIEF_CLIENT_CARE_COOK.md` section 1.
> Defaults jo maine chune: Cook deposit ₹1000, 9 video prompts, scenario codes `CK-xx` (spec mein abhi Cook nahi hai).
> Deferred-from-S2.5 staff S2.5 mein wapas resume ho sakta hai, warna woh atak jaata.

### A1. Ek jagah config
`src/common/config/active-series.ts`:
```ts
export const ALL_SERIES = ['MAID', 'SKILLED_CARE', 'UNSKILLED_CARE', 'DRIVER', 'COOK'] as const;
export const ACTIVE_SERIES = ['UNSKILLED_CARE', 'SKILLED_CARE', 'COOK'];   // MAID, DRIVER — band
export const isSeriesActive = (s: string) => ACTIVE_SERIES.includes(s);
export const isStage25Enabled = () => isSeriesActive('DRIVER');          // 2.5 sirf Driver ke liye
```
Naya endpoint `GET /api/v1/meta/series`: `[{ value, short, label, active }]`. Web aur mobile dono yahin se list lenge, apni hardcoded list nahi rakhenge.

### A2. Enforcement (backend)
- Naya staff jahan bhi banta hai (RM intake, mobile self-registration, HR onboarding), inactive series pe **400**: "Maid/Driver series abhi band hai".
- Series change aur `UpgradeRequest.toSeries` sirf active series mein.
- Purane records ko kuch nahi hoga: GET, payroll, invoice, placement exit sab chalte rahenge.

### A3. COOK series add karna
- Migration script `scratch/_cook_series_migration.js`: `ALTER TYPE staff_applicants_series_enum ADD VALUE IF NOT EXISTS 'COOK'` (**owner credential se**). Additive hai, kuch drop nahi hota.
- `schema.prisma` enum mein `COOK` jodna, phir `prisma generate`.
- Mapper: `COOK ↔ CK` dono taraf. **Fallback badalna**: anjaan value pe `SKILLED_CARE` lautane ki jagah error throw kare.
- Har series map mein COOK (defaults, badalne ho to bata dena):
  - Verification: `AADHAAR_EKYC` + `HEALTH_SCREENING` (khana banane wale ke liye health zaroori), PV CLEAR chahiye (UC/SC jaisa)
  - Scenario router: `routeCookScenario()` (UC wala copy karke)
  - Video prompts: cook ke liye set (video-cert mein cooking wala prompt pehle se hai)
  - Training 5 din, trial 7 din
  - Staff code `HG-CK-...`, label "CK — Cook", badge colour
  - Series → finance category: `COOK → 'Cook'` (rate card/payroll mein pehle se hai)

### A4. Stage 2.5 band karna
- FSM: `isStage25Enabled() === false` ho to S2 → S2_5 aur DEFERRED → S2_5 refuse. S2 → S3 seedha.
- S2_5 pe naya hold nahi lagega.
- Jo staff abhi S2_5 pe hai, woh bahar nikal sakta hai (S2_5 → S3/TERMINAL/DEFERRED chalta rahega). Sirf naya entry band.
- Enum value DB mein rahegi. Purane `pipeline_events` uska reference rakhte hain, isliye hatayi nahi ja sakti aur hatani bhi nahi.
- Driver ke deployment blockers code mein rahenge. Woh sirf DR pe lagte hain, aur DR ab band hai.

### A5. Web
- `lib/rm/constants.ts`: `PIPELINE_STAGES` / `FSM_NEXT` se S2_5 filter, kanban mein S2.5 column nahi dikhega (khaali ho tab).
- Admin pipeline page: route text "S1 ➔ S2 ➔ S3 ➔ S4 ➔ S5".
- Assessor ka driver test page nav se chhupana.
- **Banane wale forms** (intake, staff intake, HR onboarding, upgrade) sirf active series dikhayenge (`/meta/series`). **List filters** saari series dikhayenge, taaki purane Maid staff dhoondhe ja sakein.
- `SERIES_LABELS` / `SERIES_BADGE` / `TRAINING_DAYS` / `TRIAL_DAYS` mein COOK/CK.

### A6. Live test (`npm run test:series`)
MAID create → 400 · COOK create → 201 + `HG-CK-` code + `series_db=COOK` (SC nahi!) · S2→S2_5 → 400 · S2→S3 → OK · purana Maid staff GET/payslip → OK · `/meta/series` → 3 active.

---

## Phase B — Staff Request (client staff kaise maange)

> **Status (2026-10-12): ✅ Local pe poora.** Tables: `scratch/_staff_requests_migration.js` (Prisma models declared, zero diff).
> Module `src/modules/staff-requests/`. `POST /placements` ab `staff_request_id` leta hai. Web pages: `/rm/requests`, `/rm/requests/new`, `/rm/requests/[id]`.
> Test: `npm run test:requests` (62/62). Mobile brief section 2.
> **Plan se farak:** push (FCM) abhi nahi hai, kyunki backend device tokens store nahi karta. Abhi sirf in-app notifications hain.
> RBAC permission ki jagah role (`RM/BM/ADMIN`, `CLIENT`) se guard kiya hai, jaise baaki RM endpoints mein hai.
> **Prod pe baaki:** migration chalana.

### B1. Flow
```
NEW ──(RM auto-assign)──▶ ASSIGNED ──▶ SHORTLISTED ──▶ CLIENT_SELECTED ──▶ FULFILLED
  │                          │              │ (client sab reject kare)            ▲
  │                          │              └──────────▶ ASSIGNED (naya shortlist)│
  └──────────────── CANCELLED (client ya RM, reason ke saath) ◀───────────────────┘
```
- **Source:** `CLIENT_APP` | `RM_WEB` | `REPLACEMENT`.
- Client ka login nahi hai (RM_WEB lead) to RM khud client ki taraf se staff select karega.
- **Purana flow chalta rahega:** RM bina request ke bhi seedha placement bana sakta hai (D5).

### B2. Tables (additive raw SQL migration, Prisma model bhi declare)
**`staff_requests`**
| column | note |
|---|---|
| id, request_no | `SR-2026-0001` |
| client_id | `finance_customers.id`, **nullable** (naya lead) |
| lead_name, lead_phone, lead_city | jab client_id null ho |
| branch_id, rm_id | |
| source | CLIENT_APP / RM_WEB / REPLACEMENT |
| replacement_request_id | source = REPLACEMENT ho tab |
| series | sirf active series |
| placement_type, shift_hours | PERMANENT/TEMPORARY, 8/12 |
| start_date, address, language, gender_pref | |
| budget_min, budget_max, headcount (default 1) | |
| requirements jsonb | series ke hisaab se (neeche) |
| notes, status, cancel_reason | |
| assigned_at, shortlisted_at, selected_at, fulfilled_at, cancelled_at | SLA ke liye |
| created_by, created_at, updated_at | |

`requirements` mein kya aayega:
- **UC/SC:** `patient_age, patient_gender, conditions[], mobility (WALKING/ASSISTED/BEDRIDDEN), medical_needs[] (INJECTION, CATHETER, FEEDING_TUBE…), night_care`
- **COOK:** `diet_type, family_size, meals_per_day[], cuisines[], health_conditions[]`

Server validate karega (series ke hisaab se zaroori fields).

**`staff_request_candidates`**: request_id, staff_id, status (PROPOSED / CLIENT_SELECTED / CLIENT_REJECTED / WITHDRAWN), rm_note, client_note, added_by, timestamps. Unique(request_id, staff_id).

Placement jab request se bane: `placements.metadata.request_id` aur `staff_requests.fulfilled_placement_ids` (headcount > 1 ho sakta hai).

### B3. Rules
- **Auto-assign:** client ki branch ke RM mein jiske open requests sabse kam hon. Branch pata na ho ya RM na mile to BM ki queue mein.
- **SLA:** 24 ghante tak NEW/ASSIGNED pada rahe (shortlist nahi bana) to BM ko alarm. Existing alarms module se.
- **Candidates (matching):**
  - Same series, restricted nahi, open hold nahi
  - Placement ke liye ready (S4 done / S5 eligible)
  - **Permanent-exclusive rule:** PERMANENT request pe sirf woh staff jinka koi active placement nahi; TEMPORARY pe jinka active PERMANENT nahi
  - Language/gender/branch se ranking, har candidate pe "match reasons" badge
- **Client ko staff card pe kya dikhega:** photo, pehla naam, series, experience, languages, "Verified" badge, rating. **Aadhaar, phone, poora address nahi.**
- **Fulfil:** "Create trial placement" pe existing placement create form khulega (pre-filled). Placement bante hi request (same transaction mein) FULFILLED, ya headcount poora hone tak SHORTLISTED rahegi.
- **Placement ke liye `client_id` zaroori hai:** lead hai to pehle finance customer banana padega. UI isko blocker ki tarah dikhayegi ("Is lead ka customer account bana do"), customer seedha nahi banayegi.
- **Replacement:** RM replacement request ko "Convert to staff request" kar sakta hai (`source = REPLACEMENT`).
- **Notifications:** RM ko naya request; client ko shortlist ready / staff confirmed. FCM + in-app.

### B4. APIs
**Client** (`/api/v1/client/...`)
| Method | Path | Kaam |
|---|---|---|
| POST | `/staff-requests` | naya request |
| GET | `/staff-requests` | apne requests |
| GET | `/staff-requests/:id` | detail + shortlist cards |
| POST | `/staff-requests/:id/select` | `{ staff_id }` |
| POST | `/staff-requests/:id/reject-shortlist` | `{ reason }` |
| POST | `/staff-requests/:id/cancel` | `{ reason }` |

**RM / BM web** (`/api/v1/rm/...`)
| Method | Path | Kaam |
|---|---|---|
| GET | `/staff-requests?status&branch&series` | queue + SLA |
| POST | `/staff-requests` | client ki taraf se / lead |
| GET | `/staff-requests/:id` | detail |
| PATCH | `/staff-requests/:id/assign` | RM badalna (BM) |
| GET | `/staff-requests/:id/candidates` | matching |
| POST | `/staff-requests/:id/shortlist` | `{ staff_ids[] }` |
| DELETE | `/staff-requests/:id/shortlist/:staffId` | withdraw |
| POST | `/staff-requests/:id/select` | client ki taraf se select |
| POST | `/staff-requests/:id/link-placement` | `{ placement_id }` |
| POST | `/staff-requests/:id/cancel` | |
| POST | `/replacements/:id/convert` | replacement → request |

RBAC: nayi permissions `staff_requests.view/manage`. RM ko sirf apni branch dikhegi.

### B5. Web pages
- `/rm/requests`: table/kanban status ke hisaab se, SLA timer, filters
- `/rm/requests/new`: client chuno (ya lead), series ke hisaab se dynamic fields
- `/rm/requests/[id]`: requirement, candidates (match reasons), shortlist, "Create trial placement"
- Client detail page pe "Requests" section; RM dashboard pe "Naye requests" count

### B6. Live test (`npm run test:requests`)
Client request → RM auto-assign → candidates mein permanent-busy staff nahi aata → shortlist → client select → placement → FULFILLED · inactive series (MAID) request → 400 · doosre client ka request → 403/404 · lead request se placement bina customer ke → blocked.

---

## Phase C — Nurse / Caretaker: Care Plan + Daily Care Log

> **Status (2026-10-12): ✅ C, D, E aur "staff ko sab dikhe" wala rule local pe poore.**
> - Tables: `scratch/_daily_care_migration.js` (10 tables, Prisma models declared, zero diff). Module: `src/modules/daily-care/`.
> - Tests: `npm run test:care` (106 HTTP checks + 9 cron checks; cron jobs app ko standalone boot karke DB pe chalaye).
> - Web (RM): `/rm/care` (compliance board), `/rm/care/[pid]` (plan, checklist, history, menu, meals, instructions, PDF), `/rm/care/refused`.
> - Mobile brief: sections 3–6.
>
> **Plan se farak:**
> - Endpoints `care/placements/:pid/...` pe share kiye hain (client, staff, RM teeno ke liye). Har call pe backend tay karta hai ki kaun kya kar sakta hai. Alag `client/placements/...` paths nahi banaye.
> - Plan ki items (dawa, vitals, activities) alag child tables ki jagah version row ke JSON mein hain. Har item ka `id` versions ke beech same rehta hai.
> - UC placement pe dawa aur vitals refuse hote hain (scope rule, staff request jaisa).
> - FK sirf `placements` (aur in tables ke beech) pe hain. Staff, client aur user ids code mein check hote hain.
> - Push (FCM) abhi nahi hai, sirf in-app notifications. Recurring instruction kabhi "done" nahi hoti.
> - Purani `care_logs` / `medication_logs` tables waise hi chhodi hain.
>
> **Prod pe baaki:** `_daily_care_migration.js` chalana.

Client care plan banata hai (D6). Staff ko roz us plan se checklist milti hai. Client aur RM dekhte hain kya hua.

### C1. Tables
**`care_plans`** (har edit = naya version, purana SUPERSEDED; SOW jaisa pattern)
`id, placement_id, client_id, version, status (ACTIVE/SUPERSEDED), patient jsonb (name, age, gender, conditions[], allergies[], mobility, doctor_name, doctor_phone, emergency_contact), diet_notes, dos, donts, created_by, created_at`

**`care_plan_medications`**: `plan_id, name, dose, unit, route (ORAL/INJECTION/DROPS/…), times[] ("08:00","20:00"), food_relation (BEFORE/AFTER/WITH/ANY), start_date, end_date, instructions, prescription_file_id`

**`care_plan_vitals`**: `plan_id, type (BP/SUGAR_FASTING/SUGAR_PP/TEMP/SPO2/PULSE/WEIGHT), times[], min, max` (range bahar → alert)

**`care_plan_activities`**: `plan_id, type (EXERCISE/PHYSIO/WALK/BATH/POSITION_CHANGE/OTHER), title, times[], duration_min, notes`

**`care_tasks`** (din ka checklist): `placement_id, plan_id, task_date, source_type (MEDICATION/VITAL/ACTIVITY), source_id, scheduled_time, status (PENDING/DONE/SKIPPED/MISSED), done_at, done_by, value jsonb (vitals reading), skip_reason, photo_file_id, notes`. Unique(placement, date, source_type, source_id, scheduled_time).
→ **Cron ki zaroorat nahi:** jab us din ka checklist pehli baar khule, tab plan se ban jaata hai (idempotent).

**`daily_care_reports`** (din ka summary): `placement_id, report_date, meals jsonb, fluid_intake_ml, sleep, mood, hygiene jsonb, notes, photos[], submitted_at, staff_id`. Unique(placement, date).

### C2. Rules
- Staff sirf apne active placement ka checklist bhar sakta hai, aur sirf **aaj ya kal** ka. Uske baad locked.
- Dose ka time 1 ghanta nikal gaya aur status PENDING hai to **MISSED** maana jaayega (padhte waqt calculate hoga, aur raat ka cron final karega). Client + RM ko notification.
- Vital range ke bahar → `escalation_logs` entry + client aur RM ko turant push. Bahut zyada bahar (critical) ho to BM ko bhi.
- Plan badla to aaj ke PENDING tasks naye plan se dobara banenge. DONE tasks waise hi rahenge.
- **Privacy (medical data):** access sirf us placement ke client, assigned staff, RM, aur BM/admin ko. Prescription file private GCS mein, signed URL se.
- Hourly placements: staff ke paas ek se zyada clients ho sakte hain, isliye sab kuch `placement_id` pe chalega.

### C3. APIs
**Client**
| Method | Path |
|---|---|
| GET / PUT | `/client/placements/:pid/care-plan` (PUT = naya version) |
| POST | `/client/placements/:pid/care-plan/prescription` (multipart) |
| GET | `/client/placements/:pid/care-day?date=` (tasks + report) |
| GET | `/client/placements/:pid/care-history?from&to` (adherence %, vitals trend) |

**Staff**
| Method | Path |
|---|---|
| GET | `/staff/care/today` (har active placement ka checklist + plan summary) |
| GET | `/staff/care/plan/:pid` |
| POST | `/staff/care/tasks/:taskId/done` `{ value?, notes?, photo? }` |
| POST | `/staff/care/tasks/:taskId/skip` `{ reason }` |
| PUT | `/staff/care/daily-report` `{ placement_id, date, … }` |

**RM web:** placement detail mein "Care" tab (plan, aaj ka checklist, adherence %, alerts).

---

## Phase D — Cook: Food Profile + Menu + Meal Log

### D1. Tables
**`food_profiles`**: **client ke saath judi, placement ke saath nahi.** Cook badle tab bhi pasand-napasand wahi rahegi.
`client_id (unique), diet_type (VEG/EGG/NON_VEG/JAIN/VEGAN), allergies[], spice_level (1-5), salt (LOW/NORMAL), oil (LOW/NORMAL), health_conditions[] (DIABETIC/LOW_SODIUM/LOW_FAT/NO_ONION_GARLIC/…), cuisines[], dislikes, family_size, notes, updated_by, updated_at`

**`menu_plans`**: `placement_id, menu_date, meal (BREAKFAST/LUNCH/SNACKS/DINNER), dishes jsonb [{name, notes}], special_instruction, servings, status (PLANNED/SUGGESTED/APPROVED/REJECTED), created_by`
- Client menu set kare (seedha PLANNED), ya cook suggest kare (SUGGESTED) aur client approve kare
- "Pichle hafte ka menu copy karo" button

**`meal_logs`**: `placement_id, staff_id, meal_date, meal, menu_plan_id?, dishes jsonb [{name, spice_level, photo_file_id?}], servings, cooked_at, notes` (photo optional, D7)

**`meal_feedback`**: `meal_log_id (unique), rating (1-5), tags[] (TOO_SPICY/LESS_SPICY/TOO_SALTY/LESS_SALT/OILY/PERFECT/…), comment, created_by`

### D2. Rules
- Cook ko client ki food profile **read-only** dikhegi, har meal ke upar.
- Meal log sirf aaj/kal ka; ek din mein ek meal ek hi baar (unique placement+date+meal).
- **Feedback ka asar:**
  - Cook ka rating average (7 din / 30 din) staff profile aur RM dashboard pe
  - 7 din ka average < 3 ho to RM ko alert
  - Ek hi tag baar-baar aaye (jaise 3 baar TOO_SPICY) to client ko suggestion: "spice level 4 → 3 kar dein?" **Profile apne aap nahi badlegi.**
- Menu mein health condition ke khilaf koi cheez ho (jaise DIABETIC aur "gulab jamun") to sirf **warning** dikhegi, block nahi. (Optional; keyword list se, Phase E mein bhi daal sakte hain.)

### D3. APIs
**Client**
| Method | Path |
|---|---|
| GET / PUT | `/client/food-profile` |
| GET / PUT | `/client/placements/:pid/menu?week=2026-W42` |
| POST | `/client/menu/:id/approve` · `/client/menu/:id/reject` |
| GET | `/client/placements/:pid/meals?date=` |
| POST | `/client/meals/:id/feedback` |

**Staff**
| Method | Path |
|---|---|
| GET | `/staff/cook/today` (aaj ka menu + food profile summary) |
| POST | `/staff/cook/menu-suggestions` |
| POST | `/staff/cook/meals` (multipart, photos optional) |
| GET | `/staff/cook/meals?from&to` |

**RM web:** placement detail mein "Kitchen" tab (menu, meal logs + photos, ratings trend).

---

## Phase E — Ad-hoc Instructions + Reports + RM Dashboard

### E1. Instructions (har category ke liye)
**`client_instructions`**: `placement_id, client_id, staff_id, kind (ONE_TIME/RECURRING), text, voice_note_file_id, due_at, recurrence jsonb (times[], days[]), status (SENT/ACKNOWLEDGED/DONE/REFUSED/CANCELLED), staff_note, acknowledged_at, done_at, refused_at`

- **Voice note** support hoga, kyunki bahut staff ke liye padhna-likhna mushkil hai.
- Staff ke liye 3 button: **"Samjha"** (acknowledge), **"Ho gaya"** (done), **"Ye mera kaam nahi"** (refuse).
- Refuse karne pe `right_to_refuse_logs` mein entry banegi aur RM ko notification jaayega. RM SOW dekh ke faisla karega: staff sahi hai, ya client sahi hai aur staff ko karna hoga.
- Instruction ke saath staff ko us placement ka SOW summary dikhega.

APIs: client `POST/GET /client/placements/:pid/instructions`, `POST /client/instructions/:id/cancel` · staff `GET /staff/instructions`, `POST /staff/instructions/:id/ack|done|refuse` · RM `GET /rm/instructions?status=REFUSED`, `POST /rm/instructions/:id/resolve`.

### E2. Monthly report (client ke liye PDF)
`GET /client/placements/:pid/report?month=2026-10`:
- **Nurse:** dawa adherence %, vitals chart, missed doses
- **Cook:** meals count, average rating, top dishes

Invoice PDF wala renderer reuse karenge.

### E3. RM compliance dashboard
Har active placement ki ek row: aaj ka log bhara/nahi · missed doses (7 din) · vital alerts · cook rating · pending/refused instructions. Red/amber/green.

---

## Rule: Client app se jo bhi daala jaaye, woh staff app mein bhi dikhna chahiye

Client app mein jo bhi staff ke liye likha jaata hai, woh **usi placement ke staff ko uski app mein dikhna zaroori hai**. Koi bhi client input aisa nahi hoga jo sirf client aur RM ko dikhe aur staff ko na dikhe. Ye Phase C, D aur E teeno pe lagu hai.

### Kya-kya staff ko dikhega
| Client kya daalta hai | Staff ko kahan aur kaise dikhega |
|---|---|
| Care plan (dawa, vitals, exercise, diet, kya karna hai, kya nahi) | Poora plan read-only, aur roz ka checklist usi plan se |
| Prescription photo | Plan ke andar, dawa ke saath |
| Food profile (spice, allergy, health, pasand-napasand) | Har meal ke upar summary, aur poori profile ek tap pe |
| Weekly menu + din ki special instruction | "Aaj ka menu", har meal ke saath client ki instruction |
| Cook ke suggest kiye menu pe client ka approve/reject | Suggestion ka status + reject ka reason |
| Ad-hoc instruction (text / voice note) | Instructions list, voice note app mein hi chalega |
| Meal feedback (rating, tags, comment) | Meal log ke saath; cook ko pata chale client ko kya pasand aaya |

**Staff ko nahi dikhega:** client ki billing/invoice, doosre staff ka data, request/shortlist ki internal RM notes.

### Plan badla to staff ko kaise pata chalega
- Client jab bhi care plan, food profile ya menu badle, ya nayi instruction bheje: staff ko **turant push notification** (FCM) + in-app notification.
- Staff app ke home pe **"Client ki taraf se naya"** card, unread count ke saath.
- **Badlav saaf dikhe:** plan ka naya version aaye to staff ko sirf naya plan nahi, **kya badla** woh highlight karke dikhe ("Dawa jodi: Metformin 500mg, 8 baje" / "Spice level 4 → 2").
- **Staff "Padh liya" dabayega** (acknowledge). Client aur RM ko dikhega ki staff ne dekh liya ya nahi.
  - Care plan ke naye version ke liye: jab tak staff acknowledge na kare, checklist ke upar banner rahega "Plan badla hai — pehle dekh lo".
  - 2 ghante tak unread raha to RM ko alert (dawa wale badlav ke liye zaroori hai).

### Data / API ke badlav
- **`client_input_acks`** (nayi table): `placement_id, staff_id, input_type (CARE_PLAN/FOOD_PROFILE/MENU/INSTRUCTION), input_id, version, seen_at, acknowledged_at`. Unique(staff_id, input_type, input_id, version).
- Care plan version diff server banayega (`changes[]` response mein), app ko khud compare nahi karna padega.
- Staff ke endpoints:
  | Method | Path | Kaam |
  |---|---|---|
  | GET | `/staff/client-updates?placement_id=&unread=true` | sab client inputs ka ek feed, naya pehle, `changes[]` ke saath |
  | GET | `/staff/client-updates/unread-count` | home card ka badge |
  | POST | `/staff/client-updates/:type/:id/ack` | "Padh liya" |
  | GET | `/staff/placements/:pid/food-profile` | client ki food profile (read-only) |
  (care plan, menu aur instructions ke endpoints upar Phase C/D/E mein hain.)
- Client side: care plan, menu aur instruction ke response mein `staff_acknowledged_at` field, taaki client dekh sake staff ne padh liya.
- **Access check:** staff ko sirf woh placement ka data jahan woh abhi active hai (TRIAL/CONFIRMED). Placement exit hone ke baad us client ka data band.
- **Live test:** client plan badle → staff ke feed mein dikhe + `changes[]` sahi · push event fire ho · staff ack kare → client ko `staff_acknowledged_at` dikhe · exit ho chuke staff ko → 403.

---

## Phase F — Mobile brief (ek hi doc)

Mobile team ko **ek hi doc** milega: `docs/MOBILE_BRIEF_CLIENT_CARE_COOK.md`. Har phase backend + web live-test hone ke **baad** uska section isi doc mein judega. Jo section abhi bana nahi hai, woh ⏳ mark rahega.

| Section | Kya cover karega |
|---|---|
| 1. Series | `/meta/series` se picker; Maid/Driver hatana; CK short code; S2.5 screens chhupana ✅ |
| 2. Staff Request | Client: request form (series ke hisaab se fields), list, shortlist cards, select/reject/cancel |
| 3. Care plan | Client: care plan editor, aaj ka feed, history · Staff: checklist, vitals entry, daily report |
| 4. Cook | Client: food profile, weekly menu, meal feed + rating · Staff: aaj ka menu, meal log + photo, suggestions |
| 5. Instructions | Client: instruction + voice note · Staff: ack/done/refuse |
| 6. Staff ko client input | Staff: "Client ki taraf se naya" feed, unread badge, badlav ka highlight, "Padh liya", plan-change banner · Client: "staff ne padh liya" status |

Har section mein:
1. Flow diagram
2. Kaunsi screen banani hai aur kaunsi hatani hai
3. Har endpoint ka request/response (**real live call se copy kiya hua**)
4. Saare enum values: series ka long vs short form saaf likha hoga, kyunki isse 3 bug aa chuke hain
5. Error cases aur unke messages
6. Push notification events ke naam

---

## Sab phases pe lagu
- **Migrations:** additive raw SQL scripts (`scratch/_*_migration.js`). **Kabhi `db push --accept-data-loss` nahi**, aur prod pe prisma diff kabhi apply nahi. Prisma model declare karke `db push` zero-diff verify karna.
- **Prod pe:** COOK enum ke liye owner (`postgres`) credential. Deploy se pehle S2_5 pe koi staff to nahi, ye check.
- **Testing:** har phase ka live HTTP test suite (`npm run test:series`, `test:requests`, `test:care`, `test:cook`, `test:instructions`). Sirf `tsc` clean hona kaafi nahi.
- **Dates:** `@db.Date` columns (task_date, menu_date, meal_date) IST/UTC wale bug se bachne ke liye `YYYY-MM-DD` string se likhna, local-midnight `Date` se nahi.
- **Audit log:** care plan/menu/food profile ke badlav aur request status changes.

## Order aur andaaz
| Phase | Kaam | Depends on |
|---|---|---|
| A | Categories + COOK + S2.5 band | — |
| B | Staff Request | A (active series) |
| C | Care Plan + Daily Log | — (B ke saath parallel ho sakta hai) |
| D | Cook profile + Menu + Meal Log | A (COOK) |
| E | Instructions + Report + Dashboard | C, D |
| F | Mobile briefs | har phase ke baad |

## Abhi khule sawaal (default likha hai, badalna ho to batana)
1. Cook ki verification: Aadhaar + Health screening + PV CLEAR → **default yahi**
2. Cook ki training 5 din, trial 7 din → **default yahi**
3. Request mein ek se zyada staff (headcount > 1) → **haan**
4. Staff kitne purane din ka log bhar sake → **aaj + kal**
5. Vital alert kisko → **client + RM; critical pe BM bhi**
