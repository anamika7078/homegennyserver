const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://homegenny_user:root@localhost:5432/homegenny' });
client.connect().then(async () => {
  const employeeId = 'a482b2bd-b486-4736-aba1-5404cf38880d'; // anamika
  const month = 7;
  const year = 2026;

  try {
    const res = await client.query(
      `INSERT INTO employee_payrolls
         (employee_id, period_month, period_year, present_days,
          gross_salary, deductions, net_salary)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        employeeId,
        month,
        year,
        1,
        580.65,
        JSON.stringify({ esic: 4.35, pf: 69.68 }),
        506.62,
      ],
    );
    console.log('Successfully inserted employee_payroll:', res.rows[0]);
    await client.query('DELETE FROM employee_payrolls WHERE id = $1', [res.rows[0].id]);
    console.log('Cleaned up test record.');
  } catch (e) {
    console.error('INSERT ERROR:', e);
  }

  client.end();
}).catch(err => { console.error(err); client.end(); });
