/**
 * clear_all_staff.js
 * 
 * Deletes ALL Employee (HR module) and StaffApplicant (pipeline) records
 * in the correct foreign-key dependency order to avoid constraint violations.
 *
 * ⚠️  IRREVERSIBLE — make a DB backup first!
 *
 * Run with: node scratch/clear_all_staff.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('=== Starting full staff data cleanup ===\n');

  // ── 1. Employee HR Module ─────────────────────────────────────────────────
  console.log('--- Clearing Employee HR module ---');

  // batch_enrollments references Employee (no cascade)
  const be = await prisma.batchEnrollment.deleteMany({});
  console.log(`  ✓ BatchEnrollments deleted: ${be.count}`);

  // employee_payrolls, attendance, documents have CASCADE on Employee delete,
  // but we delete them explicitly for clarity / in case cascade is not set up in DB.
  const ep = await prisma.employeePayroll.deleteMany({});
  console.log(`  ✓ EmployeePayrolls deleted:  ${ep.count}`);

  const ea = await prisma.employeeAttendance.deleteMany({});
  console.log(`  ✓ EmployeeAttendance deleted: ${ea.count}`);

  const ed = await prisma.employeeDocument.deleteMany({});
  console.log(`  ✓ EmployeeDocuments deleted:  ${ed.count}`);

  const emp = await prisma.employee.deleteMany({});
  console.log(`  ✓ Employees deleted:          ${emp.count}`);

  // ── 2. StaffApplicant Pipeline ────────────────────────────────────────────
  console.log('\n--- Clearing StaffApplicant pipeline ---');

  const sl = await prisma.salaryLedger.deleteMany({});
  console.log(`  ✓ SalaryLedgers deleted:      ${sl.count}`);

  const payE = await prisma.payrollEntry.deleteMany({});
  console.log(`  ✓ PayrollEntries deleted:      ${payE.count}`);

  const vc = await prisma.videoCertification.deleteMany({});
  console.log(`  ✓ VideoCertifications deleted: ${vc.count}`);

  const dr = await prisma.deferredRecord.deleteMany({});
  console.log(`  ✓ DeferredRecords deleted:     ${dr.count}`);

  const ur = await prisma.upgradeRequest.deleteMany({});
  console.log(`  ✓ UpgradeRequests deleted:     ${ur.count}`);

  const sda = await prisma.staffDailyAttendance.deleteMany({});
  console.log(`  ✓ StaffDailyAttendance deleted:${sda.count}`);

  const shiftL = await prisma.shiftLog.deleteMany({});
  console.log(`  ✓ ShiftLogs deleted:           ${shiftL.count}`);

  const ic = await prisma.incidentComment.deleteMany({});
  console.log(`  ✓ IncidentComments deleted:    ${ic.count}`);

  const inc = await prisma.incident.deleteMany({});
  console.log(`  ✓ Incidents deleted:           ${inc.count}`);

  const ref = await prisma.refund.deleteMany({});
  console.log(`  ✓ Refunds deleted:             ${ref.count}`);

  const dep = await prisma.deposit.deleteMany({});
  console.log(`  ✓ Deposits deleted:            ${dep.count}`);

  const escL = await prisma.escalationLog.deleteMany({});
  console.log(`  ✓ EscalationLogs deleted:      ${escL.count}`);

  const medL = await prisma.medicationLog.deleteMany({});
  console.log(`  ✓ MedicationLogs deleted:      ${medL.count}`);

  const careL = await prisma.careLog.deleteMany({});
  console.log(`  ✓ CareLogs deleted:            ${careL.count}`);

  const deploy = await prisma.deployment.deleteMany({});
  console.log(`  ✓ Deployments deleted:         ${deploy.count}`);

  const agr = await prisma.agreement.deleteMany({});
  console.log(`  ✓ Agreements deleted:          ${agr.count}`);

  const al = await prisma.attendanceLog.deleteMany({});
  console.log(`  ✓ AttendanceLogs deleted:      ${al.count}`);

  const ts = await prisma.trainingSession.deleteMany({});
  console.log(`  ✓ TrainingSessions deleted:    ${ts.count}`);

  const assess = await prisma.assessment.deleteMany({});
  console.log(`  ✓ Assessments deleted:         ${assess.count}`);

  const vt = await prisma.verificationTrack.deleteMany({});
  console.log(`  ✓ VerificationTracks deleted:  ${vt.count}`);

  const scenL = await prisma.scenarioLog.deleteMany({});
  console.log(`  ✓ ScenarioLogs deleted:        ${scenL.count}`);

  const pipeE = await prisma.pipelineEvent.deleteMany({});
  console.log(`  ✓ PipelineEvents deleted:      ${pipeE.count}`);

  const staff = await prisma.staffApplicant.deleteMany({});
  console.log(`  ✓ StaffApplicants deleted:     ${staff.count}`);

  console.log('\n=== All staff data cleared successfully ===');
}

main()
  .catch((e) => {
    console.error('ERROR:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
