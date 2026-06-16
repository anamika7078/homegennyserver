const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
let schema = fs.readFileSync(schemaPath, 'utf8');

const financeModels = `
// ── Finance New Models ─────────────────────────────────────────────────────────

model PayrollBatch {
  id            String    @id @default(uuid()) @db.Uuid
  batchNumber   String    @unique @map("batch_number") @db.VarChar(50)
  month         Int
  year          Int
  status        String    @default("DRAFT") @db.VarChar(20) // DRAFT, PENDING_APPROVAL, APPROVED, PROCESSING, COMPLETED, FAILED
  totalGross    Decimal   @default(0) @map("total_gross") @db.Decimal(12, 2)
  totalNet      Decimal   @default(0) @map("total_net") @db.Decimal(12, 2)
  totalEsic     Decimal   @default(0) @map("total_esic") @db.Decimal(12, 2)
  totalPf       Decimal   @default(0) @map("total_pf") @db.Decimal(12, 2)
  createdBy     String?   @map("created_by") @db.Uuid
  approvedBy    String?   @map("approved_by") @db.Uuid
  approvedAt    DateTime? @map("approved_at") @db.Timestamptz(6)
  processedAt   DateTime? @map("processed_at") @db.Timestamptz(6)
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  entries       PayrollEntry[]
  
  @@map("payroll_batches")
}

model PayrollEntry {
  id              String    @id @default(uuid()) @db.Uuid
  batchId         String    @map("batch_id") @db.Uuid
  batch           PayrollBatch @relation(fields: [batchId], references: [id])
  staffId         String    @map("staff_id") @db.Uuid
  staff           StaffApplicant @relation(fields: [staffId], references: [id])
  branchId        String?   @map("branch_id") @db.Uuid
  shiftDays       Int       @default(0) @map("shift_days")
  grossSalary     Decimal   @default(0) @map("gross_salary") @db.Decimal(10, 2)
  esicEmployee    Decimal   @default(0) @map("esic_employee") @db.Decimal(10, 2)
  esicEmployer    Decimal   @default(0) @map("esic_employer") @db.Decimal(10, 2)
  pfEmployee      Decimal   @default(0) @map("pf_employee") @db.Decimal(10, 2)
  pfEmployer      Decimal   @default(0) @map("pf_employer") @db.Decimal(10, 2)
  netSalary       Decimal   @default(0) @map("net_salary") @db.Decimal(10, 2)
  status          String    @default("PENDING") @db.VarChar(20) // PENDING, PROCESSING, PAID, FAILED
  razorpayPayoutId String?  @map("razorpay_payout_id") @db.VarChar(100)
  razorpayStatus  String?   @map("razorpay_status") @db.VarChar(50)
  paymentDate     DateTime? @map("payment_date") @db.Timestamptz(6)
  metadata        Json      @default("{}")
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  payslip         PayrollPayslip?

  @@map("payroll_entries")
}

model PayrollPayslip {
  id            String    @id @default(uuid()) @db.Uuid
  entryId       String    @unique @map("entry_id") @db.Uuid
  entry         PayrollEntry @relation(fields: [entryId], references: [id])
  payslipUrl    String?   @map("payslip_url")
  generatedAt   DateTime  @default(now()) @map("generated_at") @db.Timestamptz(6)
  metadata      Json      @default("{}")

  @@map("payroll_payslips")
}

model InvoiceItem {
  id            String    @id @default(uuid()) @db.Uuid
  invoiceId     String    @map("invoice_id") @db.Uuid
  invoice       Invoice   @relation(fields: [invoiceId], references: [id])
  description   String
  amount        Decimal   @db.Decimal(10, 2)
  isTaxable     Boolean   @default(false) @map("is_taxable")
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  @@map("invoice_items")
}

model InvoicePayment {
  id            String    @id @default(uuid()) @db.Uuid
  invoiceId     String    @map("invoice_id") @db.Uuid
  invoice       Invoice   @relation(fields: [invoiceId], references: [id])
  amount        Decimal   @db.Decimal(10, 2)
  paymentDate   DateTime  @default(now()) @map("payment_date") @db.Timestamptz(6)
  paymentMethod String    @map("payment_method") @db.VarChar(50)
  transactionId String?   @map("transaction_id") @db.VarChar(100)
  status        String    @default("SUCCESS") @db.VarChar(20) // PENDING, SUCCESS, FAILED
  metadata      Json      @default("{}")
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  @@map("invoice_payments")
}

model RazorpayTransaction {
  id            String    @id @default(uuid()) @db.Uuid
  transactionId String    @unique @map("transaction_id") @db.VarChar(100)
  type          String    @db.VarChar(50) // PAYMENT, PAYOUT, REFUND
  amount        Decimal   @db.Decimal(12, 2)
  currency      String    @default("INR") @db.VarChar(10)
  status        String    @db.VarChar(50)
  referenceId   String?   @map("reference_id") @db.VarChar(100) // Invoice ID, Entry ID, etc.
  event         String?   @db.VarChar(100) // Webhook event
  payload       Json      @default("{}")
  reconciled    Boolean   @default(false)
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@map("razorpay_transactions")
}

model SalaryLedger {
  id            String    @id @default(uuid()) @db.Uuid
  staffId       String    @map("staff_id") @db.Uuid
  staff         StaffApplicant @relation(fields: [staffId], references: [id])
  date          DateTime  @db.Date
  shiftId       String?   @map("shift_id") @db.Uuid
  amount        Decimal   @db.Decimal(10, 2)
  type          String    @default("CREDIT") @db.VarChar(20) // CREDIT, DEBIT
  description   String?
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  @@map("salary_ledgers")
}

model EsicReport {
  id            String    @id @default(uuid()) @db.Uuid
  month         Int
  year          Int
  totalEmployees Int      @default(0) @map("total_employees")
  totalWages    Decimal   @default(0) @map("total_wages") @db.Decimal(12, 2)
  totalEmployeeContribution Decimal @default(0) @map("total_employee_contribution") @db.Decimal(12, 2)
  totalEmployerContribution Decimal @default(0) @map("total_employer_contribution") @db.Decimal(12, 2)
  status        String    @default("DRAFT") @db.VarChar(20) // DRAFT, GENERATED, FILED
  fileUrl       String?   @map("file_url")
  generatedAt   DateTime? @map("generated_at") @db.Timestamptz(6)
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@unique([month, year])
  @@map("esic_reports")
}

model PfReport {
  id            String    @id @default(uuid()) @db.Uuid
  month         Int
  year          Int
  totalEmployees Int      @default(0) @map("total_employees")
  totalWages    Decimal   @default(0) @map("total_wages") @db.Decimal(12, 2)
  totalEmployeeContribution Decimal @default(0) @map("total_employee_contribution") @db.Decimal(12, 2)
  totalEmployerContribution Decimal @default(0) @map("total_employer_contribution") @db.Decimal(12, 2)
  status        String    @default("DRAFT") @db.VarChar(20) // DRAFT, GENERATED, FILED
  ecrFileUrl    String?   @map("ecr_file_url")
  generatedAt   DateTime? @map("generated_at") @db.Timestamptz(6)
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@unique([month, year])
  @@map("pf_reports")
}

model BranchFinancialReport {
  id            String    @id @default(uuid()) @db.Uuid
  branchId      String    @map("branch_id") @db.Uuid
  branch        Branch    @relation(fields: [branchId], references: [id])
  month         Int
  year          Int
  totalRevenue  Decimal   @default(0) @map("total_revenue") @db.Decimal(12, 2)
  totalPayroll  Decimal   @default(0) @map("total_payroll") @db.Decimal(12, 2)
  totalGst      Decimal   @default(0) @map("total_gst") @db.Decimal(12, 2)
  profitMargin  Decimal   @default(0) @map("profit_margin") @db.Decimal(5, 2)
  metadata      Json      @default("{}")
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  @@unique([branchId, month, year])
  @@map("branch_financial_reports")
}

model PaymentReminder {
  id            String    @id @default(uuid()) @db.Uuid
  invoiceId     String    @map("invoice_id") @db.Uuid
  invoice       Invoice   @relation(fields: [invoiceId], references: [id])
  type          String    @db.VarChar(50) // DAY_1, DAY_3, DAY_7, ESCALATION
  sentAt        DateTime  @default(now()) @map("sent_at") @db.Timestamptz(6)
  status        String    @default("SENT") @db.VarChar(20)
  channel       String    @db.VarChar(20) // WHATSAPP, EMAIL
  metadata      Json      @default("{}")

  @@map("payment_reminders")
}
`;

if (!schema.includes('PayrollBatch')) {
  schema += financeModels;
  fs.writeFileSync(schemaPath, schema);
  console.log('Finance models added to schema.prisma');
} else {
  console.log('Finance models already exist');
}
