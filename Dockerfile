# Keep in step with the Bun used locally: the lockfile format differs between versions.
ARG BUN_VERSION=1.4.0
FROM oven/bun:${BUN_VERSION} AS base
WORKDIR /app

# Dependencies. Scripts are skipped so the husky `prepare` hook does not run in the image build.
# Dev dependencies are kept: the prisma CLI is needed at start-up to apply migrations.
FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# Generate the Prisma client
FROM base AS build
COPY --from=install /app/node_modules node_modules
COPY . .
RUN bunx prisma generate

# Runtime image
FROM base AS release
# Owned by the unprivileged user: the prisma CLI writes to node_modules when applying migrations.
COPY --chown=bun:bun --from=install /app/node_modules node_modules
COPY --chown=bun:bun --from=build /app/node_modules/.prisma node_modules/.prisma
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY docker/entrypoint.sh ./docker/entrypoint.sh

USER bun
EXPOSE 4000
ENTRYPOINT ["sh", "docker/entrypoint.sh"]
