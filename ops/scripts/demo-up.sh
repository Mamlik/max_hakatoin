#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
docker info >/dev/null
docker compose version
if [ ! -f .env ]; then cp .env.example .env; fi
if grep -Eq '^(MAX_MODE=real|APP_ENV=(production|staging))' .env; then echo 'Use the production instructions with real MAX.' >&2; exit 1; fi
docker compose --profile demo up --build -d
docker compose wait migrate seed
echo 'Open http://localhost:8080 and choose a demo role. Stop: docker compose down'
