#!/bin/sh
set -e

echo "[render_start] Running pre-migrate checks..."
node scratch/render_pre_migrate.js

echo "[render_start] Applying pending migrations..."
npx prisma migrate deploy

echo "[render_start] Seeding portal users (if needed)..."
node scratch/seed_users_now.js || true

echo "[render_start] Starting API..."
exec node dist/main
