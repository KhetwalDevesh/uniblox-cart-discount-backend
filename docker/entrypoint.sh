#!/bin/sh
# Container start-up: apply migrations, optionally seed an empty database, then run the API.
set -e

bunx prisma migrate deploy

if [ "$SEED_ON_START" = "true" ]; then
  bun src/db/seed.ts --if-empty
fi

exec bun src/index.ts
