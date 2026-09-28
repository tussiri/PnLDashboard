from __future__ import annotations

import hashlib
import logging
import os
import time
from pathlib import Path

import psycopg
from psycopg import sql

from .db import connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("migrations")


# A freshly provisioned managed database (a Render blueprint's first apply) can refuse connections
# for a few minutes after the deploy that needs it has started. Wait for it instead of failing.
WAIT_SECONDS = int(os.getenv("MIGRATE_WAIT_SECONDS", "300"))


def wait_for_database(deadline_seconds: int = WAIT_SECONDS, interval: float = 5.0) -> None:
    deadline = time.monotonic() + deadline_seconds
    while True:
        try:
            with connection() as conn, conn.cursor() as cursor:
                cursor.execute("SELECT 1")
            return
        except psycopg.OperationalError as exc:
            if time.monotonic() + interval > deadline:
                raise
            logger.info("Database not accepting connections yet (%s); retrying in %.0fs", str(exc).splitlines()[0], interval)
            time.sleep(interval)


def run() -> None:
    migrations = Path(__file__).resolve().parent.parent / "database" / "migrations"
    wait_for_database()
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS public.schema_migrations (
              version text PRIMARY KEY,
              checksum text NOT NULL,
              applied_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        for path in sorted(migrations.glob("*.sql")):
            body = path.read_text(encoding="utf-8")
            checksum = hashlib.sha256(body.encode()).hexdigest()
            cursor.execute("SELECT checksum FROM public.schema_migrations WHERE version = %s", (path.name,))
            existing = cursor.fetchone()
            if existing:
                if existing["checksum"] != checksum:
                    raise RuntimeError(f"Applied migration was modified: {path.name}")
                continue
            logger.info("Applying %s", path.name)
            cursor.execute(body)
            cursor.execute(
                "INSERT INTO public.schema_migrations (version, checksum) VALUES (%s, %s)",
                (path.name, checksum),
            )
        # The read-only analytics role (Metabase) exists where docker/postgres/init created it. A managed
        # database (Render) has only the app user, so the grants are skipped there rather than failing.
        analytics_role = os.getenv("ANALYTICS_DB_USER", "facilities_analytics")
        cursor.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (analytics_role,))
        if cursor.fetchone():
            cursor.execute(
                sql.SQL("GRANT USAGE ON SCHEMA core, mart TO {}").format(sql.Identifier(analytics_role))
            )
            cursor.execute(
                sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA core, mart TO {}").format(sql.Identifier(analytics_role))
            )
            cursor.execute(
                sql.SQL("ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT ON TABLES TO {}").format(
                    sql.Identifier(analytics_role)
                )
            )
            cursor.execute(
                sql.SQL("ALTER DEFAULT PRIVILEGES IN SCHEMA mart GRANT SELECT ON TABLES TO {}").format(
                    sql.Identifier(analytics_role)
                )
            )
        else:
            logger.info("Role %s does not exist; analytics grants skipped", analytics_role)
        conn.commit()
    logger.info("Database migrations are current")


if __name__ == "__main__":
    run()
