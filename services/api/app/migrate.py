from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path

from psycopg import sql

from .db import connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("migrations")


def run() -> None:
    migrations = Path(__file__).resolve().parent.parent / "database" / "migrations"
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
        analytics_role = os.getenv("ANALYTICS_DB_USER", "facilities_analytics")
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
        conn.commit()
    logger.info("Database migrations are current")


if __name__ == "__main__":
    run()
