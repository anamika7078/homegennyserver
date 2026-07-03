import { UserRole } from '@prisma/client';

export const PORTAL_BRANCH_ID = '00000000-0000-0000-0000-000000000001';

/** Portal demo Admin — phone 9800000003 */
export const PORTAL_ADMIN_PHONE = '9800000003';

/**
 * Fixed base32 TOTP secret for the portal demo Admin account.
 * On deploy, bootstrap resets Admin 2FA to this secret so the QR setup flow is recoverable.
 * Add key manually in Google Authenticator or scan the QR on first login.
 */
export const PORTAL_ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

export const PORTAL_USER_PHONES = [
  '9800000001',
  '9800000002',
  '9800000003',
  '9800000004',
  '9800000005',
  '9800000006',
  '9800000007',
] as const;

export const PORTAL_USERS: Array<{
  phone: string;
  role: UserRole;
  fullName: string;
  email: string;
}> = [
  { phone: '9800000001', role: UserRole.BM, fullName: 'Amit Gupta', email: 'bm@homegenny.com' },
  { phone: '9800000002', role: UserRole.RM, fullName: 'Pooja Mishra', email: 'rm@homegenny.com' },
  { phone: '9800000003', role: UserRole.ADMIN, fullName: 'Super Admin', email: 'admin@homegenny.com' },
  { phone: '9800000004', role: UserRole.FINANCE, fullName: 'Rajesh Finance', email: 'finance@homegenny.com' },
  { phone: '9800000005', role: UserRole.TRAINER, fullName: 'Sunita Trainer', email: 'trainer@homegenny.com' },
  { phone: '9800000006', role: UserRole.ASSESSOR, fullName: 'Dr. Kavita Assessor', email: 'assessor@homegenny.com' },
  { phone: '9800000007', role: UserRole.SUPPORT, fullName: 'Ops Support', email: 'support@homegenny.com' },
];
