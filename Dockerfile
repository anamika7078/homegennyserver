# ─── Stage 1: Dependencies ────────────────────────────────────
FROM node:20-alpine AS deps
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --only=production && npx prisma generate && cp -r node_modules /tmp/prod_modules
RUN npm ci && npx prisma generate

# ─── Stage 2: Build ──────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ─── Stage 3: Development ────────────────────────────────────
FROM node:20-alpine AS development
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3001
CMD ["npm", "run", "start:dev"]

# ─── Stage 4: Production ─────────────────────────────────────
FROM node:20-alpine AS production
RUN apk add --no-cache openssl
RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001
WORKDIR /app
COPY --from=deps /tmp/prod_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
# Copy prisma schema so `prisma migrate deploy` can run at startup
COPY --from=builder /app/prisma ./prisma
# Re-copy generated Prisma client (already in prod_modules, but needed for schema awareness)
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
USER nestjs
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD wget -qO- http://localhost:3001/api/v1/health || exit 1
# Fix any failed migrations first, then run pending migrations, then start the app
CMD ["sh", "-c", "npx prisma migrate resolve --rolled-back 20260518000000_enterprise_extensions; npx prisma migrate deploy && node dist/main"]
