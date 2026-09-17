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
RUN npx @nestjs/cli build

# ─── Stage 3: Development ────────────────────────────────────
FROM node:20-alpine AS development
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
# The npm cache survives between builds, so a retry (or the next rebuild) does
# not download every package again. The retry settings are for the dev VPS:
# under Hostinger's CPU cap one tarball timing out used to fail the whole
# 15-minute install.
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --no-fund \
      --fetch-retries=6 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000
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
COPY --from=builder /app/scratch ./scratch
# Copy prisma schema so `prisma migrate deploy` can run at startup
COPY --from=builder /app/prisma ./prisma
# Re-copy generated Prisma client (already in prod_modules, but needed for schema awareness)
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
# video-cert's local-storage jugaad (see local-video-storage.util.ts) writes to
# <cwd>/local-uploads at runtime as the unprivileged `nestjs` user — everything
# copied above is root-owned, so without this the first mkdirSync fails EACCES.
RUN mkdir -p /app/local-uploads && chown -R nestjs:nodejs /app/local-uploads
USER nestjs
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD wget -qO- http://localhost:3001/api/v1/health || exit 1
# Resolve failed migrations, deploy pending, then start
CMD ["sh", "scratch/render_start.sh"]
