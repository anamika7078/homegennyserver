import { BadRequestException } from '@nestjs/common';
import { StaffSeries } from '@prisma/client';

/**
 * Which staff series HomeGenny takes on right now.
 *
 * MAID and DRIVER are switched off for NEW staff only — the enum values stay,
 * and staff who already carry them keep working everywhere (profile, placement,
 * payroll, invoice). To bring one back, add it to ACTIVE_SERIES; nothing else
 * needs to change. See docs/CLIENT_REQUESTS_AND_DAILY_CARE_PLAN.md, Phase A.
 */
export const ACTIVE_SERIES: readonly StaffSeries[] = [
  StaffSeries.UNSKILLED_CARE,
  StaffSeries.SKILLED_CARE,
  StaffSeries.COOK,
  // StaffSeries.MAID,   — paused 2026-10-12
  // StaffSeries.DRIVER, — paused 2026-10-12 (takes Stage 2.5 with it)
];

/** Every series, in display order, with the short code the apps show and a label. */
export const SERIES_CATALOG: readonly { value: StaffSeries; short: string; label: string }[] = [
  { value: StaffSeries.UNSKILLED_CARE, short: 'UC', label: 'Unskilled Caretaker' },
  { value: StaffSeries.SKILLED_CARE, short: 'SC', label: 'Skilled Caretaker' },
  { value: StaffSeries.COOK, short: 'CK', label: 'Cook' },
  { value: StaffSeries.MAID, short: 'MAID', label: 'Maid' },
  { value: StaffSeries.DRIVER, short: 'DR', label: 'Driver' },
];

export function isSeriesActive(series: StaffSeries | string): boolean {
  return ACTIVE_SERIES.includes(series as StaffSeries);
}

/**
 * Stage 2.5 is the Driver practical test and nothing else, so it runs exactly
 * when Driver does. Staff already sitting in S2_5_ASSESS may still leave it.
 */
export function isStage25Enabled(): boolean {
  return isSeriesActive(StaffSeries.DRIVER);
}

/** Refuse a series that is not taken on right now. Use wherever a NEW staff series is written. */
export function assertSeriesActive(series: StaffSeries | string): void {
  if (!isSeriesActive(series)) {
    const label = SERIES_CATALOG.find((s) => s.value === series)?.label ?? String(series);
    const allowed = SERIES_CATALOG.filter((s) => isSeriesActive(s.value)).map((s) => s.label).join(', ');
    throw new BadRequestException(`${label} series is not being taken on right now. Allowed: ${allowed}.`);
  }
}
