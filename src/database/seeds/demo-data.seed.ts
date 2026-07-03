/**
 * Demo operational data for Trainer and Finance portal flows.
 * Idempotent — safe to re-run (uses fixed UUIDs + upserts).
 */
import {
  PrismaClient,
  StaffSeries,
  PipelineStage,
  AssessmentResult,
  PlacementStatus,
} from '@prisma/client';

const BRANCH_ID = '00000000-0000-0000-0000-000000000001';

// ── Trainer staff (S3_TRAIN) ──────────────────────────────────────────────────
const TR_STAFF = {
  dr:   '11111111-1111-1111-1111-111111111111',
  sc:   '22222222-2222-2222-2222-222222222222',
  uc:   '33333333-3333-3333-3333-333333333333',
  maid: '44444444-4444-4444-4444-444444444444',
  dr2:  '55555555-5555-5555-5555-555555555555',
} as const;

// ── Finance staff (S5_DEPLOY) ─────────────────────────────────────────────────
const FIN_STAFF = {
  maid: 'f1111111-1111-1111-1111-111111111111',
  dr:   'f2222222-2222-2222-2222-222222222222',
  sc:   'f3333333-3333-3333-3333-333333333333',
  uc:   'f4444444-4444-4444-4444-444444444444',
} as const;

const CLIENTS = {
  saxena: 'c1111111-1111-1111-1111-111111111111',
  kapoor: 'c2222222-2222-2222-2222-222222222222',
  mehta:  'c3333333-3333-3333-3333-333333333333',
} as const;

const PLACEMENTS = {
  maid: 'p1111111-1111-1111-1111-111111111111',
  dr:   'p2222222-2222-2222-2222-222222222222',
  sc:   'p3333333-3333-3333-3333-333333333333',
  uc:   'p4444444-4444-4444-4444-444444444444',
} as const;

export async function seedDemoData(prisma: PrismaClient) {
  console.log('[SEED] Demo operational data (Trainer + Finance)...');

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const rm = await prisma.user.findUnique({ where: { phone: '9800000002' } });
  const rmId = rm?.id ?? null;

  await prisma.branch.upsert({
    where: { id: BRANCH_ID },
    create: {
      id: BRANCH_ID,
      name: 'HomeGenny Delhi NCR HQ',
      city: 'New Delhi',
      state: 'Delhi',
      email: 'delhi@homegenny.com',
      gstin: '07AABCH1234A1Z8',
    },
    update: {},
  });

  // ── Trainer trainees ───────────────────────────────────────────────────────
  const trainerStaff = [
    { id: TR_STAFF.dr,   code: 'ST-DR-001', series: StaffSeries.DRIVER,         name: 'Amit Sharma' },
    { id: TR_STAFF.sc,   code: 'ST-SC-002', series: StaffSeries.SKILLED_CARE,   name: 'Sunita Kumar' },
    { id: TR_STAFF.uc,   code: 'ST-UC-003', series: StaffSeries.UNSKILLED_CARE, name: 'Rahul Verma' },
    { id: TR_STAFF.maid, code: 'ST-M3-004', series: StaffSeries.MAID,           name: 'Kavita Devi' },
    { id: TR_STAFF.dr2,  code: 'ST-DR-005', series: StaffSeries.DRIVER,         name: 'Vikram Singh' },
  ];

  for (const s of trainerStaff) {
    await prisma.staffApplicant.upsert({
      where: { id: s.id },
      create: {
        id: s.id,
        staffCode: s.code,
        branchId: BRANCH_ID,
        assignedRmId: rmId,
        series: s.series,
        fullName: s.name,
        dateOfBirth: new Date('1995-01-15'),
        mobile: `91${s.code.slice(-4)}00001`,
        address: 'Delhi NCR',
        pipelineStage: PipelineStage.S3_TRAIN,
      },
      update: { pipelineStage: PipelineStage.S3_TRAIN, assignedRmId: rmId },
    });
  }

  // ── Training batches ─────────────────────────────────────────────────────────
  const batches = [
    {
      id: 'b0000000-0000-0000-0000-000000000001',
      code: 'BT-DR-ACTIVE',
      series: 'DR',
      classroom: 'Classroom A',
      startDate: now,
      status: 'ACTIVE',
    },
    {
      id: 'b0000000-0000-0000-0000-000000000002',
      code: 'BT-SC-UPCOMING',
      series: 'SC',
      classroom: 'Classroom B',
      startDate: new Date(now.getTime() + 5 * 86400000),
      status: 'UPCOMING',
    },
    {
      id: 'b0000000-0000-0000-0000-000000000003',
      code: 'BT-UC-DONE',
      series: 'UC',
      classroom: 'Classroom C',
      startDate: new Date(now.getTime() - 15 * 86400000),
      status: 'COMPLETED',
    },
    {
      id: 'b0000000-0000-0000-0000-000000000004',
      code: 'BT-M3-ACTIVE',
      series: 'MAID',
      classroom: 'Classroom D',
      startDate: now,
      status: 'ACTIVE',
    },
  ];

  for (const b of batches) {
    await prisma.trainingBatch.upsert({
      where: { id: b.id },
      create: {
        id: b.id,
        batchCode: b.code,
        series: b.series,
        trainerName: 'Sunita Trainer',
        classroom: b.classroom,
        startDate: b.startDate,
        status: b.status,
        branchId: BRANCH_ID,
        rmId,
      },
      update: { status: b.status, trainerName: 'Sunita Trainer' },
    });
  }

  const enrollments = [
    { batchId: batches[0].id, staffId: TR_STAFF.dr,   attendance: [1, 2, 3] },
    { batchId: batches[0].id, staffId: TR_STAFF.dr2,  attendance: [1, 2] },
    { batchId: batches[1].id, staffId: TR_STAFF.sc,   attendance: [] },
    { batchId: batches[2].id, staffId: TR_STAFF.uc,   attendance: [1, 2, 3, 4, 5] },
    { batchId: batches[3].id, staffId: TR_STAFF.maid, attendance: [1] },
    { batchId: batches[3].id, staffId: TR_STAFF.sc,   attendance: [1] },
  ];

  for (const e of enrollments) {
    await prisma.batchEnrollment.upsert({
      where: { batchId_staffId: { batchId: e.batchId, staffId: e.staffId } },
      create: { batchId: e.batchId, staffId: e.staffId, attendance: e.attendance },
      update: { attendance: e.attendance },
    });
  }

  // ── Video certifications ─────────────────────────────────────────────────────
  const videoCerts = [
    {
      id: 'ea000000-0000-0000-0000-000000000001',
      staffId: TR_STAFF.sc,
      promptKey: 'patient_transfer_sc_01',
      reviewStatus: 'PENDING',
      attemptNumber: 1,
    },
    {
      id: 'ea000000-0000-0000-0000-000000000002',
      staffId: TR_STAFF.dr,
      promptKey: 'safe_driving_dr_03',
      reviewStatus: 'PENDING',
      attemptNumber: 2,
    },
    {
      id: 'ea000000-0000-0000-0000-000000000003',
      staffId: TR_STAFF.uc,
      promptKey: 'elderly_care_uc_05',
      reviewStatus: 'APPROVED',
      attemptNumber: 1,
      reviewNotes: 'Clear demonstration of bathing assistance protocol.',
    },
    {
      id: 'ea000000-0000-0000-0000-000000000004',
      staffId: TR_STAFF.maid,
      promptKey: 'housekeeping_maid_02',
      reviewStatus: 'REJECTED',
      attemptNumber: 1,
      reviewNotes: 'Video too short — please re-record with full prompt coverage.',
    },
  ];

  for (const vc of videoCerts) {
    await prisma.videoCertification.upsert({
      where: { id: vc.id },
      create: {
        id: vc.id,
        staffId: vc.staffId,
        promptKey: vc.promptKey,
        videoUrl: `video-certs/demo/${vc.staffId}/${vc.promptKey}.mp4`,
        sha256Hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        attemptNumber: vc.attemptNumber,
        reviewStatus: vc.reviewStatus,
        reviewNotes: vc.reviewNotes ?? null,
        neverDelete: true,
      },
      update: { reviewStatus: vc.reviewStatus, reviewNotes: vc.reviewNotes ?? null },
    });
  }

  // ── Assessments ──────────────────────────────────────────────────────────────
  await prisma.assessment.upsert({
    where: { id: 'fa000000-0000-0000-0000-000000000001' },
    create: {
      id: 'fa000000-0000-0000-0000-000000000001',
      staffId: TR_STAFF.uc,
      attemptNumber: 1,
      result: AssessmentResult.PASS,
      status: 'COMPLETED',
      skillScores: { communication: 85, technical: 90, empathy: 95 },
      remarks: 'Excellent practical skills during trial sessions.',
    },
    update: { status: 'COMPLETED' },
  });

  await prisma.assessment.upsert({
    where: { id: 'fa000000-0000-0000-0000-000000000002' },
    create: {
      id: 'fa000000-0000-0000-0000-000000000002',
      staffId: TR_STAFF.dr2,
      attemptNumber: 2,
      result: AssessmentResult.FAIL,
      status: 'COMPLETED',
      skillScores: { driving: 55, safety: 60 },
      remarks: 'Needs retraining on defensive driving.',
    },
    update: { status: 'COMPLETED' },
  });

  // ── Finance: deployed staff ───────────────────────────────────────────────────
  const financeStaff = [
    { id: FIN_STAFF.maid, code: 'FN-M3-101', series: StaffSeries.MAID,           name: 'Priya Nair',    deposit: 5000, paid: true },
    { id: FIN_STAFF.dr,   code: 'FN-DR-102', series: StaffSeries.DRIVER,         name: 'Ramesh Yadav',  deposit: 8000, paid: false },
    { id: FIN_STAFF.sc,   code: 'FN-SC-103', series: StaffSeries.SKILLED_CARE,   name: 'Lakshmi Iyer',  deposit: 6000, paid: true },
    { id: FIN_STAFF.uc,   code: 'FN-UC-104', series: StaffSeries.UNSKILLED_CARE, name: 'Geeta Sharma',  deposit: 4500, paid: true },
  ];

  for (const s of financeStaff) {
    await prisma.staffApplicant.upsert({
      where: { id: s.id },
      create: {
        id: s.id,
        staffCode: s.code,
        branchId: BRANCH_ID,
        assignedRmId: rmId,
        series: s.series,
        fullName: s.name,
        dateOfBirth: new Date('1990-06-20'),
        mobile: `98${s.code.slice(-8)}`,
        address: 'Delhi NCR',
        pipelineStage: PipelineStage.S5_DEPLOY,
      },
      update: { pipelineStage: PipelineStage.S5_DEPLOY, assignedRmId: rmId },
    });

    await prisma.$executeRaw`
      UPDATE staff_applicants
      SET deposit_amount = ${s.deposit}, deposit_paid = ${s.paid}
      WHERE id = ${s.id}::uuid
    `;
  }

  // Refunded deposit metadata for Lakshmi
  await prisma.$executeRaw`
    UPDATE staff_applicants
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{deposit_event}', '"REFUND"')
    WHERE id = ${FIN_STAFF.sc}::uuid
  `;

  // ── Clients ───────────────────────────────────────────────────────────────────
  const clientRows = [
    { id: CLIENTS.saxena, name: 'Saxena Family',   phone: '9810000001', city: 'South Delhi' },
    { id: CLIENTS.kapoor, name: 'Kapoor Residence', phone: '9810000002', city: 'Gurgaon' },
    { id: CLIENTS.mehta,  name: 'Mehta Household',  phone: '9810000003', city: 'Noida' },
  ];

  for (const c of clientRows) {
    await prisma.clientProfile.upsert({
      where: { id: c.id },
      create: {
        id: c.id,
        fullName: c.name,
        phone: c.phone,
        email: `${c.name.split(' ')[0].toLowerCase()}@example.com`,
        address: c.city,
        city: c.city,
        status: 'ACTIVE',
        kycVerified: true,
      },
      update: { fullName: c.name, status: 'ACTIVE' },
    });
  }

  // ── Placements ────────────────────────────────────────────────────────────────
  const placementRows = [
    { id: PLACEMENTS.maid, staffId: FIN_STAFF.maid, clientId: CLIENTS.saxena, status: PlacementStatus.CONFIRMED, salary: 18000, fee: 4500 },
    { id: PLACEMENTS.dr,   staffId: FIN_STAFF.dr,   clientId: CLIENTS.kapoor, status: PlacementStatus.CONFIRMED, salary: 22000, fee: 5500 },
    { id: PLACEMENTS.sc,   staffId: FIN_STAFF.sc,   clientId: CLIENTS.mehta,  status: PlacementStatus.CONFIRMED, salary: 25000, fee: 6000 },
    { id: PLACEMENTS.uc,   staffId: FIN_STAFF.uc,   clientId: CLIENTS.saxena, status: PlacementStatus.TRIAL,     salary: 16000, fee: 4000 },
  ];

  for (const p of placementRows) {
    await prisma.placement.upsert({
      where: { id: p.id },
      create: {
        id: p.id,
        staffId: p.staffId,
        clientId: p.clientId,
        branchId: BRANCH_ID,
        rmId,
        status: p.status,
        trialStartDate: new Date(now.getTime() - 7 * 86400000),
        trialEndDate: new Date(now.getTime() + 7 * 86400000),
        staffSalary: p.salary,
        managementFee: p.fee,
      },
      update: { status: p.status, staffSalary: p.salary, managementFee: p.fee },
    });
  }

  // ── Shift logs (current month) ────────────────────────────────────────────────
  for (let day = 1; day <= Math.min(now.getDate(), 20); day++) {
    const shiftDate = new Date(year, month - 1, day);
    for (const p of [PLACEMENTS.maid, PLACEMENTS.dr, PLACEMENTS.sc]) {
      const staffId = placementRows.find((r) => r.id === p)!.staffId;
      await prisma.shiftLog.upsert({
        where: { staffId_shiftDate: { staffId, shiftDate } },
        create: {
          staffId,
          placementId: p,
          shiftDate,
          status: 'APPROVED',
          checkInAt: new Date(shiftDate.getTime() + 8 * 3600000),
          checkOutAt: new Date(shiftDate.getTime() + 17 * 3600000),
        },
        update: { status: 'APPROVED', placementId: p },
      });
    }
  }

  // ── Payroll records (current month) ───────────────────────────────────────────
  const payrollRows = [
    { id: 'pr111111-1111-1111-1111-111111111111', placementId: PLACEMENTS.maid, staffId: FIN_STAFF.maid, gross: 18000, net: 16500, disbursed: false },
    { id: 'pr222222-2222-2222-2222-222222222222', placementId: PLACEMENTS.dr,   staffId: FIN_STAFF.dr,   gross: 22000, net: 20100, disbursed: false },
    { id: 'pr333333-3333-3333-3333-333333333333', placementId: PLACEMENTS.sc,   staffId: FIN_STAFF.sc,   gross: 25000, net: 22800, disbursed: true },
  ];

  for (const pr of payrollRows) {
    await prisma.$executeRaw`
      INSERT INTO payroll_records (
        id, placement_id, staff_id, period_month, period_year, shift_days,
        gross_salary, deductions, net_salary,
        esic_employer, esic_employee, pf_employer, pf_employee,
        disbursed_at, disbursement_ref, created_at
      ) VALUES (
        ${pr.id}::uuid, ${pr.placementId}::uuid, ${pr.staffId}::uuid,
        ${month}, ${year}, ${now.getDate()},
        ${pr.gross}, '{}'::jsonb, ${pr.net},
        650, 165, 1800, 1800,
        ${pr.disbursed ? now : null},
        ${pr.disbursed ? 'RZP_demo_disb_001' : null},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        period_month = EXCLUDED.period_month,
        period_year = EXCLUDED.period_year,
        net_salary = EXCLUDED.net_salary,
        disbursed_at = EXCLUDED.disbursed_at
    `;
  }

  // ── Client invoices ───────────────────────────────────────────────────────────
  const invoices = [
    {
      id: 'inv11111-1111-1111-1111-111111111111',
      placementId: PLACEMENTS.maid,
      clientId: CLIENTS.saxena,
      number: `INV-${year}${String(month).padStart(2, '0')}-M3X01`,
      salary: 18000, fee: 4500, gst: 810, total: 23310,
      status: 'PENDING',
      dueOffset: -5,
    },
    {
      id: 'inv22222-2222-2222-2222-222222222222',
      placementId: PLACEMENTS.dr,
      clientId: CLIENTS.kapoor,
      number: `INV-${year}${String(month).padStart(2, '0')}-DR001`,
      salary: 22000, fee: 5500, gst: 990, total: 28490,
      status: 'APPROVED',
      dueOffset: 10,
    },
    {
      id: 'inv33333-3333-3333-3333-333333333333',
      placementId: PLACEMENTS.sc,
      clientId: CLIENTS.mehta,
      number: `INV-${year}${String(month).padStart(2, '0')}-SC001`,
      salary: 25000, fee: 6000, gst: 1080, total: 32080,
      status: 'PAID',
      dueOffset: -30,
      paid: true,
    },
    {
      id: 'inv44444-4444-4444-4444-444444444444',
      placementId: PLACEMENTS.dr,
      clientId: CLIENTS.kapoor,
      number: `INV-${year}${String(month - 1 || 12).padStart(2, '0')}-DR002`,
      salary: 22000, fee: 5500, gst: 990, total: 28490,
      status: 'PENDING',
      dueOffset: -45,
    },
  ];

  for (const inv of invoices) {
    const dueDate = new Date(now.getTime() + inv.dueOffset * 86400000);
    await prisma.invoice.upsert({
      where: { id: inv.id },
      create: {
        id: inv.id,
        placementId: inv.placementId,
        clientId: inv.clientId,
        invoiceNumber: inv.number,
        periodMonth: month,
        periodYear: year,
        staffSalaryComponent: inv.salary,
        managementFee: inv.fee,
        gstAmount: inv.gst,
        totalAmount: inv.total,
        dueDate,
        status: inv.status,
        paidAt: inv.paid ? new Date(now.getTime() - 5 * 86400000) : null,
      },
      update: { status: inv.status, paidAt: inv.paid ? new Date(now.getTime() - 5 * 86400000) : null },
    });
  }

  console.log('[SEED] ✓ Trainer: 4 batches, 6 enrollments, 4 video certs, 2 assessments');
  console.log('[SEED] ✓ Finance: 3 clients, 4 placements, 3 payroll records, 4 invoices');
  console.log(`[SEED] ✓ Period: ${month}/${year}`);
}
