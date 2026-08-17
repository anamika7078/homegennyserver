-- Additive: scope_of_work and client_indemnities exist in schema.prisma and on local dev
-- DB but were never migrated to production — GET /sow was crashing 500 there because the
-- table doesn't exist at all (not just a missing column, this time). Discovered live-testing
-- docs/RM_CLAUDE_PROMPT.md's endpoint list. No FK constraints added, matching how other
-- gap-filling tables in this codebase were built (placements.staff_id/client_id also have
-- none) — keeps this purely additive with zero risk of insert failures from FK mismatches.

CREATE TABLE IF NOT EXISTS scope_of_work (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id     UUID NOT NULL,
  client_id        UUID NOT NULL,
  staff_id         UUID NOT NULL,
  content          TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  status           VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  is_non_standard  BOOLEAN NOT NULL DEFAULT false,
  bm_approved_by   UUID,
  bm_approved_at   TIMESTAMPTZ,
  created_by       UUID NOT NULL,
  amended_by       UUID,
  sent_at          TIMESTAMPTZ,
  acknowledged_by  UUID,
  acknowledged_at  TIMESTAMPTZ,
  supersedes_id    UUID UNIQUE,
  metadata         JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scope_of_work_placement_id ON scope_of_work(placement_id);
CREATE INDEX IF NOT EXISTS idx_scope_of_work_client_id ON scope_of_work(client_id);

CREATE TABLE IF NOT EXISTS client_indemnities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id     UUID NOT NULL,
  client_id        UUID NOT NULL,
  clause_version   VARCHAR(40) NOT NULL,
  clause_text      TEXT NOT NULL,
  sent_by          UUID NOT NULL,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by  UUID,
  acknowledged_at  TIMESTAMPTZ,
  contested        BOOLEAN NOT NULL DEFAULT false,
  bm_reviewed_by   UUID,
  bm_review_notes  TEXT,
  bm_reviewed_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_indemnities_placement_id ON client_indemnities(placement_id);
CREATE INDEX IF NOT EXISTS idx_client_indemnities_client_id ON client_indemnities(client_id);
