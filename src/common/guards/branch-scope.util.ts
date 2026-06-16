export interface AuthUser {
  id: string;
  role: string;
  branchId?: string | null;
}

/** RM users are scoped to assigned staff; BM/ADMIN may pass explicit filters. */
export function resolveStaffScope(
  user: AuthUser,
  query: { rmId?: string; branchId?: string },
): { rmId?: string; branchId?: string } {
  if (user.role === 'RM') {
    return { rmId: user.id, branchId: user.branchId ?? undefined };
  }
  if (user.role === 'BM' && user.branchId) {
    return { branchId: user.branchId, rmId: query.rmId };
  }
  return { rmId: query.rmId, branchId: query.branchId };
}

export function assertStaffAccess(
  user: AuthUser,
  staff: { assignedRmId?: string | null; branchId?: string | null },
): void {
  if (user.role === 'ADMIN') return;
  if (user.role === 'RM' && staff.assignedRmId !== user.id) {
    throw new Error('FORBIDDEN_BRANCH');
  }
  if (user.role === 'BM' && user.branchId && staff.branchId !== user.branchId) {
    throw new Error('FORBIDDEN_BRANCH');
  }
}
