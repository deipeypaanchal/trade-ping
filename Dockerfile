FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
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
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/prisma prisma
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
CMD ["node", "apps/api/dist/main.js"]
