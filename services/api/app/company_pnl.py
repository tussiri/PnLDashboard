"""The company P&L the way finance builds it (migration 057, docs/company-pnl.md).

Per month, every job's revenue and costs, the jobs grouped (ops.app_setting 'company_pnl'), corporate
overhead charged out to the groups, and net profit:

1. Job lines. With WinTeam's Cross Tab Income Statement by job loaded for the month
   (core.fact_job_income_statement_month), every GL line on the job, mapped by account range: revenue
   30000-39999; labor 40000-40999; payroll taxes and insurance 41000-42999; other direct 43000-43999 and
   48000-49999; subcontractors 44000-44999; supplies and materials 45000-47999; operating expenses 50000
   and up. Without it, the Job Cost Analysis export (mart.v_job_cost_month_effective, with Relay AR as the
   revenue of a subcontracted FedEx site, as on the Company view), which has no payroll tax line: payroll
   taxes are then estimated as labor x the month's burden rate (app/allocations.py), marked estimated.
2. Adjustments (ops.pnl_adjustment): accruals add an amount to a job's line; an auto-reversing accrual
   stops counting once the line's actual amount has risen by 90% of the accrual over what it was when the
   accrual was entered (the invoice posted). Reclasses move an amount from one job to another.
3. Groups. A job on the overhead list is corporate overhead. Otherwise the first group whose accounts
   include the job's account (and whose delivery_model, when set, is the job's) takes it; the default
   group takes the rest.
4. Overhead = the overhead jobs' costs minus their revenue. Each group is charged its fixed charge and its
   direct account staff (ops.pnl_group_month overrides the setting for a month); the rest of the overhead
   (the pool) is split between the groups with shares_pool by revenue.
5. Gross profit = revenue - direct costs (GL 40000-49999); before overhead = gross profit - operating
   expenses; after overhead = before overhead - fixed - direct staff - pool share. Company net profit =
   the groups' after-overhead total, which equals the jobs' before-overhead total minus overhead whatever
   the split.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from . import allocations

LINES = ("labor", "payroll_taxes", "other_direct", "subcontractors", "supplies", "operating_expenses")
ADJUSTABLE = ("revenue", "labor", "payroll_taxes", "subcontractors", "supplies", "other")
GL_LINES: tuple[tuple[str, int, int], ...] = (
    ("revenue", 30000, 39999), ("labor", 40000, 40999), ("payroll_taxes", 41000, 42999), ("other_direct", 43000, 43999),
    ("subcontractors", 44000, 44999), ("supplies", 45000, 47999), ("other_direct", 48000, 49999), ("operating_expenses", 50000, 99999),
)
REVERSE_SHARE = 0.9
DEFAULT_SETTINGS: dict[str, Any] = {
    "overhead_jobs": ["6325", "63252", "63253"],
    "groups": [
        {"key": "fedex_subs", "name": "New FedEx subs", "accounts": ["fedex"], "delivery_model": "subcontracted",
         "fixed_charge": 30000, "direct_staff": 15000, "shares_pool": False},
        {"key": "education", "name": "Education", "accounts": ["plano-isd", "crowley-isd", "white-settlement-isd", "henderson-isd"],
         "fixed_charge": 0, "direct_staff": 0, "shares_pool": True},
        {"key": "core", "name": "Amazon + other customers", "accounts": [], "default": True, "fixed_charge": 0, "direct_staff": 0,
         "shares_pool": True},
    ],
}


def line_of_account(account: int) -> str | None:
    return next((line for line, lo, hi in GL_LINES if lo <= account <= hi), None)


def adjustment_line(line: str) -> str:
    """ops.pnl_adjustment line -> job line ('supplies' and 'other' map onto the job's lines)."""
    return {"other": "other_direct"}.get(line, line)


# ── settings ────────────────────────────────────────────────────────────────
def settings_of(cursor: Any) -> dict[str, Any]:
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'company_pnl'")
    row = cursor.fetchone()
    value = row["value"] if row and isinstance(row["value"], dict) else None
    return validate_settings(value) if value else validate_settings(DEFAULT_SETTINGS)


def validate_settings(value: dict[str, Any]) -> dict[str, Any]:
    jobs = value.get("overhead_jobs", [])
    if not isinstance(jobs, list) or not all(isinstance(j, (str, int)) and str(j).strip() for j in jobs):
        raise ValueError("overhead_jobs must be a list of job numbers")
    groups = value.get("groups")
    if not isinstance(groups, list) or not groups:
        raise ValueError("groups must be a non-empty list")
    out, keys = [], set()
    for g in groups:
        key = str(g.get("key") or "").strip()
        if not key or not key.replace("_", "").replace("-", "").isalnum():
            raise ValueError("each group needs a key of letters, digits, - or _")
        if key in keys:
            raise ValueError(f"duplicate group key {key}")
        keys.add(key)
        model = g.get("delivery_model") or None
        if model not in (None, "subcontracted", "self_perform"):
            raise ValueError(f"{key}: delivery_model must be subcontracted, self_perform or empty")
        try:
            fixed, staff = float(g.get("fixed_charge") or 0), float(g.get("direct_staff") or 0)
        except (TypeError, ValueError):
            raise ValueError(f"{key}: fixed_charge and direct_staff must be numbers") from None
        accounts = g.get("accounts") or []
        if not isinstance(accounts, list):
            raise ValueError(f"{key}: accounts must be a list of account slugs")
        out.append({"key": key, "name": str(g.get("name") or key), "accounts": [str(a) for a in accounts], "delivery_model": model,
                    "fixed_charge": fixed, "direct_staff": staff, "shares_pool": bool(g.get("shares_pool")), "default": bool(g.get("default"))})
    defaults = [g for g in out if g["default"]]
    if len(defaults) != 1:
        raise ValueError("exactly one group must be the default (it takes every job no other group does)")
    return {"overhead_jobs": [str(j).strip() for j in jobs], "groups": out}


def group_months(cursor: Any, months: list[date]) -> dict[tuple[date, str], dict[str, float | None]]:
    cursor.execute("SELECT month, group_key, fixed_charge, direct_staff FROM ops.pnl_group_month WHERE month = ANY(%s)", (months,))
    return {(r["month"], r["group_key"]): {"fixed_charge": _f(r["fixed_charge"]), "direct_staff": _f(r["direct_staff"])} for r in cursor.fetchall()}


def set_group_month(cursor: Any, month: date, group_key: str, fixed_charge: float | None, direct_staff: float | None, actor: str) -> None:
    if fixed_charge is None and direct_staff is None:
        cursor.execute("DELETE FROM ops.pnl_group_month WHERE month = %s AND group_key = %s", (month, group_key))
        return
    cursor.execute(
        """
        INSERT INTO ops.pnl_group_month (month, group_key, fixed_charge, direct_staff, updated_by) VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (month, group_key) DO UPDATE SET fixed_charge = EXCLUDED.fixed_charge, direct_staff = EXCLUDED.direct_staff,
          updated_at = now(), updated_by = EXCLUDED.updated_by
        """,
        (month, group_key, _d(fixed_charge), _d(direct_staff), actor),
    )


def _f(value: Any) -> float | None:
    return None if value is None else float(value)


def _d(value: float | None) -> Decimal | None:
    return None if value is None else Decimal(str(value))


# ── job lines ───────────────────────────────────────────────────────────────
INCOME_STATEMENT_SQL = """
SELECT company, job_number, max(job_name) AS job_name, gl_account, sum(amount) AS amount
FROM core.fact_job_income_statement_month WHERE month = %(month)s
GROUP BY company, job_number, gl_account
"""

JOB_COST_SQL = """
SELECT jc.company, jc.job_number, jc.job_name,
       CASE WHEN coalesce(jc.company, '') IS DISTINCT FROM 'Sarus'
                 AND (rc.job_number IS NOT NULL OR coalesce(rm.ap_amount, 0) > 0)
                 AND NOT coalesce(rc.self_perform, false) AND coalesce(rm.ar_revenue, 0) > 0
                 AND coalesce(d.delivery_model, 'subcontracted') = 'subcontracted'
            THEN rm.ar_revenue ELSE coalesce(jc.revenue, 0) END AS revenue,
       coalesce(jc.direct_labor, 0) AS labor, coalesce(jc.payroll_taxes_insurance, 0) AS payroll_taxes,
       coalesce(jc.other_direct_costs, 0) AS other_direct, coalesce(jc.subcontractors, 0) AS subcontractors,
       coalesce(jc.materials, 0) + coalesce(jc.equipment_supplies, 0) AS supplies
FROM mart.v_job_cost_month_effective jc
LEFT JOIN mart.v_relay_job_contract rc ON rc.job_number = jc.job_number
LEFT JOIN mart.v_relay_job_month rm ON rm.job_number = jc.job_number AND rm.month = jc.month
LEFT JOIN LATERAL (
  SELECT w.delivery_model FROM mart.leadership_week w
  WHERE w.job_number = jc.job_number AND date_trunc('month', w.week_start + 3)::date = jc.month
  ORDER BY w.week_start DESC LIMIT 1
) d ON true
WHERE jc.month = %(month)s
"""

# The job's account and delivery model: the account mapping, the delivery model of its last week in the
# month, else Relay's self-perform flag (a Relay station with a contract is subcontracted unless self-performed).
JOB_INFO_SQL = """
SELECT aj.company, aj.job_number, aj.account_slug, NULL AS delivery_model FROM ops.account_job aj
UNION ALL
SELECT DISTINCT ON (w.company, w.job_number) w.company, w.job_number, NULL, w.delivery_model
FROM mart.leadership_week w
WHERE date_trunc('month', w.week_start + 3)::date = %(month)s AND w.delivery_model IS NOT NULL
UNION ALL
SELECT NULL, rc.job_number, NULL, CASE WHEN rc.self_perform THEN 'self_perform' ELSE 'subcontracted' END
FROM mart.v_relay_job_contract rc
"""


def _clean_job(job_number: str) -> str:
    """'Crane:300' -> '300' (namespaced job cost rows, migration 054)."""
    return job_number.split(":", 1)[1] if ":" in job_number else job_number


def _sarus(company: str | None) -> bool:
    return "sarus" in (company or "").lower()


def job_lines(cursor: Any, month: date) -> tuple[dict[tuple[bool, str], dict[str, Any]], str]:
    """Per (is Sarus, job number): name, revenue and the cost lines; and the month's source:
    'income_statement' (the Cross Tab report covers every company with job cost that month),
    'mixed' (it covers some) or 'job_cost'."""
    cursor.execute(INCOME_STATEMENT_SQL, {"month": month})
    statement_rows = cursor.fetchall()
    cursor.execute(JOB_COST_SQL, {"month": month})
    cost_rows = cursor.fetchall()
    covered = {_sarus(r["company"]) for r in statement_rows}
    jobs: dict[tuple[bool, str], dict[str, Any]] = {}

    def slot(company: str | None, job: str, name: str | None, basis: str) -> dict[str, Any]:
        key = (_sarus(company), _clean_job(job))
        s = jobs.setdefault(key, {"company": company, "job_number": key[1], "job_name": name, "basis": basis,
                                  "revenue": 0.0, **{line: 0.0 for line in LINES}})
        s["job_name"] = s["job_name"] or name
        return s

    for r in statement_rows:
        line = line_of_account(int(r["gl_account"]))
        if line:
            slot(r["company"], r["job_number"], r["job_name"], "income_statement")[line] += float(r["amount"] or 0)
    for r in cost_rows:
        if _sarus(r["company"]) in covered:
            continue
        s = slot(r["company"], r["job_number"], r["job_name"], "job_cost")
        for line in ("revenue", "labor", "payroll_taxes", "other_direct", "subcontractors", "supplies"):
            s[line] += float(r[line] or 0)
    source = "job_cost" if not covered else ("income_statement" if covered >= {_sarus(r["company"]) for r in cost_rows} else "mixed")
    return jobs, source


def job_info(cursor: Any, month: date) -> dict[tuple[bool, str], dict[str, Any]]:
    cursor.execute(JOB_INFO_SQL, {"month": month})
    info: dict[tuple[bool, str], dict[str, Any]] = {}
    relay: dict[str, str] = {}
    for r in cursor.fetchall():
        if r["company"] is None:  # Relay: Crane job numbers only
            relay[r["job_number"]] = r["delivery_model"]
            continue
        slot = info.setdefault((_sarus(r["company"]), r["job_number"]), {"account": None, "delivery_model": None})
        slot["account"] = slot["account"] or r["account_slug"]
        slot["delivery_model"] = slot["delivery_model"] or r["delivery_model"]
    for job, model in relay.items():
        slot = info.setdefault((False, job), {"account": None, "delivery_model": None})
        slot["delivery_model"] = slot["delivery_model"] or model
    return info


# ── adjustments ─────────────────────────────────────────────────────────────
def adjustments_of(cursor: Any, month: date) -> list[dict[str, Any]]:
    cursor.execute(
        """
        SELECT adjustment_id, month, kind, line, company, job_number, to_company, to_job_number, amount, auto_reverse, baseline,
               note, reversed_at, reversed_by, created_at, created_by
        FROM ops.pnl_adjustment WHERE month = %s ORDER BY adjustment_id
        """,
        (month,),
    )
    return [dict(r) for r in cursor.fetchall()]


def apply_adjustments(jobs: dict[tuple[bool, str], dict[str, Any]], adjustments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply the month's adjustments to the job lines in place. Returns each adjustment with its status:
    active, reversed (by a person) or posted (an auto-reversing accrual whose actual amount came in)."""
    out = []
    for a in adjustments:
        amount = float(a["amount"])
        line = adjustment_line(a["line"])
        key = (_sarus(a["company"]), _clean_job(str(a["job_number"])))
        if a["reversed_at"] is not None:
            status = "reversed"
        elif a["kind"] == "accrual" and a["auto_reverse"] and a.get("baseline") is not None:
            actual = jobs.get(key, {}).get(line, 0.0)
            status = "posted" if actual - float(a["baseline"]) >= REVERSE_SHARE * amount else "active"
        else:
            status = "active"
        if status == "active":
            target = jobs.setdefault(key, {"company": a["company"], "job_number": key[1], "job_name": None, "basis": "adjustment",
                                           "revenue": 0.0, **{x: 0.0 for x in LINES}})
            if a["kind"] == "accrual":
                target[line] += amount
            else:
                target[line] -= amount
                to_key = (_sarus(a["to_company"] or a["company"]), _clean_job(str(a["to_job_number"])))
                dest = jobs.setdefault(to_key, {"company": a["to_company"] or a["company"], "job_number": to_key[1], "job_name": None,
                                                "basis": "adjustment", "revenue": 0.0, **{x: 0.0 for x in LINES}})
                dest[line] += amount
        out.append({**a, "status": status})
    return out


def baseline_for(cursor: Any, month: date, company: str, job_number: str, line: str) -> float:
    """The job's actual amount on the line for the month now (an accrual's reversal point)."""
    jobs, _ = job_lines(cursor, month)
    return round(jobs.get((_sarus(company), _clean_job(job_number)), {}).get(adjustment_line(line), 0.0), 2)


SUGGEST_SQL = """
SELECT rc.job_number, max(j.job_name) AS job_name, max(j.company) AS company
FROM mart.v_relay_job_contract rc
LEFT JOIN core.dim_job j ON j.job_number = rc.job_number AND j.valid_to IS NULL AND j.company IS DISTINCT FROM 'Sarus'
WHERE NOT coalesce(rc.self_perform, false)
GROUP BY rc.job_number
"""


def suggest_accruals(cursor: Any, month: date) -> list[dict[str, Any]]:
    """Subcontracted (Relay) sites billed in the month whose subcontractor cost is under 90% of the month
    before: the missing invoice, at the prior month's amount less what is in (finance's month-end accrual).
    Sites with an active accrual on the line are left out."""
    prior = date(month.year - (month.month == 1), (month.month - 2) % 12 + 1, 1)
    now, _ = job_lines(cursor, month)
    before, _ = job_lines(cursor, prior)
    open_accruals = {(_sarus(a["company"]), _clean_job(a["job_number"]))
                     for a in apply_adjustments(dict(now), adjustments_of(cursor, month))
                     if a["kind"] == "accrual" and a["line"] == "subcontractors" and a["status"] == "active"}
    cursor.execute(SUGGEST_SQL)
    out = []
    for r in cursor.fetchall():
        key = (False, r["job_number"])
        current, last = now.get(key), before.get(key)
        if not current or not last or current["revenue"] <= 0 or key in open_accruals:
            continue
        gap = last["subcontractors"] - current["subcontractors"]
        if last["subcontractors"] > 0 and current["subcontractors"] < REVERSE_SHARE * last["subcontractors"]:
            out.append({"company": r["company"] or "Crane IFS", "job_number": r["job_number"], "job_name": r["job_name"] or current["job_name"],
                        "revenue": round(current["revenue"], 2), "subcontractors": round(current["subcontractors"], 2),
                        "prior_subcontractors": round(last["subcontractors"], 2), "amount": round(gap, 2)})
    return sorted(out, key=lambda x: -x["amount"])


# ── the P&L ─────────────────────────────────────────────────────────────────
def group_of(cfg: dict[str, Any], account: str | None, delivery_model: str | None) -> dict[str, Any]:
    for g in cfg["groups"]:
        if g["default"] or account not in g["accounts"]:
            continue
        if g["delivery_model"] and g["delivery_model"] != delivery_model:
            continue
        return g
    return next(g for g in cfg["groups"] if g["default"])


def compute(month: date, cfg: dict[str, Any], jobs: dict[tuple[bool, str], dict[str, Any]], info: dict[tuple[bool, str], dict[str, Any]],
            overrides: dict[tuple[date, str], dict[str, float | None]], burden_rate: float | None, source: str) -> dict[str, Any]:
    """One month of the company P&L from adjusted job lines (pure, so tests need no database)."""
    overhead_jobs = set(cfg["overhead_jobs"])
    estimate = source != "income_statement" and burden_rate is not None
    groups = {g["key"]: {"key": g["key"], "name": g["name"], "revenue": 0.0, "gross_profit": 0.0, "before_overhead": 0.0,
                         **{line: 0.0 for line in LINES}, "jobs": 0, "accounts": {}} for g in cfg["groups"]}
    overhead = {"revenue": 0.0, "cost": 0.0, "jobs": 0}
    totals = {"revenue": 0.0, **{line: 0.0 for line in LINES}, "payroll_taxes_estimated": 0.0}
    for (sarus, job), j in jobs.items():
        lines = {line: j[line] for line in LINES}
        if j["basis"] != "income_statement" and estimate and not lines["payroll_taxes"] and lines["labor"]:
            lines["payroll_taxes"] = round(lines["labor"] * burden_rate, 2)  # job cost carries no payroll tax line
            totals["payroll_taxes_estimated"] += lines["payroll_taxes"]
        cost = sum(lines.values())
        totals["revenue"] += j["revenue"]
        for line in LINES:
            totals[line] += lines[line]
        if not sarus and job in overhead_jobs:
            overhead["revenue"] += j["revenue"]
            overhead["cost"] += cost
            overhead["jobs"] += 1
            continue
        meta = info.get((sarus, job), {})
        g = groups[group_of(cfg, meta.get("account"), meta.get("delivery_model"))["key"]]
        direct = cost - lines["operating_expenses"]
        g["revenue"] += j["revenue"]
        g["gross_profit"] += j["revenue"] - direct
        g["before_overhead"] += j["revenue"] - cost
        for line in LINES:
            g[line] += lines[line]
        g["jobs"] += 1
        acct = g["accounts"].setdefault(meta.get("account") or "other", {"revenue": 0.0, "before_overhead": 0.0, "jobs": 0})
        acct["revenue"] += j["revenue"]
        acct["before_overhead"] += j["revenue"] - cost
        acct["jobs"] += 1
    overhead_cost = overhead["cost"] - overhead["revenue"]
    for g in cfg["groups"]:
        o = overrides.get((month, g["key"]), {})
        slot = groups[g["key"]]
        slot["fixed_charge"] = o.get("fixed_charge") if o.get("fixed_charge") is not None else g["fixed_charge"]
        slot["direct_staff"] = o.get("direct_staff") if o.get("direct_staff") is not None else g["direct_staff"]
    pool = overhead_cost - sum(groups[g["key"]]["fixed_charge"] + groups[g["key"]]["direct_staff"] for g in cfg["groups"])
    sharing = [g["key"] for g in cfg["groups"] if g["shares_pool"]]
    spread_base = sum(groups[k]["revenue"] for k in sharing)
    out_groups = []
    for g in cfg["groups"]:
        slot = groups[g["key"]]
        share = pool * slot["revenue"] / spread_base if g["shares_pool"] and spread_base else 0.0
        charged = slot["fixed_charge"] + slot["direct_staff"] + share
        slot["pool_share"] = share
        slot["overhead"] = charged
        slot["after_overhead"] = slot["before_overhead"] - charged
        accounts = []
        for slug, a in slot.pop("accounts").items():
            a_charge = charged * a["revenue"] / slot["revenue"] if slot["revenue"] else 0.0
            accounts.append({"account": slug, "revenue": _r(a["revenue"]), "before_overhead": _r(a["before_overhead"]),
                             "overhead": _r(a_charge), "after_overhead": _r(a["before_overhead"] - a_charge), "jobs": a["jobs"]})
        slot["accounts"] = sorted(accounts, key=lambda a: -a["revenue"])
        out_groups.append({k: (_r(v) if isinstance(v, float) else v) for k, v in slot.items()})
    revenue = totals["revenue"]
    gross = sum(g["gross_profit"] for g in out_groups)
    before = sum(g["before_overhead"] for g in out_groups)
    return {
        "month": month.isoformat(), "source": source, "revenue": _r(revenue), "operating_revenue": _r(revenue - overhead["revenue"]),
        "gross_profit": _r(gross), "before_overhead": _r(before), "overhead": _r(overhead_cost), "pool": _r(pool),
        "net_profit": _r(before - overhead_cost), "lines": {k: _r(v) for k, v in totals.items() if k != "revenue"},
        "payroll_taxes_basis": "income_statement" if source == "income_statement" else ("estimate" if estimate else None),
        "overhead_jobs": {k: _r(v) if isinstance(v, float) else v for k, v in overhead.items()}, "groups": out_groups,
    }


def _r(value: float) -> float:
    return round(value, 2)


def month_pnl(cursor: Any, month: date, cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = cfg or settings_of(cursor)
    jobs, source = job_lines(cursor, month)
    adjustments = apply_adjustments(jobs, adjustments_of(cursor, month))
    alloc_cfg = allocations.settings_of(cursor)
    burden = allocations.month_figures(month, alloc_cfg, allocations.statement(cursor), allocations.manual(cursor))["burden_rate"]
    out = compute(month, cfg, jobs, job_info(cursor, month), group_months(cursor, [month]), burden, source)
    active = [a for a in adjustments if a["status"] == "active"]
    out["adjustments"] = {
        "count": len(active), "accruals": _r(sum(float(a["amount"]) for a in active if a["kind"] == "accrual")),
        "reclasses": _r(sum(float(a["amount"]) for a in active if a["kind"] == "reclass")),
        "posted": sum(1 for a in adjustments if a["status"] == "posted"),
    }
    return out
