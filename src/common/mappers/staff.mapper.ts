import {
  StaffApplicant as PrismaStaff,
  StaffSeries,
  PipelineStage,
  PvStatus,
  LanguageTier,
} from '@prisma/client';

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

/** API / legacy snake_case shape expected by frontend */
export function toStaffDto(row: PrismaStaff) {
  return {
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
    date_of_birth: row.dateOfBirth,
    mobile: row.mobile,
    email: row.email,
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

export function mapSeriesFromShort(s: string): StaffSeries {
  const m: Record<string, StaffSeries> = {
    DR: StaffSeries.DRIVER,
    DRIVER: StaffSeries.DRIVER,
    SC: StaffSeries.SKILLED_CARE,
    SKILLED_CARE: StaffSeries.SKILLED_CARE,
    UC: StaffSeries.UNSKILLED_CARE,
    UNSKILLED_CARE: StaffSeries.UNSKILLED_CARE,
    MAID: StaffSeries.MAID,
  };
  return m[s] ?? StaffSeries.SKILLED_CARE;
}

export function mapSeriesToShort(s: StaffSeries): string {
  const m: Record<StaffSeries, string> = {
    [StaffSeries.DRIVER]: 'DR',
    [StaffSeries.SKILLED_CARE]: 'SC',
    [StaffSeries.UNSKILLED_CARE]: 'UC',
    [StaffSeries.MAID]: 'MAID',
  };
  return m[s] ?? s;
}

export function generateStaffCode(series: StaffSeries): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seq = Math.floor(Math.random() * 9999).toString().padStart(4, '0');
  const code = mapSeriesToShort(series).slice(0, 2).toUpperCase();
  return `HG-${code}-${date}-${seq}`;
}

export function parseCreateStaffBody(body: Record<string, unknown>) {
  const series = mapSeriesFromShort(String(body.series ?? 'SC'));
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
    address: body.address ? String(body.address) : '',
    metadata: (body.metadata as object) ?? {},
  };
}
