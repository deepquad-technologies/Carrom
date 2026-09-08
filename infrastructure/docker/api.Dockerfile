# Build context is the repository root, so the workspace packages come along.
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY packages/types/package.json packages/types/
COPY packages/config/package.json packages/config/
COPY packages/physics/package.json packages/physics/
COPY packages/game-engine/package.json packages/game-engine/
COPY packages/content/package.json packages/content/
COPY packages/networking/package.json packages/networking/
COPY packages/ui/package.json packages/ui/

RUN npm ci --omit=dev --workspace=@carrom/api --include-workspace-root

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S carrom && adduser -S carrom -G carrom

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY infrastructure/database ./infrastructure/database

# tsx runs the TypeScript sources directly, which keeps the workspace packages
# usable without a separate build step per package.
RUN npm install --no-save tsx@4.19.2 && chown -R carrom:carrom /app

USER carrom
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/api
CMD ["npx", "tsx", "src/index.ts"]
