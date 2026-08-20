FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

# One-off image target for migrations. It contains Prisma CLI/build tooling and
# must never be used as the long-running API image.
FROM build AS migration
CMD ["corepack", "pnpm", "db:deploy"]

FROM build AS production-deps
# Create an isolated runtime tree. In particular, do not ship Prisma's CLI and
# config parser (or any other dev-only build tooling) in the API container.
RUN pnpm --filter @tradeping/api deploy --prod /prod/api
# `pnpm deploy` lays out a fresh production dependency tree after the workspace
# build, so copy the generated Prisma client over its uninitialized postinstall
# stub. Keep the CLI itself in the build/migration stages only.
RUN set -eu; \
    generated_prisma_client="$(find /app/node_modules/.pnpm -path '*/node_modules/.prisma/client' -type d -print -quit)"; \
    runtime_prisma_client="$(find /prod/api/node_modules/.pnpm -path '*/node_modules/.prisma/client' -type d -print -quit)"; \
    test -n "$generated_prisma_client"; \
    test -n "$runtime_prisma_client"; \
    cp -a "$generated_prisma_client/." "$runtime_prisma_client/"

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl tini && rm -rf /var/lib/apt/lists/*
# Run as an unprivileged user. node:20-bookworm-slim already ships with
# a `node` user (uid 1000); reuse it rather than creating a duplicate.
COPY --from=production-deps --chown=node:node /prod/api/package.json ./package.json
COPY --from=production-deps --chown=node:node /prod/api/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
# Catch an ungenerated Prisma client during the image build instead of after a
# deployment begins crash-looping. Construction does not contact this dummy DB.
RUN DATABASE_URL=postgresql://image-check:image-check@127.0.0.1:5432/tradeping \
    node -e 'const { PrismaClient } = require("@prisma/client"); const client = new PrismaClient(); void client.$disconnect();'
USER node
# tini reaps zombies and forwards SIGTERM cleanly so our graceful shutdown
# hook in main.ts actually fires on `docker stop` / Kubernetes preStop.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
