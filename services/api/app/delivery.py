"""Delivery model: the one place a site is decided self-performed or subcontracted (migrations 066, 067).

Every page reads core.dim_job.delivery_model (through mart.job_week, mart.job_month, mart.leadership_week, the
directory and the site drawer), so this module is the single source of truth. It runs at the start of every mart
rebuild, before the marts read the label, and resolves every current job from evidence, first match wins:

  1. override          ops.job_delivery_override, set by hand.
  2. hours             at least `min_hours` punched in the last `weeks` weeks (mart.v_timekeeping_effective):
                       Crane staffs the site (LGB3, BDL3/7 in Sarus).
  3. subcontract       a subcontractor is paid for the site: AP GL distributions from subcontractor vendor types
                       (setting subcontractor_vendor_type_ids), Relay payables, a Relay site naming a subcontractor
                       with a monthly AP, or job-cost subcontractor cost, in the last `subcontract_days` days. A site
                       that also has punches stays self-performed when its own labor dollars over the same days
                       exceed the subcontractor dollars (a small office cleaned by Crane with an occasional vendor).
  4. relay             Relay marks the station self-performed.
  5. declared          dim_job.delivery_declared: the finance export's is_self_perform (and its overrides) or the
                       delivery_model_by_vertical setting. The export marked FedEx Klamath Falls (523, 524)
                       self-performed although Relay pays ServiceMaster for both and Crane has no punches there.
  6. fallback          self-performed if the job ever had punches, else subcontracted.

So the label is never empty, and `delivery_basis` says which rule decided it. Setting delivery_from_hours =
{"weeks": 8, "min_hours": 40, "subcontract_days": 92}; weeks 0 skips rule 2.
"""
from __future__ import annotations

from typing import Any

SETTING = "delivery_from_hours"
DEFAULT = {"weeks": 8, "min_hours": 40, "subcontract_days": 92}
SELF, SUB = "self_perform", "subcontracted"
BASES = ("override", "hours", "labor_over_subcontract", "subcontractor_ap", "relay", "job_cost", "declared", "fallback")

EVIDENCE_SQL = """
WITH cur AS (
  SELECT job_key, company, job_number, delivery_model, delivery_basis, delivery_declared
  FROM core.dim_job WHERE valid_to IS NULL
),
tk AS (
  SELECT job_key,
         sum(hours) FILTER (WHERE work_date > current_date - %(hours_days)s) AS hours_recent,
         sum(labor_cost) FILTER (WHERE work_date > current_date - %(sub_days)s) AS labor_window
  FROM mart.v_timekeeping_effective
  WHERE work_date <= current_date
  GROUP BY job_key
),
ap AS (
  SELECT d.job_key, sum(d.amount) AS amount
  FROM core.fact_ap_distribution d
  JOIN core.dim_vendor v ON v.vendor_number = d.vendor_number AND v.source = d.source
  WHERE d.invoice_date > current_date - %(sub_days)s AND v.vendor_type_id::text = ANY (%(type_ids)s)
  GROUP BY d.job_key
),
relay_ap AS (
  SELECT winteam_job_number AS job_number, sum(amount) AS amount
  FROM core.relay_ap_payable
  WHERE NOT self_perform AND coalesce(service_month, recorded_at::date) > current_date - %(sub_days)s
  GROUP BY 1
),
relay_site AS (
  SELECT winteam_job_number AS job_number, bool_or(self_perform) AS self,
         bool_or(NOT self_perform AND nullif(btrim(subcontractor), '') IS NOT NULL AND coalesce(ap_monthly, 0) > 0) AS sub
  FROM core.relay_site GROUP BY 1
),
jc AS (
  SELECT company, job_number, sum(subcontractors) AS amount
  FROM mart.v_job_cost_month_effective
  WHERE month >= date_trunc('month', current_date - %(sub_days)s)
  GROUP BY 1, 2
)
SELECT c.job_key, c.company, c.job_number, c.delivery_model, c.delivery_basis, c.delivery_declared,
       o.delivery_model AS override,
       coalesce(tk.hours_recent, 0) AS hours_recent, coalesce(tk.labor_window, 0) AS labor_window,
       tk.job_key IS NOT NULL AS ever_punched,
       coalesce(ap.amount, 0) AS sub_ap,
       -- Relay is the FedEx feed of the primary tenant: a Sarus job number is a different site.
       CASE WHEN c.company IS DISTINCT FROM 'Sarus' THEN coalesce(ra.amount, 0) ELSE 0 END AS relay_ap,
       c.company IS DISTINCT FROM 'Sarus' AND coalesce(rs.sub, false) AS relay_sub,
       c.company IS DISTINCT FROM 'Sarus' AND coalesce(rs.self, false) AS relay_self,
       coalesce(jc.amount, 0) AS job_cost_sub
FROM cur c
LEFT JOIN ops.job_delivery_override o ON o.company = c.company AND o.job_number = c.job_number
LEFT JOIN tk ON tk.job_key = c.job_key
LEFT JOIN ap ON ap.job_key = c.job_key
LEFT JOIN relay_ap ra ON ra.job_number = c.job_number
LEFT JOIN relay_site rs ON rs.job_number = c.job_number
LEFT JOIN jc ON jc.company = c.company AND jc.job_number = c.job_number
"""


def config(value: Any) -> tuple[int, float, int]:
    """(weeks, min_hours, subcontract_days) from the setting; the defaults where missing or malformed."""
    value = value if isinstance(value, dict) else {}

    def num(key: str, cast: Any) -> Any:
        try:
            return cast(value.get(key, DEFAULT[key]))
        except (TypeError, ValueError):
            return cast(DEFAULT[key])

    return max(0, num("weeks", int)), max(0.0, num("min_hours", float)), max(1, num("subcontract_days", int))


def resolve(e: dict[str, Any], weeks: int, min_hours: float) -> tuple[str, str]:
    """(delivery_model, delivery_basis) for one job's evidence row. Pure."""
    if e.get("override") in (SELF, SUB):
        return e["override"], "override"
    hours = float(e.get("hours_recent") or 0)
    if weeks > 0 and hours >= min_hours and hours > 0:
        return SELF, "hours"
    sub_ap, relay_ap, job_cost = (float(e.get(k) or 0) for k in ("sub_ap", "relay_ap", "job_cost_sub"))
    if sub_ap > 0 or relay_ap > 0 or job_cost > 0 or e.get("relay_sub"):
        labor = float(e.get("labor_window") or 0)
        if labor > max(sub_ap, relay_ap, job_cost):
            return SELF, "labor_over_subcontract"
        if sub_ap > 0:
            return SUB, "subcontractor_ap"
        if relay_ap > 0 or e.get("relay_sub"):
            return SUB, "relay"
        return SUB, "job_cost"
    if e.get("relay_self"):
        return SELF, "relay"
    if e.get("delivery_declared") in (SELF, SUB):
        return e["delivery_declared"], "declared"
    return (SELF if e.get("ever_punched") else SUB), "fallback"


def subcontractor_type_ids(cursor: Any) -> list[str]:
    """Vendor type ids that count as subcontractors (setting subcontractor_vendor_type_ids, default [6])."""
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'subcontractor_vendor_type_ids'")
    row = cursor.fetchone()
    return [str(v) for v in (row["value"] if row and isinstance(row["value"], list) else [6])]


def apply(cursor: Any) -> list[dict[str, Any]]:
    """Resolve every current job; returns the jobs whose model or basis changed."""
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = %s", (SETTING,))
    row = cursor.fetchone()
    weeks, min_hours, sub_days = config(row["value"] if row else None)
    cursor.execute(EVIDENCE_SQL, {"hours_days": max(weeks, 1) * 7, "sub_days": sub_days,
                                  "type_ids": subcontractor_type_ids(cursor)})
    changed: list[dict[str, Any]] = []
    for e in cursor.fetchall():
        model, basis = resolve(e, weeks, min_hours)
        if model != e["delivery_model"] or basis != e["delivery_basis"]:
            changed.append({"job_key": e["job_key"], "company": e["company"], "job_number": e["job_number"],
                            "from": e["delivery_model"], "to": model, "basis": basis})
    if changed:
        cursor.executemany(
            "UPDATE core.dim_job SET delivery_model = %(to)s, delivery_basis = %(basis)s, warehouse_updated_at = now() "
            "WHERE job_key = %(job_key)s",
            changed,
        )
    return changed
