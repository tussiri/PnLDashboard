"""Account configuration of the leadership labor P&L (migration 028, docs/leadership-rebuild-plan.md).

* `ops.account` holds the featured accounts; `ops.account_job` maps (company, job_number) to one
  account with a segment and a role. Jobs without a mapping are "Other".
* The seed (config/accounts/seed.json) is loaded into an empty `ops.account`. Reloading adds
  missing accounts, segments and job rows and never overwrites a mapping an administrator changed.
* A seed account's `jobs` replace automatic mappings (never an administrator's) and its `exclude_jobs`
  hold jobs out of every account (ops.account_job_exclusion, migration 048), on every mart rebuild, so
  a corrected seed reaches a running system without a manual reload.
* After every mart rebuild `auto_assign` maps jobs first seen since the seed, unless excluded: a current job whose
  parent job is mapped joins that job's account, else a job whose parent-account label is in an
  account's `source_parent_accounts` joins that account. Either way it gets the segment
  `resolve_segment` picks, `assigned_by = 'auto'` and `needs_review = true`.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

ROLES = ("site", "catch_all", "non_billed", "pallet")
VOCABULARIES = ("amazon", "fedex")
INVOICE_BASES = ("last_month", "run_rate_3m")
GROUP_BYS = ("segment", "pallet")
# A WinTeam child job named "... Pallet" rolls into its parent site (migration 037).
PALLET_NAME = r"pallet\s*$"
SEGMENT_SOURCES = ("explicit", "sub_account", "company", "fallback")
REVENUE_METHODS = ("monthly_div", "weekly_billing", "per_visit")
REVENUE_ALLOCATIONS = ("none", "budget_hours")
COST_BASES = ("labor", "labor_plus_vendor")


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
    excluded: set[tuple[str, str]] = set()
    slugs = set()
    for account in data.get("accounts", []):
        slug = account["slug"]
        if slug in slugs:
            raise ValueError(f"duplicate account slug {slug}")
        slugs.add(slug)
        if account.get("segment_source", "explicit") not in SEGMENT_SOURCES:
            raise ValueError(f"{slug}: segment_source must be one of {SEGMENT_SOURCES}")
        if account.get("revenue_allocation", "none") not in REVENUE_ALLOCATIONS:
            raise ValueError(f"{slug}: revenue_allocation must be one of {REVENUE_ALLOCATIONS}")
        if account.get("cost_basis", "labor") not in COST_BASES:
            raise ValueError(f"{slug}: cost_basis must be one of {COST_BASES}")
        if account.get("revenue_method", "monthly_div") not in REVENUE_METHODS:
            raise ValueError(f"{slug}: revenue_method must be one of {REVENUE_METHODS}")
        segment_names = {s["name"] for s in account.get("segments", [])}
        if account["fallback_segment"] not in segment_names:
            raise ValueError(f"{slug}: fallback_segment {account['fallback_segment']!r} is not one of its segments")
        for job in account.get("exclude_jobs", []):
            excluded.add((job["company"], str(job["job_number"])))
        for job in account.get("jobs", []):
            key = (job["company"], str(job["job_number"]))
            if key in seen_jobs:
                raise ValueError(f"job {key[1]} ({key[0]}) is mapped to both {seen_jobs[key]} and {slug}")
            seen_jobs[key] = slug
            if job.get("role", "site") not in ROLES:
                raise ValueError(f"{slug}: job {key[1]} has unknown role {job.get('role')!r}")
            if job.get("role", "site") == "site" and job.get("segment") not in segment_names:
                raise ValueError(f"{slug}: job {key[1]} segment {job.get('segment')!r} is not one of its segments")
    both = sorted(set(seen_jobs) & excluded)
    if both:
        raise ValueError(f"job {both[0][1]} ({both[0][0]}) is both mapped to {seen_jobs[both[0]]} and excluded")


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
                                     segment_source, fallback_segment, revenue_allocation, cost_basis, segment_label, vendor_label, vocabulary,
                                     vendor_factor, invoice_basis, group_by, split_subcontracted, updated_by)
            VALUES (%(slug)s, %(name)s, %(featured)s, %(sort)s, %(target_labor_pct)s, %(watch_band)s, %(revenue_method)s,
                    %(revenue_divisor)s, %(budget_reliability_ratio)s, %(source_parent_accounts)s,
                    %(segment_source)s, %(fallback_segment)s, %(revenue_allocation)s, %(cost_basis)s, %(segment_label)s, %(vendor_label)s,
                    %(vocabulary)s, %(vendor_factor)s, %(invoice_basis)s, %(group_by)s, %(split_subcontracted)s, 'seed')
            ON CONFLICT (slug) DO NOTHING
            """,
            {
                "featured": True, "sort": 100, "target_labor_pct": 0.645, "watch_band": 0.10, "revenue_method": "monthly_div",
                "revenue_divisor": 4.33, "budget_reliability_ratio": 0.80, "source_parent_accounts": [],
                "segment_source": "explicit", "revenue_allocation": "none", "cost_basis": "labor", "segment_label": "Segment", "vendor_label": "Vendor", "vocabulary": "amazon", "vendor_factor": 1,
                "invoice_basis": "last_month", "group_by": "segment", "split_subcontracted": False, **{k: v for k, v in account.items() if k not in ("segments", "jobs")},
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
    counts.update(apply_seed_jobs(cursor, data))
    return counts


def apply_seed_jobs(cursor: Any, data: dict[str, Any]) -> dict[str, int]:
    """The seed's job lists: `jobs` map onto their account (replacing an automatic mapping, never an
    administrator's), `exclude_jobs` are held out of every account (an automatic mapping is removed)."""
    counts = {"jobs": 0, "excluded": 0}
    for account in data["accounts"]:
        for job in account.get("jobs", []):
            cursor.execute(
                """
                INSERT INTO ops.account_job (company, job_number, account_slug, segment, role, companycam_project_id, assigned_by)
                VALUES (%s, %s, %s, %s, %s, %s, 'seed')
                ON CONFLICT (company, job_number) DO UPDATE SET account_slug = EXCLUDED.account_slug, segment = EXCLUDED.segment,
                  role = EXCLUDED.role, assigned_by = 'seed', needs_review = false, updated_at = now()
                WHERE ops.account_job.assigned_by = 'auto'
                """,
                (job["company"], str(job["job_number"]), account["slug"], job.get("segment"), job.get("role", "site"),
                 job.get("companycam_project_id")),
            )
            counts["jobs"] += cursor.rowcount
            cursor.execute("DELETE FROM ops.account_job_exclusion WHERE company = %s AND job_number = %s AND excluded_by = 'seed'",
                           (job["company"], str(job["job_number"])))
        for job in account.get("exclude_jobs", []):
            company, number = job["company"], str(job["job_number"])
            cursor.execute("SELECT 1 FROM ops.account_job WHERE company = %s AND job_number = %s AND assigned_by <> 'auto'", (company, number))
            if cursor.fetchone():
                continue  # an administrator or the seed placed it deliberately
            cursor.execute("DELETE FROM ops.account_job WHERE company = %s AND job_number = %s AND assigned_by = 'auto'", (company, number))
            cursor.execute("INSERT INTO ops.account_job_exclusion (company, job_number, excluded_by) VALUES (%s, %s, 'seed') "
                           "ON CONFLICT (company, job_number) DO NOTHING", (company, number))
            counts["excluded"] += cursor.rowcount
    return counts


def ensure_seeded(cursor: Any) -> dict[str, int] | None:
    """Load the seed when no account exists yet; None when accounts are already configured."""
    cursor.execute("SELECT EXISTS (SELECT 1 FROM ops.account) AS configured")
    if cursor.fetchone()["configured"]:
        return None
    return apply_seed(cursor, load_seed_file())


AUTO_ASSIGN_SQL = """
WITH unmapped AS (
  SELECT j.* FROM core.dim_job j
  WHERE j.valid_to IS NULL AND j.job_number IS NOT NULL AND j.company IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM ops.account_job x WHERE x.company = j.company AND x.job_number = j.job_number)
    AND NOT EXISTS (SELECT 1 FROM ops.account_job_exclusion e WHERE e.company = j.company AND e.job_number = j.job_number)
),
matches AS (
  -- 1: the job's parent job is mapped (a family stays in one account; a parent's billing may be
  --    allocated over its children)
  SELECT j.job_key, j.company, j.job_number, a.slug, a.segment_source, a.fallback_segment, 0 AS rank, a.sort,
         j.job_name ~* %(pallet)s AS pallet
  FROM unmapped j
  JOIN ops.account_job pj ON pj.company = j.company AND pj.job_number = j.parent_job_number
  JOIN ops.account a ON a.slug = pj.account_slug
  UNION ALL
  -- 2: the job's current parent-account label feeds a featured account
  SELECT j.job_key, j.company, j.job_number, a.slug, a.segment_source, a.fallback_segment, 1 AS rank, a.sort, false AS pallet
  FROM unmapped j
  JOIN core.dim_parent_account pa ON pa.parent_account_key = j.parent_account_key
  JOIN ops.account a ON pa.account_name = ANY (a.source_parent_accounts)
),
candidates AS (
  SELECT DISTINCT ON (m.company, m.job_number)
         m.company, m.job_number, m.slug, m.segment_source, m.fallback_segment, m.pallet,
         (SELECT jm.sub_account FROM mart.job_month jm WHERE jm.job_key = m.job_key AND jm.sub_account IS NOT NULL
           ORDER BY jm.month DESC LIMIT 1) AS sub_account
  FROM matches m
  ORDER BY m.company, m.job_number, m.rank, m.sort
)
SELECT c.*, array(SELECT s.name FROM ops.account_segment s WHERE s.account_slug = c.slug ORDER BY s.sort) AS segments
FROM candidates c
"""


def auto_assign(cursor: Any) -> int:
    """Map unmapped jobs of the featured accounts' source parent accounts; returns rows added."""
    cursor.execute(AUTO_ASSIGN_SQL, {"pallet": PALLET_NAME})
    added = 0
    for row in cursor.fetchall():
        segment = resolve_segment(row["segment_source"], company=row["company"], sub_account=row["sub_account"],
                                  segments=list(row["segments"] or []), fallback=row["fallback_segment"])
        cursor.execute(
            """
            INSERT INTO ops.account_job (company, job_number, account_slug, segment, role, assigned_by, needs_review)
            VALUES (%s, %s, %s, %s, %s, 'auto', true) ON CONFLICT (company, job_number) DO NOTHING
            """,
            (row["company"], row["job_number"], row["slug"], None if row["pallet"] else segment, "pallet" if row["pallet"] else "site"),
        )
        added += cursor.rowcount
    return added


def sync_accounts(cursor: Any) -> dict[str, Any]:
    """Called after every mart rebuild: seed an empty configuration, apply the seed's job lists, then map new jobs."""
    seeded = ensure_seeded(cursor)
    seed_jobs = apply_seed_jobs(cursor, load_seed_file()) if seeded is None else None
    return {"seeded": seeded, "seed_jobs": seed_jobs, "auto_assigned": auto_assign(cursor)}
