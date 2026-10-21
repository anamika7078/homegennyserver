import {
  StaffApplicant as PrismaStaff,
  StaffSeries,
  PipelineStage,
  PvStatus,
  LanguageTier,
  StageHold,
} from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { assertSeriesActive } from '../config/active-series';

function parseRoleTypes(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    // Backward compatibility for older rows / older Prisma schema
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [String(parsed)];
    } catch {
      return value.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return [String(value)].filter(Boolean);
}

/** The S1 fields still empty — the same four the S1→S2 gate in pipeline-fsm checks. */
export function intakeMissing(row: Pick<PrismaStaff, 'fullName' | 'dateOfBirth' | 'address' | 'series'>): string[] {
  return [
    !row.fullName?.trim() && 'full_name',
    !row.dateOfBirth && 'date_of_birth',
    !row.address?.trim() && 'address',
    !row.series && 'series',
  ].filter((x): x is string => !!x);
}

/** API / legacy snake_case shape expected by frontend. `open_holds` is present only when the caller loaded them. */
export function toStaffDto(row: PrismaStaff & { stageHolds?: StageHold[] }) {
  return {
    ...(row.stageHolds
      ? {
          open_holds: row.stageHolds
            .filter((h) => !h.releasedAt)
            .map((h) => ({ id: h.id, stage: h.stage, kind: h.kind, reason: h.reason, notes: h.notes, held_at: h.heldAt })),
        }
      : {}),
    id: row.id,
    staff_code: row.staffCode,
    branch_id: row.branchId,
    assigned_rm_id: row.assignedRmId,
    series: mapSeriesToShort(row.series),
    series_db: row.series,
    role_types: parseRoleTypes(row.roleTypes),
    language_tier: row.languageTier,
    pipeline_stage: row.pipelineStage,
    current_scenario_code: row.currentScenarioCode,
    terminal_outcome: row.terminalOutcome,
    full_name: row.fullName,
    // An app sign-up gives a mobile number only; the RM fills the rest on "Complete S1".
    intake_missing: intakeMissing(row),
    intake_complete: intakeMissing(row).length === 0,
    date_of_birth: row.dateOfBirth,
    mobile: row.mobile,
    email: row.email,
    aadhaar_number: row.aadhaarNumber,
    address: row.address,
    emergency_contact_name: row.emergencyContactName,
    emergency_contact_mobile: row.emergencyContactMobile,
    verified_docs: row.verifiedDocs,
    pv_status: row.pvStatus,
    restricted_list_flag: row.restrictedListFlag,
    video_cert_id: row.videoCertId,
    restrictions: row.restrictions,
    metadata: row.metadata,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/**
 * Either vocabulary in, the DB enum out. An unknown value is refused rather
 * than guessed: this used to fall back to SKILLED_CARE, which would have
 * quietly filed every new cook as a skilled caretaker.
 */
export function mapSeriesFromShort(s: string): StaffSeries {
  const m: Record<string, StaffSeries> = {
    DR: StaffSeries.DRIVER,
    DRIVER: StaffSeries.DRIVER,
    SC: StaffSeries.SKILLED_CARE,
    SKILLED_CARE: StaffSeries.SKILLED_CARE,
    UC: StaffSeries.UNSKILLED_CARE,
    UNSKILLED_CARE: StaffSeries.UNSKILLED_CARE,
    MAID: StaffSeries.MAID,
    M3X: StaffSeries.MAID,
    CK: StaffSeries.COOK,
    COOK: StaffSeries.COOK,
  };
  const series = m[String(s ?? '').trim().toUpperCase()];
  if (!series) {
    throw new BadRequestException(`Unknown series "${s}". Use one of: UC, SC, CK (or MAID, DR for existing staff).`);
  }
  return series;
}

/** Staff who signed up from the app have no series until the RM completes S1 — that stays null. */
export function mapSeriesToShort(s: StaffSeries): string;
export function mapSeriesToShort(s: StaffSeries | null): string | null;
export function mapSeriesToShort(s: StaffSeries | null): string | null {
  if (s == null) return null;
  const m: Record<StaffSeries, string> = {
    [StaffSeries.DRIVER]: 'DR',
    [StaffSeries.SKILLED_CARE]: 'SC',
    [StaffSeries.UNSKILLED_CARE]: 'UC',
    [StaffSeries.MAID]: 'MAID',
    [StaffSeries.COOK]: 'CK',
  };
  return m[s] ?? s;
}

export function generateStaffCode(series: StaffSeries): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seq = Math.floor(Math.random() * 9999).toString().padStart(4, '0');
  const code = mapSeriesToShort(series).slice(0, 2).toUpperCase();
  return `HG-${code}-${date}-${seq}`;
}

/** Builds a NEW staff row, so the series must be given and must be one HomeGenny takes on now. */
export function parseCreateStaffBody(body: Record<string, unknown>) {
  if (body.series === undefined || body.series === null || body.series === '') {
    throw new BadRequestException('series is required (UC, SC or CK).');
  }
  const series = mapSeriesFromShort(String(body.series));
  assertSeriesActive(series);
  const roleTypes =
    body.role_types === undefined || body.role_types === null
      ? []
      : Array.isArray(body.role_types)
        ? (body.role_types as unknown[]).map(String).filter(Boolean)
        : [String(body.role_types)].filter(Boolean);
  return {
    staffCode: (body.staff_code as string) || generateStaffCode(series),
    branchId: body.branch_id ? String(body.branch_id) : undefined,
    assignedRmId: body.assigned_rm_id ? String(body.assigned_rm_id) : undefined,
    series,
    roleTypes,
    languageTier: body.language_tier
      ? (String(body.language_tier) as LanguageTier)
      : undefined,
    pipelineStage: (body.pipeline_stage as PipelineStage) ?? PipelineStage.S1_INTAKE,
    fullName: String(body.full_name ?? ''),
    dateOfBirth: body.date_of_birth
      ? new Date(String(body.date_of_birth))
      : new Date('1990-01-01'),
    mobile: String(body.mobile ?? ''),
    email: body.email ? String(body.email) : undefined,
    aadhaarNumber: body.aadhaar_number ? String(body.aadhaar_number) : undefined,
    address: body.address ? String(body.address) : '',
    metadata: (body.metadata as object) ?? {},
  };
}
