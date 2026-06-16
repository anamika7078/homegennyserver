/** Enterprise permission codes — mapped to role_permissions at seed time */
export const PERMISSIONS = [
  // System
  { code: 'system.branches.manage', name: 'Manage branches', module: 'system' },
  { code: 'system.users.manage', name: 'Manage users', module: 'system' },
  { code: 'system.settings', name: 'System settings', module: 'system' },
  { code: 'system.reports', name: 'View reports', module: 'system' },
  { code: 'system.cron.monitor', name: 'Monitor cron jobs', module: 'system' },
  { code: 'system.restricted_list', name: 'Restricted list management', module: 'system' },
  { code: 'system.scenarios.manage', name: 'Scenario engine management', module: 'system' },
  // BM
  { code: 'bm.rms.manage', name: 'Manage RMs', module: 'bm' },
  { code: 'bm.escalations.approve', name: 'Approve escalations', module: 'bm' },
  { code: 'bm.denials.review', name: 'Review denials', module: 'bm' },
  { code: 'bm.scenario.override', name: 'Override scenario flows', module: 'bm' },
  { code: 'bm.agreements.approve', name: 'Approve agreements', module: 'bm' },
  { code: 'bm.training.review', name: 'Review training outcomes', module: 'bm' },
  { code: 'bm.analytics', name: 'Branch analytics', module: 'bm' },
  { code: 'bm.deployments.assign', name: 'Assign deployments', module: 'bm' },
  { code: 'bm.high_risk', name: 'Handle high-risk scenarios', module: 'bm' },
  // RM
  { code: 'rm.intake', name: 'Intake management', module: 'rm' },
  { code: 'rm.verification', name: 'Verification management', module: 'rm' },
  { code: 'rm.training', name: 'Training coordination', module: 'rm' },
  { code: 'rm.agreements', name: 'Agreement execution', module: 'rm' },
  { code: 'rm.deployments', name: 'Deployment management', module: 'rm' },
  { code: 'rm.trials', name: 'Trial tracking', module: 'rm' },
  { code: 'rm.followups', name: 'Daily follow-ups', module: 'rm' },
  { code: 'rm.care_logs', name: 'Care logs review', module: 'rm' },
  { code: 'rm.escalations', name: 'Escalation management', module: 'rm' },
  { code: 'rm.clients', name: 'Client coordination', module: 'rm' },
  // Trainer
  { code: 'trainer.s3.conduct', name: 'Conduct S3 training', module: 'trainer' },
  { code: 'trainer.attendance', name: 'Mark attendance', module: 'trainer' },
  { code: 'trainer.scores', name: 'Upload scores', module: 'trainer' },
  { code: 'trainer.assessments', name: 'Skill assessments', module: 'trainer' },
  { code: 'trainer.video_cert.delete', name: 'Delete video certifications', module: 'trainer' },
  { code: 'trainer.video_cert', name: 'Video certification', module: 'trainer' },
  // Assessor
  { code: 'assessor.s25.practical', name: 'S2.5 practical assessments', module: 'assessor' },
  { code: 'assessor.grading', name: 'Skill grading', module: 'assessor' },
  { code: 'assessor.overreach', name: 'Clinical overreach reporting', module: 'assessor' },
  { code: 'assessor.approve', name: 'Assessment approvals', module: 'assessor' },
  // Finance
  { code: 'finance.payroll', name: 'Payroll', module: 'finance' },
  { code: 'finance.invoices', name: 'Invoices', module: 'finance' },
  { code: 'finance.deposits', name: 'Deposit tracking', module: 'finance' },
  { code: 'finance.refunds', name: 'Refund management', module: 'finance' },
  { code: 'finance.gst', name: 'GST calculations', module: 'finance' },
  { code: 'finance.esic_pf', name: 'ESIC/PF calculations', module: 'finance' },
  // Additional permissions
  { code: 'pipeline.delete', name: 'Delete pipeline events (immutable audit log)', module: 'pipeline' },
  { code: 'fsm.override', name: 'Override FSM invalid stage transitions', module: 'fsm' },
  // Additional finance permissions
  { code: 'finance.unconfirmed_payroll', name: 'Unconfirmed payroll handling', module: 'finance' },
  // Client
  { code: 'client.personal_data', name: 'Client personal data', module: 'client' },
  // RM
  { code: 'rm.management', name: 'RM management operations', module: 'rm' },
  // Support
  { code: 'support.tickets', name: 'Ticket management', module: 'support' },
  { code: 'support.alerts', name: 'Alerts', module: 'support' },
  { code: 'support.followups', name: 'Follow-ups', module: 'support' },
  { code: 'support.notifications', name: 'Notifications', module: 'support' },
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number]['code'];

export const ROLE_PERMISSION_MAP: Record<string, PermissionCode[]> = {
  ADMIN: PERMISSIONS.map((p) => p.code),
  BM: [
    'bm.rms.manage', 'bm.escalations.approve', 'bm.denials.review', 'bm.scenario.override',
    'bm.agreements.approve', 'bm.training.review', 'bm.analytics', 'bm.deployments.assign',
    'bm.high_risk', 'system.restricted_list', 'system.reports', 'rm.intake', 'rm.verification',
    'rm.deployments', 'rm.escalations', 'support.alerts',
  ],
  RM: [
    'rm.intake', 'rm.verification', 'rm.training', 'rm.agreements', 'rm.deployments',
    'rm.trials', 'rm.followups', 'rm.care_logs', 'rm.escalations', 'rm.clients',
  ],
  TRAINER: [
    'trainer.s3.conduct', 'trainer.attendance', 'trainer.scores', 'trainer.assessments',
    'trainer.video_cert',
  ],
  ASSESSOR: [
    'assessor.s25.practical', 'assessor.grading', 'assessor.overreach', 'assessor.approve',
  ],
  FINANCE: [
    'finance.payroll', 'finance.invoices', 'finance.deposits', 'finance.refunds',
    'finance.gst', 'finance.esic_pf',
  ],
  SUPPORT: [
    'support.tickets', 'support.alerts', 'support.followups', 'support.notifications',
  ],
};

// ------------------------------------------------------------
// Finance role restrictions
// ------------------------------------------------------------
/**
 * List of permission codes that the Finance role is explicitly prohibited from accessing.
 * These are enforced in UI navigation and backend permission checks.
 */
export const FINANCE_PROHIBITED: PermissionCode[] = [
  // Pipeline and scenario data
  'rm.intake',
  'rm.verification',
  // Staff verification and salary management
  'rm.agreements',
  'rm.deployments',
  // Payroll for unconfirmed placements (assuming a specific permission code)
  'finance.unconfirmed_payroll',
  // Access to client personal data beyond basic info
  'client.personal_data',
  // Restricted list management
  'system.restricted_list',
  // RM operations management
  'rm.management',
];

/**
 * Helper to determine if a Finance role can access a given permission.
 * Returns false if the permission is in the prohibited list.
 */
export const BM_PROHIBITED: PermissionCode[] = [
  // Payroll and invoice processing (Finance only)
  'finance.payroll',
  'finance.invoices',
  'finance.unconfirmed_payroll',
  // System configuration (Admin only)
  'system.branches.manage',
  // Deleting pipeline events (immutable audit log)
  'pipeline.delete',
];

/**
 * Helper to determine if a BM role can access a given permission.
 * Returns false if the permission is in the prohibited list.
 */
export const RM_PROHIBITED: PermissionCode[] = [
  // Finance-related payroll and invoice actions (Finance only)
  'finance.payroll',
  'finance.invoices',
  'finance.unconfirmed_payroll',
  // Restricted list management (BM only)
  'system.restricted_list',
  // Branch configuration (Admin only)
  'system.branches.manage',
  // Access to other branches' staff or client data
  'rm.management',
  'client.personal_data',
  // FSM override attempts
  'fsm.override',
  // Delete video certifications (storage layer enforcement)
  'trainer.video_cert.delete',
];

/**
 * Helper to determine if an RM role can access a given permission.
 * Returns false if the permission is in the prohibited list.
 */
export function canRMAccess(permission: PermissionCode): boolean {
  return !RM_PROHIBITED.includes(permission);
}

export function canBMAccess(permission: PermissionCode): boolean {
  return !BM_PROHIBITED.includes(permission);
}




