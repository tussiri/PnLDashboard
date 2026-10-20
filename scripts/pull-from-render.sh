#!/bin/sh
# Copy the production (Render) dashboard database into the local compose stack, for testing a branch
# against current data. The reverse of scripts/restore-to-render.sh.
#
#   ./scripts/pull-from-render.sh
#
# 1. Asks for the Render database's External Database URL (typed input is hidden, never stored).
# 2. Dumps production with pg_dump, which only reads: nothing on Render changes.
# 3. Backs up the local `facilities` database to a file first, so the pull can be undone.
# 4. Stops the local api and worker, replaces the local database with the production dump (objects owned
#    by the app user), then runs the local migrations, so the branch's new migrations apply on top
#    and the Metabase grants come back. Starts the api and worker again.
#
# Before running: Render > crane-ifs-db > Networking, add your IP. Afterwards, remove it.
# The copy includes production users and employee data: it stays on this Mac in $DUMP_DIR.
# Local sign-in still works with the dev accounts (dev mode). The local worker keeps syncing WinTeam.
#
# Undo: LOCAL_RESTORE=<backup file> ./scripts/pull-from-render.sh  (restores a local backup, no Render access)
set -eu

LOCAL_DB_CONTAINER=${LOCAL_DB_CONTAINER:-facilities-command-center-postgres-1}
APP_USER=${APP_USER:-facilities_app}
DUMP_DIR=${DUMP_DIR:-$HOME/CraneIFS-render}
IMAGE=postgres:16-alpine
STAMP=$(date +%Y%m%d-%H%M%S)
COMPOSE="docker compose -f compose.yaml"

cd "$(dirname "$0")/.."
mkdir -p "$DUMP_DIR"
chmod 700 "$DUMP_DIR"

if [ -n "${LOCAL_RESTORE:-}" ]; then
  SOURCE=$LOCAL_RESTORE
  [ -f "$SOURCE" ] || { echo "No such backup: $SOURCE" >&2; exit 1; }
else
  printf "Paste the External Database URL (Render > crane-ifs-db > Connect), then Enter: "
  stty -echo 2>/dev/null || true
  read -r RENDER_URL
  stty echo 2>/dev/null || true
  echo
  case "${SKIP_URL_CHECK:-}$RENDER_URL" in
    postgres://*render.com*|postgresql://*render.com*|1*) ;;
    *) echo "That does not look like a Render external database URL (postgresql://...render.com/...)." >&2; exit 1 ;;
  esac
  SOURCE="$DUMP_DIR/production-$STAMP.dump"
  echo "Dumping production (read-only)"
  # The URL reaches the container through the environment, never on a command line.
  PGURL=$RENDER_URL docker run --rm -e PGURL -v "$DUMP_DIR:/dump" $IMAGE \
    sh -c 'pg_dump --dbname "$PGURL" -Fc --no-owner --no-privileges -f /dump/'"$(basename "$SOURCE")"
  unset RENDER_URL
  echo "Production dump: $SOURCE ($(du -h "$SOURCE" | cut -f1))"
fi

BACKUP="$DUMP_DIR/local-before-pull-$STAMP.dump"
echo "Backing up the local database to $BACKUP"
docker exec "$LOCAL_DB_CONTAINER" pg_dump -U postgres -d facilities -Fc --no-owner --no-privileges -f /tmp/local-backup.dump
docker cp "$LOCAL_DB_CONTAINER:/tmp/local-backup.dump" "$BACKUP"
docker exec "$LOCAL_DB_CONTAINER" rm -f /tmp/local-backup.dump

echo "Stopping the local api and worker"
$COMPOSE stop api worker

echo "Replacing the local database (a minute or two)"
docker cp "$SOURCE" "$LOCAL_DB_CONTAINER:/tmp/pull.dump"
# Harmless notices for objects that do not exist are filtered; the row counts below are the real check.
docker exec "$LOCAL_DB_CONTAINER" sh -c "pg_restore -U postgres -d facilities --clean --if-exists --no-owner --no-privileges --role=$APP_USER /tmp/pull.dump 2>&1 | grep -v 'does not exist, skipping' | tail -20" || true
docker exec "$LOCAL_DB_CONTAINER" rm -f /tmp/pull.dump

echo "Applying this branch's migrations and starting the api and worker"
$COMPOSE up -d --build migrate api worker

docker exec "$LOCAL_DB_CONTAINER" psql -U postgres -d facilities -At -c "
  SELECT 'leadership weeks: ' || count(*) || ', latest ' || max(week_start) FROM mart.leadership_week
  UNION ALL SELECT 'latest job cost month: ' || max(month) FROM mart.v_job_cost_month_effective WHERE revenue > 0
  UNION ALL SELECT 'latest import: ' || max(loaded_at) FROM ops.import_file
  UNION ALL SELECT 'latest migration: ' || max(version) FROM public.schema_migrations"
echo "Done. Undo with: LOCAL_RESTORE=$BACKUP ./scripts/pull-from-render.sh"
[ -n "${LOCAL_RESTORE:-}" ] || echo "Remove your IP from crane-ifs-db > Networking."
