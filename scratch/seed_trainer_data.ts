import { PrismaClient, StaffSeries, PipelineStage, AssessmentResult } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

const BRANCH_ID = '00000000-0000-0000-0000-000000000001';

async function main() {
  console.log('[SEED] Seeding Trainer operational data...');

  // Ensure branch exists
  await prisma.branch.upsert({
    where: { id: BRANCH_ID },
    create: {
      id: BRANCH_ID,
      name: 'HomeGenny Delhi NCR HQ',
      city: 'New Delhi',
      state: 'Delhi',
      email: 'delhi@homegenny.com',
    },
    update: {},
  });

  // 1. Create Staff Applicants
  const staff1Id = '11111111-1111-1111-1111-111111111111';
  const staff2Id = '22222222-2222-2222-2222-222222222222';
  const staff3Id = '33333333-3333-3333-3333-333333333333';

  await prisma.staffApplicant.upsert({
    where: { id: staff1Id },
    create: {
      id: staff1Id,
      staffCode: 'ST-DR-001',
      branchId: BRANCH_ID,
      series: StaffSeries.DRIVER,
      fullName: 'Amit Sharma',
      dateOfBirth: new Date('1995-05-15'),
      mobile: '9111111111',
      address: 'Delhi NCR',
      pipelineStage: PipelineStage.S3_TRAIN,
    },
    update: { pipelineStage: PipelineStage.S3_TRAIN },
  });

  await prisma.staffApplicant.upsert({
    where: { id: staff2Id },
    create: {
      id: staff2Id,
      staffCode: 'ST-SC-002',
      branchId: BRANCH_ID,
      series: StaffSeries.SKILLED_CARE,
      fullName: 'Sunita Kumar',
      dateOfBirth: new Date('1996-08-20'),
      mobile: '9222222222',
      address: 'Noida Sector 62',
      pipelineStage: PipelineStage.S3_TRAIN,
    },
    update: { pipelineStage: PipelineStage.S3_TRAIN },
  });

  await prisma.staffApplicant.upsert({
    where: { id: staff3Id },
    create: {
      id: staff3Id,
      staffCode: 'ST-UC-003',
      branchId: BRANCH_ID,
      series: StaffSeries.UNSKILLED_CARE,
      fullName: 'Rahul Verma',
      dateOfBirth: new Date('1997-12-10'),
      mobile: '9333333333',
      address: 'Gurugram Phase 3',
      pipelineStage: PipelineStage.S3_TRAIN,
    },
    update: { pipelineStage: PipelineStage.S3_TRAIN },
  });

  // 2. Create Training Batches
  const batchActiveId = 'b0000000-0000-0000-0000-000000000001';
  const batchUpcomingId = 'b0000000-0000-0000-0000-000000000002';
  const batchCompletedId = 'b0000000-0000-0000-0000-000000000003';

  await prisma.trainingBatch.upsert({
    where: { id: batchActiveId },
    create: {
      id: batchActiveId,
      batchCode: 'BT-DR-MAY26',
      series: 'DR',
      trainerName: 'Sunita Trainer',
      classroom: 'Classroom A',
      startDate: new Date(),
      status: 'ACTIVE',
      branchId: BRANCH_ID,
    },
    update: { status: 'ACTIVE' },
  });

  await prisma.trainingBatch.upsert({
    where: { id: batchUpcomingId },
    create: {
      id: batchUpcomingId,
      batchCode: 'BT-SC-JUN01',
      series: 'SC',
      trainerName: 'Sunita Trainer',
      classroom: 'Classroom B',
      startDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // 5 days from now
      status: 'UPCOMING',
      branchId: BRANCH_ID,
    },
    update: { status: 'UPCOMING' },
  });

  await prisma.trainingBatch.upsert({
    where: { id: batchCompletedId },
    create: {
      id: batchCompletedId,
      batchCode: 'BT-UC-MAY10',
      series: 'UC',
      trainerName: 'Sunita Trainer',
      classroom: 'Classroom C',
      startDate: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), // 15 days ago
      status: 'COMPLETED',
      branchId: BRANCH_ID,
    },
    update: { status: 'COMPLETED' },
  });

  // 3. Create Enrollments
  await prisma.batchEnrollment.upsert({
    where: { batchId_staffId: { batchId: batchActiveId, staffId: staff1Id } },
    create: {
      batchId: batchActiveId,
      staffId: staff1Id,
      attendance: [1, 2], // Days attended
    },
    update: {},
  });

  await prisma.batchEnrollment.upsert({
    where: { batchId_staffId: { batchId: batchUpcomingId, staffId: staff2Id } },
    create: {
      batchId: batchUpcomingId,
      staffId: staff2Id,
      attendance: [],
    },
    update: {},
  });

  await prisma.batchEnrollment.upsert({
    where: { batchId_staffId: { batchId: batchCompletedId, staffId: staff3Id } },
    create: {
      batchId: batchCompletedId,
      staffId: staff3Id,
      attendance: [1, 2, 3, 4, 5],
    },
    update: {},
  });

  // 4. Create Video Certification pending review for Trainee 2
  const videoId = 'ea000000-0000-0000-0000-000000000001';
  await prisma.videoCertification.upsert({
    where: { id: videoId },
    create: {
      id: videoId,
      staffId: staff2Id,
      promptKey: 'patient_transfer_sc_01',
      videoUrl: 'https://homegenny-videos.s3.ap-south-1.amazonaws.com/test_transfer.mp4',
      sha256Hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      attemptNumber: 1,
      reviewStatus: 'PENDING',
    },
    update: { reviewStatus: 'PENDING' },
  });

  // 5. Create Assessment for Trainee 3
  const assessmentId = 'fa000000-0000-0000-0000-000000000001';
  await prisma.assessment.upsert({
    where: { id: assessmentId },
    create: {
      id: assessmentId,
      staffId: staff3Id,
      attemptNumber: 1,
      result: AssessmentResult.PASS,
      status: 'COMPLETED',
      skillScores: { communication: 85, technical: 90, empathy: 95 },
      remarks: 'Excellent practical skills displayed during trial sessions.',
    },
    update: { status: 'COMPLETED' },
  });

  console.log('[SEED] Operational data seeded successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
