export const SC_CARE_TYPES = ['EC', 'PS', 'DC', 'CP', 'PD', 'MH', 'DS'] as const;
export const UC_ROLE_TYPES = ['CS', 'GC', 'MS', 'EC', 'NS', 'BP'] as const;

/** Medical duties only SC may perform */
export const MEDICAL_DUTY_CODES = ['MEDICATION', 'VITALS', 'WOUND_CARE', 'INJECTION', 'CLINICAL_ESCALATION'];

export type ScCareType = (typeof SC_CARE_TYPES)[number];
export type UcRoleType = (typeof UC_ROLE_TYPES)[number];
