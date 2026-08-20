-- placement.service.ts's exit() has always tried to write exit_date and
-- exit_scenario_code via a raw UPDATE, with a silent .catch() fallback that
-- just sets status = EXITED on failure. Neither column ever existed, so
-- every exit silently lost its date/scenario_code and nobody noticed — the
-- API always returned success either way. Separately, finance/deposit's
-- listDeposits() references placements.exit_scenario_code directly with no
-- guard, which 500s outright. Purely additive, nullable — zero data-loss
-- risk (confirmed 0 EXITED rows on production before this ran).
ALTER TABLE placements ADD COLUMN IF NOT EXISTS exit_date DATE;
ALTER TABLE placements ADD COLUMN IF NOT EXISTS exit_scenario_code VARCHAR(20);
