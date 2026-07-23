const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const branchClause = "AND b.branch_id = '00000000-0000-0000-0000-000000000001'::uuid";
  const trainerClause = "";
  try {
      const rows = await prisma.$queryRawUnsafe(`
      SELECT
        b.id, b.batch_code, b.series, b.trainer_name, b.trainer_id, b.classroom,
        b.start_date, b.status, b.branch_id, b.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'id', e.id,
              'staffId', e.staff_id::text,
              'attendance', e.attendance,
              'staffCode', sa.staff_code,
              'fullName', sa.full_name,
              'series', sa.series::text
            ) ORDER BY sa.full_name
          ) FILTER (WHERE e.id IS NOT NULL),
          '[]'::json
        ) AS enrollments
      FROM training_batches b
      LEFT JOIN batch_enrollments e ON e.batch_id = b.id
      LEFT JOIN staff_applicants sa ON sa.id = e.staff_id
      WHERE 1=1 ${branchClause} ${trainerClause}
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `);
    console.log("Rows returned:", rows.length);
  } catch (err) {
    console.error("SQL Error:", err.message);
  }
}
main().finally(() => prisma.$disconnect());
