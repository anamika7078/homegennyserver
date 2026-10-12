/**
 * Daily care, cook tracking, client instructions — Phases C, D, E and the
 * "staff sees every client input" rule of docs/CLIENT_REQUESTS_AND_DAILY_CARE_PLAN.md.
 *
 *   care_plans          client's care plan for a caretaker placement, one row per version
 *   care_tasks          the day's checklist, generated from the active plan
 *   daily_care_reports  the caretaker's end-of-day summary
 *   food_profiles       what a household eats — per client, so it outlives a cook
 *   menu_plans          what to cook, per placement / date / meal
 *   meal_logs           what the cook made
 *   meal_feedback       the client's rating of a meal
 *   client_instructions ad-hoc orders from client to staff (text or voice)
 *   client_input_acks   which client input a staff member has seen / acknowledged
 *   care_files          photos, prescriptions and voice notes for all of the above
 *
 * The old care_logs / medication_logs tables are left alone: they hang off
 * `deployments`, are empty, and nothing reads them.
 *
 * Additive, re-runnable. Foreign keys only to `placements` and between these
 * tables — every one of them declared in prisma/schema.prisma, so a db push
 * keeps them. Staff, client and user ids are checked in code.
 *
 *   node scratch/_daily_care_migration.js
 */
const { Client } = require('pg');
require('dotenv').config();

const STEPS = [
  {
    label: 'care_plans',
    sql: `CREATE TABLE IF NOT EXISTS care_plans (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            placement_id  UUID NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
            client_id     UUID NOT NULL,
            version       INT NOT NULL,
            status        VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUPERSEDED')),
            patient       JSONB NOT NULL DEFAULT '{}'::jsonb,
            medications   JSONB NOT NULL DEFAULT '[]'::jsonb,
            vitals        JSONB NOT NULL DEFAULT '[]'::jsonb,
            activities    JSONB NOT NULL DEFAULT '[]'::jsonb,
            diet_notes    TEXT,
            dos           TEXT,
            donts         TEXT,
            changes       JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_by    UUID,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            superseded_at TIMESTAMPTZ,
            metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
            UNIQUE (placement_id, version)
          )`,
  },
  {
    label: 'care_tasks',
    sql: `CREATE TABLE IF NOT EXISTS care_tasks (
            id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            placement_id   UUID NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
            plan_id        UUID NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
            task_date      DATE NOT NULL,
            source_type    VARCHAR(20) NOT NULL CHECK (source_type IN ('MEDICATION','VITAL','ACTIVITY')),
            source_id      VARCHAR(64) NOT NULL,
            title          VARCHAR(255) NOT NULL,
            scheduled_time VARCHAR(5) NOT NULL,
            status         VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DONE','SKIPPED','MISSED')),
            done_at        TIMESTAMPTZ,
            done_by        UUID,
            value          JSONB,
            out_of_range   BOOLEAN NOT NULL DEFAULT false,
            skip_reason    TEXT,
            notes          TEXT,
            notified_at    TIMESTAMPTZ,
            created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (placement_id, task_date, source_type, source_id, scheduled_time)
          )`,
  },
  { label: 'care_tasks index', sql: `CREATE INDEX IF NOT EXISTS idx_care_tasks_day ON care_tasks (placement_id, task_date)` },
  {
    label: 'daily_care_reports',
    sql: `CREATE TABLE IF NOT EXISTS daily_care_reports (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            placement_id    UUID NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
            staff_id        UUID NOT NULL,
            report_date     DATE NOT NULL,
            meals           JSONB NOT NULL DEFAULT '[]'::jsonb,
            fluid_intake_ml INT,
            sleep           VARCHAR(50),
            mood            VARCHAR(50),
            hygiene         JSONB NOT NULL DEFAULT '{}'::jsonb,
            notes           TEXT,
            submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (placement_id, report_date)
          )`,
  },
  {
    label: 'food_profiles',
    sql: `CREATE TABLE IF NOT EXISTS food_profiles (
            id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            client_id         UUID NOT NULL UNIQUE,
            version           INT NOT NULL DEFAULT 1,
            diet_type         VARCHAR(20),
            allergies         JSONB NOT NULL DEFAULT '[]'::jsonb,
            spice_level       INT CHECK (spice_level BETWEEN 1 AND 5),
            salt              VARCHAR(10),
            oil               VARCHAR(10),
            health_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
            cuisines          JSONB NOT NULL DEFAULT '[]'::jsonb,
            dislikes          TEXT,
            family_size       INT,
            notes             TEXT,
            previous          JSONB,
            updated_by        UUID,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    label: 'menu_plans',
    sql: `CREATE TABLE IF NOT EXISTS menu_plans (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            placement_id        UUID NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
            menu_date           DATE NOT NULL,
            meal                VARCHAR(20) NOT NULL CHECK (meal IN ('BREAKFAST','LUNCH','SNACKS','DINNER')),
            dishes              JSONB NOT NULL DEFAULT '[]'::jsonb,
            special_instruction TEXT,
            servings            INT,
            status              VARCHAR(20) NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','SUGGESTED','APPROVED','REJECTED')),
            version             INT NOT NULL DEFAULT 1,
            previous            JSONB,
            reject_reason       TEXT,
            created_by          UUID,
            created_by_role     VARCHAR(20),
            created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (placement_id, menu_date, meal)
          )`,
  },
  {
    label: 'meal_logs',
    sql: `CREATE TABLE IF NOT EXISTS meal_logs (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            placement_id UUID NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
            staff_id     UUID NOT NULL,
            meal_date    DATE NOT NULL,
            meal         VARCHAR(20) NOT NULL CHECK (meal IN ('BREAKFAST','LUNCH','SNACKS','DINNER')),
            menu_plan_id UUID REFERENCES menu_plans(id) ON DELETE SET NULL,
            dishes       JSONB NOT NULL DEFAULT '[]'::jsonb,
            servings     INT,
            cooked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            notes        TEXT,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (placement_id, meal_date, meal)
          )`,
  },
  {
    label: 'meal_feedback',
    sql: `CREATE TABLE IF NOT EXISTS meal_feedback (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            meal_log_id UUID NOT NULL UNIQUE REFERENCES meal_logs(id) ON DELETE CASCADE,
            rating      INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
            tags        JSONB NOT NULL DEFAULT '[]'::jsonb,
            comment     TEXT,
            created_by  UUID,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    label: 'client_instructions',
    sql: `CREATE TABLE IF NOT EXISTS client_instructions (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            placement_id    UUID NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
            client_id       UUID NOT NULL,
            staff_id        UUID NOT NULL,
            kind            VARCHAR(20) NOT NULL DEFAULT 'ONE_TIME' CHECK (kind IN ('ONE_TIME','RECURRING')),
            text            TEXT,
            voice_file_id   UUID,
            due_at          TIMESTAMPTZ,
            recurrence      JSONB,
            status          VARCHAR(20) NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT','ACKNOWLEDGED','DONE','REFUSED','CANCELLED')),
            staff_note      TEXT,
            acknowledged_at TIMESTAMPTZ,
            done_at         TIMESTAMPTZ,
            refused_at      TIMESTAMPTZ,
            refusal_id      UUID,
            rm_decision     VARCHAR(20) CHECK (rm_decision IN ('UPHELD','OVERTURNED')),
            rm_note         TEXT,
            decided_at      TIMESTAMPTZ,
            decided_by      UUID,
            created_by      UUID,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  { label: 'client_instructions index', sql: `CREATE INDEX IF NOT EXISTS idx_client_instructions_placement ON client_instructions (placement_id, created_at DESC)` },
  {
    label: 'client_input_acks',
    sql: `CREATE TABLE IF NOT EXISTS client_input_acks (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            placement_id    UUID NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
            staff_id        UUID NOT NULL,
            input_type      VARCHAR(20) NOT NULL CHECK (input_type IN ('CARE_PLAN','FOOD_PROFILE','MENU','INSTRUCTION','MEAL_FEEDBACK')),
            input_id        UUID NOT NULL,
            version         INT NOT NULL DEFAULT 1,
            seen_at         TIMESTAMPTZ,
            acknowledged_at TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (staff_id, input_type, input_id, version)
          )`,
  },
  {
    label: 'care_files',
    sql: `CREATE TABLE IF NOT EXISTS care_files (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            placement_id  UUID NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
            kind          VARCHAR(20) NOT NULL CHECK (kind IN ('PHOTO','PRESCRIPTION','VOICE')),
            storage_key   TEXT NOT NULL,
            mime_type     VARCHAR(100) NOT NULL,
            size          INT NOT NULL,
            original_name VARCHAR(255),
            uploaded_by   UUID,
            uploaded_role VARCHAR(20),
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  { label: 'care_files index', sql: `CREATE INDEX IF NOT EXISTS idx_care_files_placement ON care_files (placement_id)` },
  {
    label: 'photo_file_ids on care_tasks and daily_care_reports',
    sql: `ALTER TABLE care_tasks ADD COLUMN IF NOT EXISTS photo_file_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
          ALTER TABLE daily_care_reports ADD COLUMN IF NOT EXISTS photo_file_ids JSONB NOT NULL DEFAULT '[]'::jsonb`,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — aborting without touching anything.');
    process.exit(1);
  }
  const host = new URL(url).hostname;
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(host);
  console.log(`Target: ${host}${isLocal ? '' : '  ** REMOTE **'}\n`);

  const c = new Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const step of STEPS) {
      await c.query(step.sql);
      console.log(`  ok    ${step.label}`);
    }
    await c.query('COMMIT');
    console.log('\nMigration applied — daily care, cook tracking and instructions can be recorded now.\n');
  } catch (err) {
    await c.query('ROLLBACK');
    console.error('\nRolled back — nothing was changed.');
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
