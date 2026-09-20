"""Weekly executive labor P&L mart (mart.job_week): one row per job and Monday-based week.

Replica of the executive "Labor P&L Dashboard" (Finance_Reporting cfo_dashboard/account_pl.py and
transformations/_timekeeping.py), rebuilt from the core facts and mart.job_month at the end of every
mart rebuild (marts.rebuild_all -> weekly.rebuild). Full definitions: docs/executive-pl.md.

Rules (the SQL below is authoritative; the pure functions in the top half mirror it for unit tests
and for the router's notes):

* A (job, week) row exists for every Monday week, up to the current week, in which the job has any
  timekeeping, any daily budget row, or that overlaps a month with monthly revenue / subcontract
  cost / labor budget / AR invoices / agency-sub invoices.
* Hours come from mart.v_timekeeping_effective (the timekeeping facts after the 011 source
  precedence: API punches win the days they cover) by work_date week (regular / overtime / double time).
* direct_dollars = sum(fact_timekeeping.labor_cost): STRAIGHT-TIME labor, hours x the job rate
  (`labor_cost_basis` says which rate: trailing_job_rate for the reference source, hours_x_rate for
  the WinTeam API). No premium is included in direct_dollars.
* ot_dollars = sum(overtime_hours x rate x 0.5 + double_time_hours x rate x 1.0): an ESTIMATE of
  the premium paid (time-and-a-half / double time); the feeds do not carry the paid premium.
* A week is split into "slices", one per calendar month it overlaps (a straddle week has two).
  Every monthly figure is apportioned to the slice by calendar days:
    - invoicing, per slice, in this order:
        1. the month is closed and the job has job-cost revenue -> revenue x days / days_in_month
           (basis job_cost_month_prorated; a closed month = a month mart.job_month reports with
           revenue_basis 'job_cost');
        2. core.contract_billing has an amount effective for the month (latest effective_month <=
           month) -> monthly_amount x 12/53 x days / 7 (basis contract; the original 12/53 rule);
        3. AR invoices for the service month -> revenue_total x days / days_in_month
           (basis ar_invoice_prorated);
        4. the job's most recent month, within the last three closed months, with job-cost revenue
           or AR service-month revenue > 0: GREATEST(job-cost revenue, AR revenue) of that month
           prorated by calendar days like 1. (basis carry_forward; the row is flagged
           invoicing_estimated = true and carry_forward_source says which figure won, 'job_cost'
           or 'ar_invoice') - the original dashboard's carry-forward;
        5. 0 (basis none).
    - sub_dollars, per slice: the month's known subcontract cost x days / days_in_month, where the
      known cost is the job-cost subcontractors line in a closed month (basis job_cost), else - for
      the sites named in the agency_sub setting - the matching vendor's AP invoices coded to the
      site (invoice number prefix) x pct, by invoice month (basis agency_ap). A month without a
      known cost that is not closed takes a PROJECTION (migration 015): the job's average weekly
      subcontract cost over its job-cost months among the last TRAILING_SUB_MONTHS closed months
      before the slice's month, sum(sub / days_in_month x 7) / months, x days / 7 (basis
      trailing_3mo_projection, sub_estimated = true; `project_weekly_sub`); a job with no job-cost
      month in that window projects 0 (basis none). A closed month without a booked cost is 0.
      month_shares records, per slice, the monthly figure the slice was apportioned from
      (`sub_month`: the job-cost line, the agency allocation, or the projected month = weekly x
      days_in_month / 7) so the router can sum a month's projected vendor cost over the sites.
    - budget, per slice: sum(core.fact_daily_budget) over the slice's days when the job's daily
      budget rows cover the slice (basis daily_budget), else the monthly labor budget x days /
      days_in_month (basis hbc), else null (basis none). budget_hours likewise.
  The week's basis labels are those of the dominant slice (most days among non-'none' slices);
  month_shares records every slice's days and bases.
* total_dollars = direct + sub (direct is all-in payroll; ot_dollars is an informational premium estimate). company (the business unit) = the job's company, else the
  timekeeping company. site_code = the token after " - " in the job name ("Amazon - LGB3" ->
  "LGB3"), else the job name.
* sub_account (migration 014): the second level under the parent account, derived per job by
  `sub_account_for` from the setting sub_account_rules after the SQL rebuild (a Python pass over
  core.dim_job, written back with one UPDATE): a prefix_map label when the job name starts with a
  key (job_prefix basis) or carries it as a leading / inner word (customer_name basis), else the AR
  customer name when it differs from the account (customer_name basis), else the rule's default,
  else the account. Jobs without a parent account keep NULL.
"""
from __future__ import annotations

import copy
import json
import logging
from calendar import monthrange
from datetime import date, timedelta
from typing import Any, Iterable, Sequence

logger = logging.getLogger("weekly")

OT_PREMIUM = 0.5          # overtime premium over straight time (time-and-a-half)
DT_PREMIUM = 1.0          # double-time premium over straight time
CONTRACT_WEEKS_PER_MONTH = 12.0 / 53.0   # the original dashboard's 12/53 rule: weekly = monthly x 12/53

INVOICING_JOB_COST = "job_cost_month_prorated"
INVOICING_CONTRACT = "contract"
INVOICING_AR = "ar_invoice_prorated"
INVOICING_CARRY = "carry_forward"
CARRY_FORWARD_CLOSED_MONTHS = 3      # how far back a closed month may be carried forward
BASIS_NONE = "none"
BUDGET_DAILY = "daily_budget"
BUDGET_HBC = "hbc"
SUB_JOB_COST = "job_cost"
SUB_AGENCY = "agency_ap"
SUB_PROJECTION = "trailing_3mo_projection"
TRAILING_SUB_MONTHS = 3          # closed months averaged for the non-closed-month subcontract projection

DEFAULT_AGENCY_SUB: dict[str, Any] = {"vendor_match": "km group", "pct": 0.70, "site_jobs": {"LGB3": "500", "APC2": "505", "PSP3": "504"}}

BASIS_JOB_PREFIX = "job_prefix"          # sub-account from a job-name prefix only (FedEx FXE_/FXG_ stations)
BASIS_CUSTOMER_NAME = "customer_name"    # prefix (leading or inner word) first, then the AR customer name
ANY_ACCOUNT = "*"
DEFAULT_SUB_ACCOUNT_RULES: dict[str, dict[str, Any]] = {
    "Education": {
        "basis": BASIS_CUSTOMER_NAME,
        "prefix_map": {
            "ws-": "White Settlement Independent School District",
            "white settlement": "White Settlement Independent School District",
            "plano": "Plano Independent School District",
            "henderson": "Henderson Independent School District",
            "crowley": "Crowley Independent School District",
            "crawley": "Crowley Independent School District",
            "aldine": "Aldine Independent School District",
        },
    },
    "FedEx": {"basis": BASIS_JOB_PREFIX, "prefix_map": {"fxe": "FedEx Express (FXE)", "fxg": "FedEx Ground (FXG)"}, "default": "FedEx"},
    ANY_ACCOUNT: {"basis": BASIS_CUSTOMER_NAME},
}


# ── pure helpers (mirror the SQL; unit tested) ───────────────────────────────
def week_start(value: date) -> date:
    """Monday of the ISO week containing `value`."""
    return value - timedelta(days=value.weekday())


def days_in_month(month: date) -> int:
    return monthrange(month.year, month.month)[1]


def month_overlap_days(week: date, month: date) -> int:
    """Calendar days of the Monday week `week` that fall inside `month` (0..7)."""
    first = month.replace(day=1)
    last = first.replace(day=days_in_month(first))
    start = max(week, first)
    end = min(week + timedelta(days=6), last)
    return max((end - start).days + 1, 0)


def month_shares(week: date) -> dict[date, int]:
    """{month_start: days} for every month the week overlaps (one entry, or two for a straddle week)."""
    out: dict[date, int] = {}
    for d in (week, week + timedelta(days=6)):
        m = d.replace(day=1)
        if m not in out:
            out[m] = month_overlap_days(week, m)
    return out


def prorate_month(amount: float, overlap_days: int, month: date) -> float:
    """A monthly amount apportioned to `overlap_days` of `month` by calendar days."""
    return float(amount) * overlap_days / days_in_month(month)


def contract_weekly(monthly_amount: float, overlap_days: int) -> float:
    """12/53 rule: weekly invoicing = monthly x 12/53 x (days of the week in the month / 7)."""
    return float(monthly_amount) * CONTRACT_WEEKS_PER_MONTH * overlap_days / 7.0


def ot_dollars(ot_hours: float, dt_hours: float, rate: float) -> float:
    """Estimated premium: overtime x rate x 0.5 + double time x rate x 1.0 (straight time is in direct)."""
    return float(ot_hours) * float(rate) * OT_PREMIUM + float(dt_hours) * float(rate) * DT_PREMIUM


def select_invoicing(closed_job_cost_revenue: float | None, contract_amount: float | None, ar_revenue: float | None,
                     overlap_days: int, month: date, carry_forward_revenue: float | None = None) -> tuple[float, str]:
    """(invoicing, basis) for one week/month slice, in the documented precedence.

    `carry_forward_revenue` is the job's most recent closed month's job-cost revenue (> 0, within the
    last CARRY_FORWARD_CLOSED_MONTHS closed months); it is prorated by the slice's own month days.
    """
    if closed_job_cost_revenue:
        return prorate_month(closed_job_cost_revenue, overlap_days, month), INVOICING_JOB_COST
    if contract_amount is not None:
        return contract_weekly(contract_amount, overlap_days), INVOICING_CONTRACT
    if ar_revenue:
        return prorate_month(ar_revenue, overlap_days, month), INVOICING_AR
    if carry_forward_revenue:
        return prorate_month(carry_forward_revenue, overlap_days, month), INVOICING_CARRY
    return 0.0, BASIS_NONE


def carry_forward_source(closed_months: Sequence[date], job_cost_by_month: dict[date, float], month: date,
                         ar_by_month: dict[date, float] | None = None,
                         window: int = CARRY_FORWARD_CLOSED_MONTHS) -> tuple[date, float, str] | None:
    """(source_month, amount, source) carried forward into `month`, or None.

    The source month is the most recent of the `window` latest closed months before `month` with
    job-cost revenue or AR service-month revenue > 0; the amount is the greater of the two for that
    month and `source` is 'job_cost' or 'ar_invoice' (job_cost wins ties).
    """
    ar_by_month = ar_by_month or {}
    recent = sorted((m for m in closed_months if m < month), reverse=True)[:window]
    for m in recent:
        jc = job_cost_by_month.get(m, 0.0) or 0.0
        ar = ar_by_month.get(m, 0.0) or 0.0
        if jc > 0 or ar > 0:
            return (m, jc, "job_cost") if jc >= ar else (m, ar, "ar_invoice")
    return None


def trailing_weekly_sub_rate(closed_months: Sequence[tuple[date, float]], window: int = TRAILING_SUB_MONTHS) -> float | None:
    """Average weekly subcontract cost over the most recent `window` closed months given, or None when empty.

    `closed_months` = [(month, subcontract dollars of the month)] for the job's job-cost months; each
    month contributes sub / days_in_month x 7 and the average is over the months present (1..window),
    so a month with a booked 0 lowers the rate while a month without a job-cost row is simply absent.
    """
    recent = sorted(closed_months, key=lambda m: m[0], reverse=True)[:window]
    if not recent:
        return None
    return sum(float(sub or 0.0) / days_in_month(m) * 7.0 for m, sub in recent) / len(recent)


def project_weekly_sub(closed_months: Sequence[tuple[date, float]], week_days_in_month: int, days_in_month: int) -> float:
    """The trailing-3-closed-months projection of one week/month slice's subcontract cost (basis trailing_3mo_projection).

    The weekly rate (`trailing_weekly_sub_rate`) is scaled to a projected month (rate x days_in_month / 7)
    and apportioned to the slice's days like every other monthly figure (x week_days_in_month /
    days_in_month), i.e. rate x week_days_in_month / 7. No closed month -> 0 (the row's basis is none).
    """
    rate = trailing_weekly_sub_rate(closed_months)
    if rate is None or days_in_month <= 0:
        return 0.0
    return rate * days_in_month / 7.0 * week_days_in_month / days_in_month


def select_budget(daily_sum: float | None, daily_covers_slice: bool, monthly_budget: float | None,
                  overlap_days: int, month: date) -> tuple[float | None, str]:
    """(budget, basis): the daily budget summed over the slice when it covers it, else the monthly x day share."""
    if daily_covers_slice:
        return float(daily_sum or 0.0), BUDGET_DAILY
    if monthly_budget is not None:
        return prorate_month(monthly_budget, overlap_days, month), BUDGET_HBC
    return None, BASIS_NONE


def dominant_basis(slices: Iterable[tuple[str, int, date]], none: str = BASIS_NONE) -> str:
    """The basis of the slice with the most days among slices whose basis is not `none` (ties: earlier month)."""
    ranked = sorted(((b, d, m) for b, d, m in slices if b != none), key=lambda s: (-s[1], s[2]))
    return ranked[0][0] if ranked else none


def site_code(job_name: str | None) -> str | None:
    """'Amazon - LGB3' -> 'LGB3'; a name without ' - ' is returned unchanged."""
    if job_name is None:
        return None
    marker = " - "
    idx = job_name.find(marker)
    return job_name[idx + len(marker):].strip() if idx >= 0 else job_name.strip()


def agency_sub_setting(value: Any) -> dict[str, Any]:
    """Validated agency_sub setting: {vendor_match, pct, site_jobs} (defaults when malformed)."""
    cfg = dict(DEFAULT_AGENCY_SUB)
    if isinstance(value, dict):
        if isinstance(value.get("vendor_match"), str):
            cfg["vendor_match"] = value["vendor_match"].strip().lower()
        try:
            cfg["pct"] = float(value.get("pct", cfg["pct"]))
        except (TypeError, ValueError):
            pass
        if isinstance(value.get("site_jobs"), dict):
            cfg["site_jobs"] = {str(k).strip().upper(): str(v).strip() for k, v in value["site_jobs"].items() if str(k).strip() and str(v).strip()}
    cfg["enabled"] = bool(cfg["vendor_match"]) and cfg["pct"] > 0 and bool(cfg["site_jobs"])
    return cfg


def sub_account_rules_setting(value: Any) -> dict[str, dict[str, Any]]:
    """Validated sub_account_rules: {account: {basis, prefix_map, default}} (defaults when malformed).

    Account keys keep their case (they are matched to the parent account exactly, "*" = any);
    prefix_map keys are lower-cased and stripped; a rule without a recognised basis gets
    customer_name; an empty or non-object setting falls back to DEFAULT_SUB_ACCOUNT_RULES.
    """
    if not isinstance(value, dict):
        return copy.deepcopy(DEFAULT_SUB_ACCOUNT_RULES)
    out: dict[str, dict[str, Any]] = {}
    for account, rule in value.items():
        if not isinstance(account, str) or not account.strip() or not isinstance(rule, dict):
            continue
        basis = str(rule.get("basis") or "").strip().lower()
        if basis not in (BASIS_JOB_PREFIX, BASIS_CUSTOMER_NAME):
            basis = BASIS_CUSTOMER_NAME
        raw_map = rule.get("prefix_map") if isinstance(rule.get("prefix_map"), dict) else {}
        prefix_map = {str(k).strip().lower(): str(v).strip() for k, v in raw_map.items() if str(k).strip() and str(v).strip()}
        cleaned: dict[str, Any] = {"basis": basis, "prefix_map": prefix_map}
        if isinstance(rule.get("default"), str) and rule["default"].strip():
            cleaned["default"] = rule["default"].strip()
        out[account.strip()] = cleaned
    return out or sub_account_rules_setting(None)


def _prefix_matches(name: str, key: str, inner: bool) -> bool:
    """Does `key` occur in the lower-cased job `name` as a leading word (or, when `inner`, as any word)?

    A key that ends in a non-alphanumeric ("ws-") matches wherever it starts; otherwise the character
    after it must not be a letter or digit ("plano" matches "plano - x" and "plano isd", not "planoville";
    "fxe" matches "fxe_agca"). Inner occurrences must start at a word boundary ("n crowley" but not
    "ncrowley").
    """
    if not key:
        return False
    positions = [0]
    if inner:
        positions += [i for i in range(1, len(name)) if not name[i - 1].isalnum()]
    for i in positions:
        if not name.startswith(key, i):
            continue
        end = i + len(key)
        if not key[-1].isalnum() or end == len(name) or not name[end].isalnum():
            return True
    return False


def sub_account_for(account: str | None, job_name: str | None, customer_name: str | None,
                    rules: dict[str, dict[str, Any]] | None = None) -> str:
    """The sub-account of a job in parent account `account` under `rules` (setting sub_account_rules).

    1. rules[account], else rules["*"], else {} (basis customer_name);
    2. a prefix_map key (longest first) that the lowercased job name starts with as a word - or, for
       the customer_name basis, contains as a word ("Plano - Wells", "Crowley ISD", "WS-Blue Haze",
       "FXE_AGCA") -> its label;
    3. basis customer_name and a non-empty customer name that is not the account name -> the customer;
    4. the rule's `default` when set, else the account name ("Unassigned" when the account is None).
    """
    rules = rules if rules is not None else DEFAULT_SUB_ACCOUNT_RULES
    account_label = (account or "").strip() or "Unassigned"
    rule = rules.get(account_label) or rules.get(ANY_ACCOUNT) or {}
    basis = str(rule.get("basis") or BASIS_CUSTOMER_NAME).strip().lower()
    name = (job_name or "").strip().lower()
    prefix_map = {str(k).strip().lower(): str(v or "").strip() for k, v in (rule.get("prefix_map") or {}).items()}
    inner = basis == BASIS_CUSTOMER_NAME
    for key in sorted(prefix_map, key=len, reverse=True):       # longest key first
        if key and prefix_map[key] and _prefix_matches(name, key, inner):
            return prefix_map[key]
    customer = (customer_name or "").strip()
    if basis == BASIS_CUSTOMER_NAME and customer and customer.lower() != account_label.lower():
        return customer
    default = str(rule.get("default") or "").strip()
    return default or account_label


# ── the rebuild ──────────────────────────────────────────────────────────────
JOB_WEEK_SQL = """
INSERT INTO mart.job_week (
  job_key, job_number, site_name, site_code, parent_account, company, delivery_model, week_start, month_shares,
  invoicing, invoicing_basis, hours, regular_hours, ot_hours, dt_hours, direct_dollars, ot_dollars,
  sub_dollars, sub_estimated, sub_basis, total_dollars, budget_hours, budget_dollars, budget_basis,
  labor_cost_basis, days_with_labor, rebuilt_at, invoicing_estimated, carry_forward_source
)
WITH jobs AS (
  SELECT j.job_key, j.job_number, j.job_name, pa.account_name AS parent_account, j.company, j.delivery_model
  FROM core.dim_job j
  LEFT JOIN core.dim_parent_account pa ON pa.parent_account_key = j.parent_account_key
  WHERE j.valid_to IS NULL AND j.job_number IS NOT NULL
),
tk AS (
  -- hours and straight-time dollars by job and Monday week; the OT premium is estimated at the row rate
  SELECT t.job_number, date_trunc('week', t.work_date)::date AS week_start,
         sum(coalesce(t.hours, 0)) AS hours,
         sum(coalesce(t.regular_hours, 0)) AS regular_hours,
         sum(coalesce(t.overtime_hours, 0)) AS ot_hours,
         sum(coalesce(t.double_time_hours, 0)) AS dt_hours,
         sum(coalesce(t.labor_cost, 0)) AS direct_dollars,
         sum(coalesce(t.overtime_hours, 0) * coalesce(t.rate, 0) * %(ot_premium)s::numeric
             + coalesce(t.double_time_hours, 0) * coalesce(t.rate, 0) * %(dt_premium)s::numeric) AS ot_dollars,
         count(DISTINCT t.work_date) AS days_with_labor,
         mode() WITHIN GROUP (ORDER BY t.labor_cost_basis) AS labor_cost_basis,
         mode() WITHIN GROUP (ORDER BY t.company) AS company
  FROM mart.v_timekeeping_effective t
  WHERE t.job_number IS NOT NULL AND t.work_date IS NOT NULL
  GROUP BY t.job_number, date_trunc('week', t.work_date)
),
jm AS (
  SELECT job_number, month, revenue, revenue_basis, subcontract_cost, budget_labor, hours
  FROM mart.job_month
),
closed_months AS (
  -- months mart.job_month reports on the closed job-cost basis
  SELECT DISTINCT month FROM mart.job_month WHERE revenue_basis = 'job_cost'
),
ar AS (
  SELECT job_number, service_month AS month, sum(coalesce(revenue_total, 0)) AS revenue
  FROM mart.v_ar_invoice_effective
  WHERE service_month IS NOT NULL AND job_number IS NOT NULL
  GROUP BY 1, 2
),
lb AS (
  SELECT job_number, month, sum(budget_labor) AS budget_labor, sum(budget_hours) AS budget_hours
  FROM core.fact_labor_budget_month
  GROUP BY 1, 2
),
db AS (
  SELECT job_number, budget_date, sum(budgeted_dollars) AS dollars, sum(budgeted_hours) AS hours
  FROM core.fact_daily_budget
  GROUP BY 1, 2
),
db_cov AS (
  SELECT job_number, date_trunc('month', budget_date)::date AS month, min(budget_date) AS lo, max(budget_date) AS hi
  FROM core.fact_daily_budget
  GROUP BY 1, 2
),
cb AS (
  SELECT job_number, effective_month, monthly_amount FROM core.contract_billing
),
agency_sites AS (
  SELECT key AS site, value AS job_number FROM jsonb_each_text(%(site_jobs)s::jsonb)
),
ap_sub AS (
  -- agency labor: the vendor's AP invoices coded to a site by invoice-number prefix, x pct, by invoice month
  SELECT s.job_number, date_trunc('month', i.invoice_date)::date AS month,
         sum(coalesce(i.invoice_amount, 0)) * %(agency_pct)s::numeric AS sub
  FROM mart.v_ap_invoice_effective i
  CROSS JOIN LATERAL (
    SELECT a.job_number
    FROM agency_sites a
    WHERE upper(i.invoice_number) LIKE upper(a.site) || '%%'
       OR upper(i.invoice_number) LIKE upper(regexp_replace(a.site, '[^A-Za-z]', '', 'g')) || '0%%'
    ORDER BY (upper(i.invoice_number) LIKE upper(a.site) || '%%') DESC
    LIMIT 1
  ) s
  WHERE %(agency_enabled)s
    AND i.invoice_date IS NOT NULL
    AND lower(coalesce(i.vendor_name, '')) LIKE %(vendor_like)s
  GROUP BY 1, 2
),
sub_known AS (
  SELECT j.job_number, j.month, coalesce(j.subcontract_cost, 0) AS sub, 'job_cost' AS basis
  FROM jm j JOIN closed_months c ON c.month = j.month
  UNION ALL
  SELECT job_number, month, sub, 'agency_ap' FROM ap_sub
),
sub_month AS (
  -- one known cost per job-month: a booked (non-zero) figure first, the job-cost line before the agency allocation
  SELECT DISTINCT ON (job_number, month) job_number, month, sub, basis
  FROM sub_known
  ORDER BY job_number, month, (sub <> 0) DESC, (basis = 'job_cost') DESC
),
month_keys AS (
  SELECT job_number, month FROM jm WHERE revenue <> 0 OR subcontract_cost <> 0 OR budget_labor IS NOT NULL OR hours <> 0
  UNION SELECT job_number, month FROM ar
  UNION SELECT job_number, month FROM lb
  UNION SELECT job_number, month FROM db_cov
  UNION SELECT job_number, month FROM ap_sub
),
week_keys AS (
  SELECT job_number, week_start FROM tk
  UNION
  SELECT m.job_number, w.week_start::date
  FROM month_keys m
  CROSS JOIN LATERAL generate_series(date_trunc('week', m.month), m.month + interval '1 month' - interval '1 day', interval '7 days') AS w(week_start)
),
slices AS (
  -- one slice per calendar month the week overlaps
  SELECT k.job_number, k.week_start, m.month,
         greatest(k.week_start, m.month) AS s_start,
         least(k.week_start + 6, (m.month + interval '1 month' - interval '1 day')::date) AS s_end,
         extract(day FROM (m.month + interval '1 month' - interval '1 day'))::int AS days_in_month
  FROM week_keys k
  CROSS JOIN LATERAL (
    SELECT DISTINCT date_trunc('month', v.d)::date AS month
    FROM (VALUES (k.week_start), (k.week_start + 6)) v(d)
  ) m
  WHERE k.week_start <= current_date
),
slice_values AS (
  SELECT s.job_number, s.week_start, s.month, s.days_in_month,
         (s.s_end - s.s_start + 1) AS days,
         -- invoicing: closed job-cost revenue -> contract (12/53) -> AR service month -> carry-forward -> none
         CASE WHEN c.month IS NOT NULL AND jm.revenue_basis = 'job_cost' AND coalesce(jm.revenue, 0) <> 0 THEN 'job_cost_month_prorated'
              WHEN cbx.monthly_amount IS NOT NULL THEN 'contract'
              WHEN coalesce(ar.revenue, 0) <> 0 THEN 'ar_invoice_prorated'
              WHEN cf.revenue IS NOT NULL THEN 'carry_forward'
              ELSE 'none' END AS invoicing_basis,
         CASE WHEN c.month IS NOT NULL AND jm.revenue_basis = 'job_cost' AND coalesce(jm.revenue, 0) <> 0
                THEN jm.revenue * (s.s_end - s.s_start + 1) / s.days_in_month
              WHEN cbx.monthly_amount IS NOT NULL
                THEN cbx.monthly_amount * 12.0 / 53.0 * (s.s_end - s.s_start + 1) / 7.0
              WHEN coalesce(ar.revenue, 0) <> 0
                THEN ar.revenue * (s.s_end - s.s_start + 1) / s.days_in_month
              WHEN cf.revenue IS NOT NULL
                THEN cf.revenue * (s.s_end - s.s_start + 1) / s.days_in_month
              ELSE 0 END AS invoicing,
         (NOT (c.month IS NOT NULL AND jm.revenue_basis = 'job_cost' AND coalesce(jm.revenue, 0) <> 0)
          AND cbx.monthly_amount IS NULL AND coalesce(ar.revenue, 0) = 0 AND cf.revenue IS NOT NULL) AS invoicing_estimated,
         CASE WHEN NOT (c.month IS NOT NULL AND jm.revenue_basis = 'job_cost' AND coalesce(jm.revenue, 0) <> 0)
               AND cbx.monthly_amount IS NULL AND coalesce(ar.revenue, 0) = 0 AND cf.revenue IS NOT NULL
              THEN cf.source END AS carry_forward_source,
         -- subcontract: known month figure -> closed month without one = 0 -> project the trailing closed-month weekly rate
         CASE WHEN sm.job_number IS NOT NULL THEN sm.basis
              WHEN c.month IS NOT NULL THEN 'job_cost'
              WHEN trail.months > 0 THEN 'trailing_3mo_projection'
              ELSE 'none' END AS sub_basis,
         CASE WHEN sm.job_number IS NOT NULL THEN sm.sub * (s.s_end - s.s_start + 1) / s.days_in_month
              WHEN c.month IS NOT NULL THEN 0
              WHEN trail.months > 0 THEN trail.weekly * (s.s_end - s.s_start + 1) / 7.0
              ELSE 0 END AS sub_dollars,
         -- the monthly figure the slice was apportioned from (the projected month = weekly rate x days_in_month / 7)
         CASE WHEN sm.job_number IS NOT NULL THEN sm.sub
              WHEN c.month IS NOT NULL THEN 0
              WHEN trail.months > 0 THEN trail.weekly * s.days_in_month / 7.0
              ELSE 0 END AS sub_month,
         (sm.job_number IS NULL AND c.month IS NULL AND trail.months > 0) AS sub_estimated,
         -- budget: daily rows covering the slice -> monthly labor budget x day share -> none
         CASE WHEN cov.job_number IS NOT NULL AND cov.lo <= s.s_start AND cov.hi >= s.s_end THEN 'daily_budget'
              WHEN lb.budget_labor IS NOT NULL OR lb.budget_hours IS NOT NULL THEN 'hbc'
              ELSE 'none' END AS budget_basis,
         CASE WHEN cov.job_number IS NOT NULL AND cov.lo <= s.s_start AND cov.hi >= s.s_end THEN coalesce(dbw.dollars, 0)
              WHEN lb.budget_labor IS NOT NULL THEN lb.budget_labor * (s.s_end - s.s_start + 1) / s.days_in_month
              END AS budget_dollars,
         CASE WHEN cov.job_number IS NOT NULL AND cov.lo <= s.s_start AND cov.hi >= s.s_end THEN coalesce(dbw.hours, 0)
              WHEN lb.budget_hours IS NOT NULL THEN lb.budget_hours * (s.s_end - s.s_start + 1) / s.days_in_month
              END AS budget_hours
  FROM slices s
  LEFT JOIN jm ON jm.job_number = s.job_number AND jm.month = s.month
  LEFT JOIN closed_months c ON c.month = s.month
  LEFT JOIN ar ON ar.job_number = s.job_number AND ar.month = s.month
  LEFT JOIN LATERAL (
    SELECT monthly_amount FROM cb
    WHERE cb.job_number = s.job_number AND cb.effective_month <= s.month
    ORDER BY cb.effective_month DESC LIMIT 1
  ) cbx ON true
  LEFT JOIN LATERAL (
    -- carry-forward source: the job's most recent month, among the last N closed months before the slice, with job-cost
    -- or AR service-month revenue; the greater of the two is carried (job_cost wins ties)
    SELECT greatest(coalesce(j.revenue, 0), coalesce(a.revenue, 0)) AS revenue,
           CASE WHEN coalesce(j.revenue, 0) >= coalesce(a.revenue, 0) THEN 'job_cost' ELSE 'ar_invoice' END AS source
    FROM (SELECT cm.month FROM closed_months cm WHERE cm.month < s.month ORDER BY cm.month DESC LIMIT %(carry_months)s) recent
    LEFT JOIN jm j ON j.job_number = s.job_number AND j.month = recent.month AND j.revenue_basis = 'job_cost'
    LEFT JOIN ar a ON a.job_number = s.job_number AND a.month = recent.month
    WHERE coalesce(j.revenue, 0) > 0 OR coalesce(a.revenue, 0) > 0
    ORDER BY recent.month DESC LIMIT 1
  ) cf ON true
  LEFT JOIN sub_month sm ON sm.job_number = s.job_number AND sm.month = s.month
  LEFT JOIN LATERAL (
    -- projection source: the job's job-cost months among the last N closed months before the slice's month;
    -- weekly = the average over those months of subcontractors / days_in_month x 7 (a booked 0 counts, a missing month does not)
    SELECT count(j.job_number) AS months,
           avg(coalesce(j.subcontract_cost, 0) / extract(day FROM (recent.month + interval '1 month' - interval '1 day')) * 7.0) AS weekly
    FROM (SELECT cm.month FROM closed_months cm WHERE cm.month < s.month ORDER BY cm.month DESC LIMIT %(trailing_months)s) recent
    JOIN jm j ON j.job_number = s.job_number AND j.month = recent.month AND j.revenue_basis = 'job_cost'
  ) trail ON true
  LEFT JOIN db_cov cov ON cov.job_number = s.job_number AND cov.month = s.month
  LEFT JOIN LATERAL (
    SELECT sum(d.dollars) AS dollars, sum(d.hours) AS hours
    FROM db d WHERE d.job_number = s.job_number AND d.budget_date BETWEEN s.s_start AND s.s_end
  ) dbw ON true
  LEFT JOIN lb ON lb.job_number = s.job_number AND lb.month = s.month
),
weeks AS (
  SELECT job_number, week_start,
         sum(invoicing) AS invoicing,
         (array_agg(invoicing_basis ORDER BY (invoicing_basis <> 'none') DESC, days DESC, month))[1] AS invoicing_basis,
         bool_or(invoicing_estimated) AS invoicing_estimated,
         (array_agg(carry_forward_source ORDER BY (carry_forward_source IS NOT NULL) DESC, days DESC, month))[1] AS carry_forward_source,
         sum(sub_dollars) AS sub_dollars,
         bool_or(sub_estimated) AS sub_estimated,
         (array_agg(sub_basis ORDER BY (sub_basis <> 'none') DESC, days DESC, month))[1] AS sub_basis,
         sum(budget_dollars) AS budget_dollars,
         sum(budget_hours) AS budget_hours,
         (array_agg(budget_basis ORDER BY (budget_basis <> 'none') DESC, days DESC, month))[1] AS budget_basis,
         jsonb_object_agg(month::text, jsonb_build_object(
           'days', days, 'invoicing_basis', invoicing_basis, 'invoicing_estimated', invoicing_estimated,
           'carry_forward_source', carry_forward_source,
           'budget_basis', budget_basis, 'sub_basis', sub_basis, 'sub_estimated', sub_estimated,
           'sub_month', round(sub_month::numeric, 2))) AS month_shares
  FROM slice_values
  GROUP BY job_number, week_start
)
SELECT
  jb.job_key, w.job_number, jb.job_name,
  CASE WHEN position(' - ' IN coalesce(jb.job_name, '')) > 0
       THEN btrim(substr(jb.job_name, position(' - ' IN jb.job_name) + 3)) ELSE jb.job_name END,
  jb.parent_account, coalesce(jb.company, tk.company), jb.delivery_model, w.week_start, w.month_shares,
  round(w.invoicing, 2), w.invoicing_basis,
  coalesce(tk.hours, 0), coalesce(tk.regular_hours, 0), coalesce(tk.ot_hours, 0), coalesce(tk.dt_hours, 0),
  round(coalesce(tk.direct_dollars, 0), 2), round(coalesce(tk.ot_dollars, 0), 2),
  round(w.sub_dollars, 2), coalesce(w.sub_estimated, false), w.sub_basis,
  -- direct_dollars is all-in payroll (trailing payroll rate already carries the OT premium), so the OT
  -- premium estimate is informational and NOT added: total = labor + vendor, as the executives' original.
  round(coalesce(tk.direct_dollars, 0), 2) + round(w.sub_dollars, 2),
  round(w.budget_hours, 2), round(w.budget_dollars, 2), w.budget_basis,
  tk.labor_cost_basis, coalesce(tk.days_with_labor, 0), now(), coalesce(w.invoicing_estimated, false), w.carry_forward_source
FROM weeks w
JOIN jobs jb ON jb.job_number = w.job_number
LEFT JOIN tk ON tk.job_number = w.job_number AND tk.week_start = w.week_start
"""


def _setting(cursor: Any, key: str, default: Any) -> Any:
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = %s", (key,))
    row = cursor.fetchone()
    if row is None:
        return default
    value = row["value"] if isinstance(row, dict) else row[0]
    return default if value is None else value


def rebuild(cursor: Any) -> int:
    """TRUNCATE and rebuild mart.job_week on the caller's cursor/transaction; returns the row count.

    Reads ops.app_setting.agency_sub for the agency labor rule and sub_account_rules for the
    sub-account labels (apply_sub_accounts). Runs after mart.job_month and
    mart.portfolio_month are rebuilt because the closed-month revenue / subcontract / budget figures
    come from mart.job_month.
    """
    agency = agency_sub_setting(_setting(cursor, "agency_sub", DEFAULT_AGENCY_SUB))
    cursor.execute("TRUNCATE mart.job_week")
    cursor.execute(
        JOB_WEEK_SQL,
        {
            "ot_premium": OT_PREMIUM,
            "dt_premium": DT_PREMIUM,
            "site_jobs": json.dumps(agency["site_jobs"] if agency["enabled"] else {}),
            "agency_pct": agency["pct"],
            "agency_enabled": agency["enabled"],
            "vendor_like": f"%{agency['vendor_match']}%",
            "carry_months": CARRY_FORWARD_CLOSED_MONTHS,
            "trailing_months": TRAILING_SUB_MONTHS,
        },
    )
    rows = cursor.rowcount
    labelled = apply_sub_accounts(cursor)
    logger.info("mart.job_week rebuilt: %s rows (agency_sub %s; %s job(s) labelled with a sub-account)",
                rows, "on" if agency["enabled"] else "off", labelled)
    return rows


SUB_ACCOUNT_JOBS_SQL = """
SELECT j.job_key, j.job_name, j.customer_name, pa.account_name AS parent_account
FROM core.dim_job j
JOIN core.dim_parent_account pa ON pa.parent_account_key = j.parent_account_key
WHERE j.valid_to IS NULL AND j.job_number IS NOT NULL
"""

SUB_ACCOUNT_UPDATE_SQL = """
UPDATE mart.job_week w
SET sub_account = m.sub_account
FROM unnest(%(job_keys)s::bigint[], %(labels)s::text[]) AS m(job_key, sub_account)
WHERE w.job_key = m.job_key
"""

# migration 018: the monthly mart carries the same label so the reporting scope can drill into it
SUB_ACCOUNT_MONTH_UPDATE_SQL = """
UPDATE mart.job_month j
SET sub_account = m.sub_account
FROM unnest(%(job_keys)s::bigint[], %(labels)s::text[]) AS m(job_key, sub_account)
WHERE j.job_key = m.job_key
"""


def apply_sub_accounts(cursor: Any) -> int:
    """Label every mart.job_week AND mart.job_month row with its job's sub-account (setting
    sub_account_rules); returns the job count.

    Runs inside `rebuild` on the same transaction: a Python pass over the current core.dim_job rows
    that have a parent account, written back with one UPDATE per mart joined on job_key. The two
    marts get identical labels from the one pass, so the executive weekly view and the reporting
    scope (MartFilters.sub_account) always agree. Rows of jobs without a parent account keep
    sub_account NULL.
    """
    rules = sub_account_rules_setting(_setting(cursor, "sub_account_rules", None))
    cursor.execute(SUB_ACCOUNT_JOBS_SQL)
    jobs = cursor.fetchall()
    keys: list[int] = []
    labels: list[str] = []
    for job in jobs:
        rec = job if isinstance(job, dict) else {"job_key": job[0], "job_name": job[1], "customer_name": job[2], "parent_account": job[3]}
        keys.append(int(rec["job_key"]))
        labels.append(sub_account_for(rec["parent_account"], rec["job_name"], rec["customer_name"], rules))
    if keys:
        cursor.execute(SUB_ACCOUNT_UPDATE_SQL, {"job_keys": keys, "labels": labels})
        cursor.execute(SUB_ACCOUNT_MONTH_UPDATE_SQL, {"job_keys": keys, "labels": labels})
    return len(keys)


def summarize_bases(rows: Sequence[dict[str, Any]], field: str) -> dict[str, int]:
    """{basis: row count} for a basis column over the given rows (used by the router's notes)."""
    counts: dict[str, int] = {}
    for r in rows:
        counts[str(r.get(field) or BASIS_NONE)] = counts.get(str(r.get(field) or BASIS_NONE), 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: -kv[1]))
