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

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl tini && rm -rf /var/lib/apt/lists/*
RUN corepack enable
# Run as an unprivileged user. node:20-bookworm-slim already ships with
# a `node` user (uid 1000); reuse it rather than creating a duplicate.
COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/apps/api/package.json apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
COPY --from=build --chown=node:node /app/prisma prisma
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/apps/api/node_modules apps/api/node_modules
USER node
# tini reaps zombies and forwards SIGTERM cleanly so our graceful shutdown
# hook in main.ts actually fires on `docker stop` / Kubernetes preStop.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
