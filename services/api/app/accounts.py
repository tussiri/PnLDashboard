"""Account configuration of the leadership labor P&L (migration 028, docs/leadership-rebuild-plan.md).

* `ops.account` holds the featured accounts; `ops.account_job` maps (company, job_number) to one
  account with a segment and a role. Jobs without a mapping are "Other".
* The seed (config/accounts/seed.json) is loaded into an empty `ops.account`. Reloading adds
  missing accounts, segments and job rows and never overwrites a mapping an administrator changed.
* After every mart rebuild `auto_assign` maps jobs first seen since the seed: a current job whose
  parent-account label is in an account's `source_parent_accounts` gets a row with the segment
  `resolve_segment` picks, `assigned_by = 'auto'` and `needs_review = true`.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

ROLES = ("site", "catch_all", "non_billed")
SEGMENT_SOURCES = ("explicit", "sub_account", "company", "fallback")
REVENUE_METHODS = ("monthly_div", "weekly_billing", "per_visit")


def seed_path() -> Path:
    """ACCOUNTS_SEED_PATH, else /app/config/accounts/seed.json in the image, else the repository copy."""
    explicit = os.environ.get("ACCOUNTS_SEED_PATH")
    if explicit:
        return Path(explicit)
    here = Path(__file__).resolve()
    for candidate in (here.parent.parent / "config" / "accounts" / "seed.json",
                      here.parents[3] / "config" / "accounts" / "seed.json" if len(here.parents) > 3 else None):
        if candidate is not None and candidate.exists():
            return candidate
    return here.parent.parent / "config" / "accounts" / "seed.json"


def load_seed_file(path: Path | None = None) -> dict[str, Any]:
    data = json.loads((path or seed_path()).read_text(encoding="utf-8"))
    validate_seed(data)
    return data


def validate_seed(data: dict[str, Any]) -> None:
    """Reject a seed the database would refuse, with a message naming the account and job."""
    seen_jobs: dict[tuple[str, str], str] = {}
    slugs = set()
    for account in data.get("accounts", []):
        slug = account["slug"]
        if slug in slugs:
            raise ValueError(f"duplicate account slug {slug}")
        slugs.add(slug)
        if account.get("segment_source", "explicit") not in SEGMENT_SOURCES:
            raise ValueError(f"{slug}: segment_source must be one of {SEGMENT_SOURCES}")
        if account.get("revenue_method", "monthly_div") not in REVENUE_METHODS:
            raise ValueError(f"{slug}: revenue_method must be one of {REVENUE_METHODS}")
        segment_names = {s["name"] for s in account.get("segments", [])}
        if account["fallback_segment"] not in segment_names:
            raise ValueError(f"{slug}: fallback_segment {account['fallback_segment']!r} is not one of its segments")
        for job in account.get("jobs", []):
            key = (job["company"], str(job["job_number"]))
            if key in seen_jobs:
                raise ValueError(f"job {key[1]} ({key[0]}) is mapped to both {seen_jobs[key]} and {slug}")
            seen_jobs[key] = slug
            if job.get("role", "site") not in ROLES:
                raise ValueError(f"{slug}: job {key[1]} has unknown role {job.get('role')!r}")
            if job.get("role", "site") == "site" and job.get("segment") not in segment_names:
                raise ValueError(f"{slug}: job {key[1]} segment {job.get('segment')!r} is not one of its segments")


def resolve_segment(segment_source: str, *, company: str | None, sub_account: str | None,
                    segments: list[str], fallback: str) -> str:
    """Segment for an automatically assigned job; anything not among the account's segments falls back."""
    if segment_source == "company":
        candidate = company
    elif segment_source == "sub_account":
        candidate = sub_account
    else:
        candidate = None
    return candidate if candidate in segments else fallback


def apply_seed(cursor: Any, data: dict[str, Any]) -> dict[str, int]:
    """Insert missing accounts, segments and job mappings; existing rows are left alone."""
    counts = {"accounts": 0, "segments": 0, "jobs": 0}
    for account in data["accounts"]:
        cursor.execute(
            """
            INSERT INTO ops.account (slug, name, featured, sort, target_labor_pct, watch_band, revenue_method,
                                     revenue_divisor, budget_reliability_ratio, source_parent_accounts,
                                     segment_source, fallback_segment, updated_by)
            VALUES (%(slug)s, %(name)s, %(featured)s, %(sort)s, %(target_labor_pct)s, %(watch_band)s, %(revenue_method)s,
                    %(revenue_divisor)s, %(budget_reliability_ratio)s, %(source_parent_accounts)s,
                    %(segment_source)s, %(fallback_segment)s, 'seed')
            ON CONFLICT (slug) DO NOTHING
            """,
            {
                "featured": True, "sort": 100, "target_labor_pct": 0.645, "watch_band": 0.10, "revenue_method": "monthly_div",
                "revenue_divisor": 4.33, "budget_reliability_ratio": 0.80, "source_parent_accounts": [],
                "segment_source": "explicit", **{k: v for k, v in account.items() if k not in ("segments", "jobs")},
            },
        )
        counts["accounts"] += cursor.rowcount
        for order, segment in enumerate(account.get("segments", []), start=1):
            cursor.execute(
                """
                INSERT INTO ops.account_segment (account_slug, name, sort, target_labor_pct)
                VALUES (%s, %s, %s, %s) ON CONFLICT (account_slug, name) DO NOTHING
                """,
                (account["slug"], segment["name"], order, segment.get("target_labor_pct")),
            )
            counts["segments"] += cursor.rowcount
        for job in account.get("jobs", []):
            cursor.execute(
                """
                INSERT INTO ops.account_job (company, job_number, account_slug, segment, role, companycam_project_id, assigned_by)
                VALUES (%s, %s, %s, %s, %s, %s, 'seed') ON CONFLICT (company, job_number) DO NOTHING
                """,
                (job["company"], str(job["job_number"]), account["slug"], job.get("segment"), job.get("role", "site"),
                 job.get("companycam_project_id")),
            )
            counts["jobs"] += cursor.rowcount
    return counts


def ensure_seeded(cursor: Any) -> dict[str, int] | None:
    """Load the seed when no account exists yet; None when accounts are already configured."""
    cursor.execute("SELECT EXISTS (SELECT 1 FROM ops.account) AS configured")
    if cursor.fetchone()["configured"]:
        return None
    return apply_seed(cursor, load_seed_file())


AUTO_ASSIGN_SQL = """
WITH candidates AS (
  SELECT DISTINCT ON (j.company, j.job_number)
         j.company, j.job_number, a.slug, a.segment_source, a.fallback_segment,
         (SELECT m.sub_account FROM mart.job_month m WHERE m.job_key = j.job_key AND m.sub_account IS NOT NULL
           ORDER BY m.month DESC LIMIT 1) AS sub_account
  FROM core.dim_job j
  JOIN core.dim_parent_account pa ON pa.parent_account_key = j.parent_account_key
  JOIN ops.account a ON pa.account_name = ANY (a.source_parent_accounts)
  WHERE j.valid_to IS NULL AND j.job_number IS NOT NULL AND j.company IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM ops.account_job x WHERE x.company = j.company AND x.job_number = j.job_number)
  ORDER BY j.company, j.job_number, a.sort
)
SELECT c.*, array(SELECT s.name FROM ops.account_segment s WHERE s.account_slug = c.slug ORDER BY s.sort) AS segments
FROM candidates c
"""


def auto_assign(cursor: Any) -> int:
    """Map unmapped jobs of the featured accounts' source parent accounts; returns rows added."""
    cursor.execute(AUTO_ASSIGN_SQL)
    added = 0
    for row in cursor.fetchall():
        segment = resolve_segment(row["segment_source"], company=row["company"], sub_account=row["sub_account"],
                                  segments=list(row["segments"] or []), fallback=row["fallback_segment"])
        cursor.execute(
            """
            INSERT INTO ops.account_job (company, job_number, account_slug, segment, role, assigned_by, needs_review)
            VALUES (%s, %s, %s, %s, 'site', 'auto', true) ON CONFLICT (company, job_number) DO NOTHING
            """,
            (row["company"], row["job_number"], row["slug"], segment),
        )
        added += cursor.rowcount
    return added


def sync_accounts(cursor: Any) -> dict[str, Any]:
    """Called after every mart rebuild: seed an empty configuration, then map new jobs."""
    seeded = ensure_seeded(cursor)
    return {"seeded": seeded, "auto_assigned": auto_assign(cursor)}
