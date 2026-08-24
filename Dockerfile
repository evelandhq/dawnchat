FROM node:24-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /app

FROM base AS deps
# Override when registry.npmjs.org is slow from the deploy box,
# e.g. NPM_REGISTRY=https://registry.npmmirror.com/
ARG NPM_REGISTRY=https://registry.npmjs.org/
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm config set registry "$NPM_REGISTRY" && \
    pnpm config set fetch-timeout 600000 && \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_EVELAND_IDENTITY_URL=http://localhost:4000
ARG NEXT_PUBLIC_EVELAND_IDENTITY_RETURN_TARGET=eve-chats
# Server-side base for the /identity rewrite and for the Agent Catalog the
# Catalog route re-reads; set it when the server cannot reach the public
# identity host (hairpin routing). Empty falls back to the public URL.
ARG EVELAND_IDENTITY_URL=
ENV NEXT_PUBLIC_EVELAND_IDENTITY_URL=$NEXT_PUBLIC_EVELAND_IDENTITY_URL \
    NEXT_PUBLIC_EVELAND_IDENTITY_RETURN_TARGET=$NEXT_PUBLIC_EVELAND_IDENTITY_RETURN_TARGET \
    EVELAND_IDENTITY_URL=$EVELAND_IDENTITY_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# One-shot migration image: drizzle-kit reads drizzle.config.ts and applies
# the SQL files in src/db/migrations against DATABASE_URL.
FROM deps AS migrate
COPY drizzle.config.ts ./
COPY src/db ./src/db
CMD ["pnpm", "db:migrate"]

FROM node:24-alpine AS runner
WORKDIR /app
# The rewrite consumes this at build time, the Catalog route at request time.
ARG EVELAND_IDENTITY_URL=
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3010 \
    EVELAND_IDENTITY_URL=$EVELAND_IDENTITY_URL
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3010
CMD ["node", "server.js"]
