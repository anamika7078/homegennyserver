-- Run once as the PostgreSQL superuser (e.g. postgres):
--   psql -U postgres -f scripts/setup-local-postgres.sql
--
-- Matches docker-compose.yml (hguser / hgpass / homegenny).

CREATE USER hguser WITH PASSWORD 'hgpass' CREATEDB;

CREATE DATABASE homegenny OWNER hguser;

GRANT ALL PRIVILEGES ON DATABASE homegenny TO hguser;
