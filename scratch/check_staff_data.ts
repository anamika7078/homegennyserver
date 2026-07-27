import { AppDataSource } from '../src/database/data-source';
import { StaffApplicant } from '../src/modules/staff/staff.entity';

async function checkData() {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(StaffApplicant);
  try {
    const data = await repo.query('SELECT id, staff_code, series FROM staff_applicants');
    console.log('Current Staff Records:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error fetching data:', e);
  } finally {
    await AppDataSource.destroy();
  }
}

checkData();
