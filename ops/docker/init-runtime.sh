#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv runtime_password POSTGRES_RUNTIME_PASSWORD
SELECT format('CREATE ROLE salon_runtime LOGIN PASSWORD %L', :'runtime_password') \gexec
GRANT CONNECT ON DATABASE salon TO salon_runtime;
SQL
