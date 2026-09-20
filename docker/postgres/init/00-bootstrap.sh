#!/bin/sh
set -eu

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_db="$APP_DB_NAME" \
  --set=app_user="$APP_DB_USER" \
  --set=app_password="$APP_DB_PASSWORD" \
  --set=analytics_user="$ANALYTICS_DB_USER" \
  --set=analytics_password="$ANALYTICS_DB_PASSWORD" \
  --set=metabase_db="$METABASE_DB_NAME" \
  --set=metabase_user="$METABASE_DB_USER" \
  --set=metabase_password="$METABASE_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'analytics_user', :'analytics_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'analytics_user') \gexec

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'metabase_user', :'metabase_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'metabase_user') \gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'app_db', :'app_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'app_db') \gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'metabase_db', :'metabase_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'metabase_db') \gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'app_db', :'analytics_user') \gexec
SQL

