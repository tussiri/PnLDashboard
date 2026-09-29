#!/bin/sh
# Copy the local dashboard database to the Render database (docs/deploy-render.md, step 2).
#
#   ./scripts/restore-to-render.sh
#
# 1. Dumps the local `facilities` database fresh from the running compose stack.
# 2. Asks for the Render database's External Database URL (typed input is hidden, never stored).
# 3. Replaces the Render database's contents with the dump, then prints row counts to confirm.
#
# Before running: Render > crane-ifs-db > Networking, add your IP. Afterwards, remove it.
# The restore replaces everything, including users: create the administrator again afterwards.
set -eu

LOCAL_DB_CONTAINER=${LOCAL_DB_CONTAINER:-facilities-command-center-postgres-1}
DUMP_DIR=${DUMP_DIR:-$HOME/CraneIFS-render}
DUMP=facilities.dump
IMAGE=postgres:16-alpine

mkdir -p "$DUMP_DIR"
echo "Dumping the local database from $LOCAL_DB_CONTAINER"
docker exec "$LOCAL_DB_CONTAINER" pg_dump -U postgres -d facilities -Fc --no-owner --no-privileges -f /tmp/$DUMP
docker cp "$LOCAL_DB_CONTAINER:/tmp/$DUMP" "$DUMP_DIR/$DUMP"
docker exec "$LOCAL_DB_CONTAINER" rm -f /tmp/$DUMP
echo "Dump: $DUMP_DIR/$DUMP ($(du -h "$DUMP_DIR/$DUMP" | cut -f1))"

printf "Paste the External Database URL (Render > crane-ifs-db > Connect), then Enter: "
stty -echo 2>/dev/null || true
read -r RENDER_URL
stty echo 2>/dev/null || true
echo
# The URL is passed to the containers through the environment, never on a command line.
case "${SKIP_URL_CHECK:-}$RENDER_URL" in
  postgres://*render.com*|postgresql://*render.com*|1*) ;;
  *) echo "That does not look like a Render external database URL (postgresql://...render.com/...)." >&2; exit 1 ;;
esac

echo "Restoring into Render (replaces the existing contents; takes a minute or two)"
# pg_restore reports harmless notices for objects the first deploy created; --exit-on-error is off
# on purpose so those do not stop the load. The row counts below are the real check.
PGURL=$RENDER_URL docker run --rm -e PGURL -v "$DUMP_DIR:/dump:ro" $IMAGE \
  sh -c 'pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$PGURL" /dump/'"$DUMP"' 2>&1 | grep -v "does not exist, skipping" | tail -20' || true

echo "Checking the result"
PGURL=$RENDER_URL docker run --rm -e PGURL $IMAGE sh -c 'psql "$PGURL" -At -c "
  SELECT '"'"'leadership weeks: '"'"' || count(*) FROM mart.leadership_week
  UNION ALL SELECT '"'"'job-month rows: '"'"' || count(*) FROM mart.job_month
  UNION ALL SELECT '"'"'accounts: '"'"' || count(*) FROM ops.account
  UNION ALL SELECT '"'"'latest migration: '"'"' || max(version) FROM public.schema_migrations"'
unset RENDER_URL
echo "Done. Remove your IP from crane-ifs-db > Networking, reload the site, and create the administrator."
