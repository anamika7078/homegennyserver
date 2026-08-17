-- Additive: incidents.legal_hold exists in schema.prisma and on local dev DB but was
-- never migrated to production — GET /rm/incidents was crashing 500 there because
-- Prisma selects all model fields by default and the column didn't exist in the
-- production table. Discovered live-testing docs/RM_CLAUDE_PROMPT.md's endpoint list.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;
