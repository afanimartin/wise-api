#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required. Use your Neon pooled connection string." >&2
  exit 1
fi

npm run db:migrate
