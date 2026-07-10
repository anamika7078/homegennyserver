/** Branch area codes: [City initial][Area initial][sequence] e.g. PB11 = Pune Baner */
export interface BranchAreaConfig {
  city: string;
  area: string;
  branch_code: string;
  branch_id: string;
}

export const DELHI_BRANCH_ID = '00000000-0000-0000-0000-000000000001';
export const PUNE_BRANCH_ID = '00000000-0000-0000-0000-000000000002';
export const MUMBAI_BRANCH_ID = '00000000-0000-0000-0000-000000000003';

export const BRANCH_AREA_CONFIG: BranchAreaConfig[] = [
  // Delhi NCR
  { city: 'Delhi NCR', area: 'Gurgaon', branch_code: 'DG11', branch_id: DELHI_BRANCH_ID },
  { city: 'Delhi NCR', area: 'Noida', branch_code: 'DN12', branch_id: DELHI_BRANCH_ID },
  { city: 'Delhi NCR', area: 'South Delhi', branch_code: 'DS13', branch_id: DELHI_BRANCH_ID },
  { city: 'New Delhi', area: 'Gurgaon', branch_code: 'DG11', branch_id: DELHI_BRANCH_ID },
  { city: 'New Delhi', area: 'Noida', branch_code: 'DN12', branch_id: DELHI_BRANCH_ID },
  // Pune
  { city: 'Pune', area: 'Baner', branch_code: 'PB11', branch_id: PUNE_BRANCH_ID },
  { city: 'Pune', area: 'Karver Nagar', branch_code: 'PK12', branch_id: PUNE_BRANCH_ID },
  { city: 'Pune', area: 'Moshi', branch_code: 'PM13', branch_id: PUNE_BRANCH_ID },
  // Mumbai
  { city: 'Mumbai', area: 'Andheri', branch_code: 'MA11', branch_id: MUMBAI_BRANCH_ID },
  { city: 'Mumbai', area: 'Bandra', branch_code: 'MB12', branch_id: MUMBAI_BRANCH_ID },
];

export function areasForCity(city: string): BranchAreaConfig[] {
  const seen = new Set<string>();
  return BRANCH_AREA_CONFIG.filter((a) => {
    if (a.city !== city) return false;
    const key = `${a.area}:${a.branch_code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function findArea(city: string, branchCode: string): BranchAreaConfig | undefined {
  return BRANCH_AREA_CONFIG.find((a) => a.city === city && a.branch_code === branchCode);
}

export function findAreaByCode(branchCode: string): BranchAreaConfig | undefined {
  return BRANCH_AREA_CONFIG.find((a) => a.branch_code === branchCode);
}
