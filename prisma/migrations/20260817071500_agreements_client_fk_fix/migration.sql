-- Same identity-mismatch bug fixed earlier this session for SOW/Indemnity/Incidents:
-- agreements.client_id was FK'd to `clients` (ClientProfile) instead of
-- `finance_customers` (FinanceCustomer) — the only table real CLIENT logins and
-- placements.client_id/sow.client_id actually resolve through. Any real
-- FinanceCustomer id passed to POST /agreements would FK-violate on insert.
-- Confirmed zero rows in `agreements` on both local and production before this
-- ran, so there's no legacy data to migrate/lose.
ALTER TABLE agreements DROP CONSTRAINT IF EXISTS agreements_client_id_fkey;
ALTER TABLE agreements ADD CONSTRAINT agreements_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES finance_customers(id) ON UPDATE CASCADE ON DELETE RESTRICT;
