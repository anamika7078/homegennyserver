const { DataSource } = require('typeorm');
const { Assessment } = require('./src/modules/assessments/entities/assessment.entity');
const { AssessmentAuditLog } = require('./src/modules/assessments/entities/assessment-audit-log.entity');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

async function run() {
  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities: [Assessment, AssessmentAuditLog],
    synchronize: false,
  });
  await dataSource.initialize();
  const prisma = new PrismaClient();

  try {
    const applicant = await prisma.staffApplicant.findFirst({ where: { staffCode: 'ST-DR-001' } });
    if (!applicant) throw new Error('Applicant not found');

    const data = {
      candidate_id: applicant.id,
      assessment_type: 'DRIVER',
      series: 'DR',
      attempt_number: 1,
      assessor_id: '00000000-0000-0000-0000-000000000000',
      status: 'PENDING',
      remarks: 'test',
    };

    const repo = dataSource.getRepository(Assessment);
    const assessment = repo.create(data);
    const saved = await repo.save(assessment);
    console.log('SAVED ASSESSMENT:', saved);

    const auditRepo = dataSource.getRepository(AssessmentAuditLog);
    await auditRepo.save({
      assessment_id: saved.id,
      actor_id: data.assessor_id,
      action: 'CREATED',
      payload: data,
    });
    console.log('SAVED AUDIT LOG');
  } catch (err) {
    console.error('ERROR OCCURRED:', err);
  } finally {
    await dataSource.destroy();
    await prisma.$disconnect();
  }
}
run();
