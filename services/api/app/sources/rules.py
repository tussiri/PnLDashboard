"""Pure derivation rules for the finance reference source (no database, no I/O).

Everything the loader decides that is not a straight column copy lives here so it can be unit
tested with fixture dicts: company aliasing and namespaces, account-group matching, the AR
collectible rule, aging bucket mapping, the trailing job labor rate, the hours-budget-comparison
de-duplication rule, and the AR register -> invoice aggregation. Each function documents the rule
it implements and the evidence (from the restored dump) that justified it.
"""
from __future__ import annotations

import re
from datetime import date, datetime, time
from typing import Any, Iterable, Mapping, Sequence

from ..config import CANADIAN_PROVINCES

# ── companies ────────────────────────────────────────────────────────────────
# Raw WinTeam company names as they appear in the exports -> dashboard labels. The ops.app_setting
# `company_aliases` value (seeded by migration 005) takes precedence; these defaults also cover the
# import-batch level names ('Crane', 'Sarus') that the older exports carry instead of a legal entity.
DEFAULT_COMPANY_ALIASES: dict[str, str] = {
    "ServiceMaster by Crane IFS": "Crane IFS",
    "Crane Integrated Facility Services Inc.": "Crane IFS",
    "Crane Integrated Facilities Services Inc.": "Crane IFS",
    "Crane West Opco LLC": "Crane West",
    "Crane Southwest Opco LLC": "Crane Southwest",
    "ServiceMaster by Sarus Co": "Sarus",
    "Sarus Co LLC": "Sarus",
    "Crane": "Crane IFS",
    "Sarus": "Sarus",
}

# The two WinTeam databases behind the exports. Job numbers, invoice numbers, customer numbers and
# vendor numbers are only unique WITHIN a database, so every identity is namespaced by it.
NAMESPACE_CRANE = "Crane"
NAMESPACE_SARUS = "Sarus"

# Sarus vendor numbers collide with Crane's (vendor 1064 is "Michigan State Disbursement Unit" in
# Crane and "Ridley's Vacuum & Janitorial Supply" in Sarus). core.dim_vendor keys vendors by an
# integer vendor_number (the WinTeam API contract), so Sarus vendors are offset in the warehouse.
SARUS_VENDOR_OFFSET = 1_000_000


def normalise_aliases(setting: Any) -> dict[str, str]:
    """Merge the `company_aliases` setting over the defaults (case-insensitive keys)."""
    merged: dict[str, str] = {k.strip().lower(): v for k, v in DEFAULT_COMPANY_ALIASES.items()}
    if isinstance(setting, dict):
        for key, value in setting.items():
            if isinstance(key, str) and isinstance(value, str) and key.strip() and value.strip():
                merged[key.strip().lower()] = value.strip()
    return merged


def alias_company(raw: str | None, aliases: Mapping[str, str] | None = None) -> str | None:
    """Dashboard company label for a raw WinTeam company name (None when unknown/blank).

    Unknown names pass through unchanged so a new legal entity is visible rather than hidden.
    """
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    table = aliases if aliases is not None else normalise_aliases(None)
    return table.get(text.lower(), text)


def namespace_for(raw_company: str | None) -> str:
    """Which WinTeam database a raw company / batch name belongs to ('Sarus' or 'Crane')."""
    text = (raw_company or "").lower()
    return NAMESPACE_SARUS if "sarus" in text else NAMESPACE_CRANE


def namespaced_job_number(namespace: str, job_number: str) -> str:
    """dim_job.job_number of a job whose bare number belongs to the OTHER database in the warehouse
    ('Crane:300' when the reference load keeps 300 for the Sarus job). Same convention as the
    namespaced AR / vendor identities above: the namespace label first, then the number."""
    return f"{namespace}:{job_number}"


def warehouse_vendor_number(namespace: str, vendor_number: int) -> int:
    """Integer vendor number stored in the warehouse (Sarus vendors are offset; see above)."""
    return vendor_number + SARUS_VENDOR_OFFSET if namespace == NAMESPACE_SARUS else vendor_number


# ── geography ────────────────────────────────────────────────────────────────
# Fallback regions when a job has no Tier 3 (region) in the job master. The vocabulary follows the
# tenant's own tier values (Southeast / Southwest / West / Midwest / Northeast) plus Canada.
_REGION_BY_STATE: dict[str, str] = {}
for _state in ("CT", "ME", "MA", "NH", "RI", "VT", "NJ", "NY", "PA"):
    _REGION_BY_STATE[_state] = "Northeast"
for _state in ("IL", "IN", "MI", "OH", "WI", "IA", "KS", "MN", "MO", "NE", "ND", "SD"):
    _REGION_BY_STATE[_state] = "Midwest"
for _state in ("DE", "MD", "DC", "VA", "WV", "NC", "SC", "GA", "FL", "KY", "TN", "AL", "MS"):
    _REGION_BY_STATE[_state] = "Southeast"
for _state in ("AR", "LA", "OK", "TX", "AZ", "NM"):
    _REGION_BY_STATE[_state] = "Southwest"
for _state in ("CO", "ID", "MT", "NV", "UT", "WY", "AK", "CA", "HI", "OR", "WA"):
    _REGION_BY_STATE[_state] = "West"


def region_for_state(state: str | None) -> str | None:
    if not state:
        return None
    code = state.strip().upper()
    if code in CANADIAN_PROVINCES:
        return "Canada"
    return _REGION_BY_STATE.get(code)


def country_for_state(state: str | None) -> str:
    return "CA" if state and state.strip().upper() in CANADIAN_PROVINCES else "US"


def centroid_key(city: str | None, state: str | None) -> str | None:
    """Key into sources/geo/city_centroids.json: 'City|ST'."""
    if not city or not state:
        return None
    return f"{city.strip()}|{state.strip().upper()}"


# ── parsing helpers for the export strings ───────────────────────────────────
_US_DATE = re.compile(r"^\s*(\d{1,2})/(\d{1,2})/(\d{4})(?:\s+.*)?$")
_ISO_DATE = re.compile(r"^\s*(\d{4})-(\d{2})-(\d{2})")
_HHMM = re.compile(r"^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$")


def parse_export_date(value: Any) -> date | None:
    """'8/10/2026', '8/10/2026 3:00:11 AM' or ISO -> date; None when blank or unparseable."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value)
    match = _US_DATE.match(text)
    if match:
        month, day, year = (int(g) for g in match.groups())
        try:
            return date(year, month, day)
        except ValueError:
            return None
    match = _ISO_DATE.match(text)
    if match:
        try:
            return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            return None
    return None


def parse_export_time(value: Any) -> time | None:
    """'15:25' -> time(15, 25); None when blank or unparseable."""
    if value is None:
        return None
    match = _HHMM.match(str(value))
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    second = int(match.group(3) or 0)
    if hour > 23 or minute > 59 or second > 59:
        return None
    return time(hour, minute, second)


def parse_number(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_flag(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"true", "1", "yes", "y", "t"}:
        return True
    if text in {"false", "0", "no", "n", "f"}:
        return False
    return None


def period_to_month(period_id: int | str | None) -> date | None:
    """202607 -> date(2026, 7, 1)."""
    if period_id is None:
        return None
    try:
        value = int(period_id)
    except (TypeError, ValueError):
        return None
    year, month = divmod(value, 100)
    if not 1 <= month <= 12 or year < 1900:
        return None
    return date(year, month, 1)


# ── account groups / parent accounts ─────────────────────────────────────────
def _terms(group: Mapping[str, Any], key: str) -> list[str]:
    values = group.get(key) or []
    return [str(v).strip().lower() for v in values if str(v).strip()]


def match_account_group(
    *,
    job_number: str,
    job_name: str | None,
    customer_names: Iterable[str | None],
    groups: Sequence[Mapping[str, Any]],
    override: str | None = None,
) -> str | None:
    """First account group (in configured order) whose rules match the job.

    Rules, all case-insensitive contains: any `terms` entry in the job name, the job number in
    `job_numbers`, or any `customer_terms` entry in one of the job's AR customer names. A
    `job_account_overrides.assigned_account_group` value wins outright. Groups with no rules at
    all (the catch-all 'Other') never match, so the caller can fall back to the AR customer.
    """
    if override and str(override).strip():
        return str(override).strip()
    name = (job_name or "").lower()
    number = str(job_number).strip().lower()
    customers = [str(c).lower() for c in customer_names if c]
    for group in groups:
        group_name = str(group.get("name") or "").strip()
        if not group_name:
            continue
        terms = _terms(group, "terms")
        numbers = [str(n).strip().lower() for n in (group.get("job_numbers") or []) if str(n).strip()]
        customer_terms = _terms(group, "customer_terms")
        if not (terms or numbers or customer_terms):
            continue
        if any(term in name for term in terms):
            return group_name
        if number in numbers:
            return group_name
        if any(term in customer for term in customer_terms for customer in customers):
            return group_name
    return None


def match_vertical(job_name: str | None, customer_names: Iterable[str | None], verticals: Sequence[Mapping[str, Any]]) -> str | None:
    """First platform_config vertical whose `match` regex hits the job name or a customer name."""
    haystacks = [job_name or "", *[c for c in customer_names if c]]
    for vertical in verticals:
        name = str(vertical.get("name") or "").strip()
        pattern = str(vertical.get("match") or "").strip()
        if not name or not pattern:
            continue
        try:
            regex = re.compile(pattern, re.IGNORECASE)
        except re.error:
            continue
        if any(regex.search(text) for text in haystacks):
            return name
    return None


# ── AR collectibility ────────────────────────────────────────────────────────
def is_collectible(customer_name: str | None, parent_customer_name: str | None, rules: Sequence[Mapping[str, Any]]) -> bool:
    """False when an ar_treatment_rules entry with include_collectible_ar=false matches the customer.

    The tenant's rule ("ServiceMaster|Service Master|Elite| FM ") flags intercompany / settlement
    balances that clear through AP offsets rather than cash collection. It is applied to the
    billed customer's name; the parent customer is only consulted when the customer name is blank
    (FedEx invoices carry the franchisor "ServiceMaster Clean National Accounts" as parent but are
    collected from FedEx).
    """
    names = [customer_name] if customer_name else [parent_customer_name]
    names = [n for n in names if n]
    for rule in rules:
        if rule.get("include_collectible_ar", False):
            continue
        pattern = str(rule.get("match") or "")
        if not pattern:
            continue
        try:
            regex = re.compile(pattern, re.IGNORECASE)
        except re.error:
            continue
        if any(regex.search(name) for name in names):
            return False
    return True


# ── aging buckets ────────────────────────────────────────────────────────────
AR_BUCKET_COLUMNS = ("bucket_current", "bucket_1_30", "bucket_31_60", "bucket_61_90", "bucket_90_plus")


def ar_bucket_from_groups(row: Mapping[str, Any]) -> str | None:
    """Which aging bucket an AR aging row sits in, from the WinTeam group0..group4 amounts.

    Verified on every snapshot in the dump: group1 rows have days_out 0-29, group2 31-60,
    group3 61-90, group4 94+; group0 (not yet due) is never populated for this tenant, whose
    invoices age from the invoice date. past_due_days is always 0 and is ignored.
    """
    for index, column in enumerate(AR_BUCKET_COLUMNS):
        amount = parse_number(row.get(f"group{index}"))
        if amount:
            return column
    return None


def ar_bucket_for_days(days_out: int | None) -> str:
    """Bucket by invoice age, used when the group amounts are all zero (fully applied rows)."""
    if days_out is None or days_out <= 0:
        return "bucket_current"
    if days_out <= 30:
        return "bucket_1_30"
    if days_out <= 60:
        return "bucket_31_60"
    if days_out <= 90:
        return "bucket_61_90"
    return "bucket_90_plus"


def ap_buckets(row: Mapping[str, Any]) -> dict[str, float]:
    """AP vendor aging group1..group4 -> warehouse buckets.

    The AP export has four groups keyed on days past due (group1 = -57..30, group2 = 31-60,
    group3 = 61-90, group4 = 92+ in the dump). group1 is split by days_past_due so the "not yet
    due" part lands in bucket_current and the 1-30 days past due part in bucket_1_30.
    """
    days = parse_number(row.get("days_past_due"))
    g1 = parse_number(row.get("group1")) or 0.0
    out = {column: 0.0 for column in AR_BUCKET_COLUMNS}
    if days is not None and days > 0:
        out["bucket_1_30"] = g1
    else:
        out["bucket_current"] = g1
    out["bucket_31_60"] = parse_number(row.get("group2")) or 0.0
    out["bucket_61_90"] = parse_number(row.get("group3")) or 0.0
    out["bucket_90_plus"] = parse_number(row.get("group4")) or 0.0
    return out


# ── trailing job labor rate ──────────────────────────────────────────────────
TRAILING_RATE_MONTHS = 3


def trailing_rate(
    job_months: Sequence[Mapping[str, Any]],
    *,
    company_rate: float | None,
    portfolio_rate: float | None,
    months: int = TRAILING_RATE_MONTHS,
) -> tuple[float | None, str]:
    """(rate, basis) for a job: sum(direct_labor) / sum(actual_hours) over its last `months`
    closed job-cost months with hours > 0 and labor > 0; else the company average computed the
    same way; else the portfolio average; else None.

    `job_months` rows carry month, direct_labor, actual_hours, closed.
    """
    usable = [
        r for r in job_months
        if r.get("closed") and (parse_number(r.get("actual_hours")) or 0) > 0 and (parse_number(r.get("direct_labor")) or 0) > 0
    ]
    usable.sort(key=lambda r: r["month"], reverse=True)
    recent = usable[:months]
    hours = sum(parse_number(r.get("actual_hours")) or 0 for r in recent)
    labor = sum(parse_number(r.get("direct_labor")) or 0 for r in recent)
    if hours > 0 and labor > 0:
        return labor / hours, "job"
    if company_rate and company_rate > 0:
        return company_rate, "company"
    if portfolio_rate and portfolio_rate > 0:
        return portfolio_rate, "portfolio"
    return None, "none"


# ── hours budget comparison de-duplication ───────────────────────────────────
def hbc_job_budget(rows: Sequence[Mapping[str, Any]]) -> tuple[float | None, float | None, bool]:
    """(budget_labor, budget_hours, consistent) for one (namespace, job, period) group of HBC rows.

    Rule: the job's monthly labor budget (`bud_labor_dollars`) is carried on ONE row of the job's
    employee rows (the others carry 0), never repeated per employee, so the job budget is the
    maximum value. Verified on 202601-202607: sum == max for all 525 job-months that also have
    a daily-budget export, and 376 of them match the daily budget to the dollar. `consistent`
    is False when the rows disagree with that rule (more than one distinct non-zero value), so
    the loader can count and disclose such cases instead of silently summing.
    """
    values = [parse_number(r.get("bud_labor_dollars")) or 0.0 for r in rows]
    non_zero = sorted({round(v, 2) for v in values if v})
    budget = max(values) if values else None
    hours_values = [parse_number(r.get("total_daily_budgeted_hours")) or 0.0 for r in rows]
    hours = max(hours_values) if hours_values else None
    consistent = len(non_zero) <= 1
    return (budget if budget else None), (hours if hours else None), consistent


# ── AR register -> invoice aggregation ───────────────────────────────────────
_REGISTER_MAX_FIELDS = ("invoice_total", "revenue_total", "tax")


def aggregate_register_rows(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Collapse the register rows of one (namespace, invoice_number) into one invoice.

    The register export repeats an invoice once per distribution line: the header line carries
    invoice_total / revenue_total / tax and the detail lines carry `dist_amount` with the totals
    as 0. The same invoice can also appear in two export batches. So totals are the MAX over the
    rows (never the sum), header attributes are the first non-blank value, and `dist_total` is
    the sum of the distribution amounts for reconciliation (equal to invoice_total on 231 of the
    238 multi-line invoices in the dump; the rest have no distribution lines at all).
    """
    def first(field: str) -> Any:
        for row in rows:
            value = row.get(field)
            if value not in (None, ""):
                return value
        return None

    out: dict[str, Any] = {
        "invoice_number": first("invoice_number"),
        "customer_number": first("customer_number"),
        "customer_name": first("customer_name"),
        "parent_customer_number": first("parent_customer_number"),
        "parent_customer_name": first("parent_customer_name"),
        "job_number": first("service_location_job_number"),
        "service_location_name": first("service_location_name"),
        "invoice_date": parse_export_date(first("invoice_date")),
        "posting_date": parse_export_date(first("posting_date")),
        "billing_period_from": parse_export_date(first("billing_period_from")),
        "billing_period_to": parse_export_date(first("billing_period_to")),
        "purchase_order_number": first("purchase_order_number"),
        "company_name": first("company_name"),
        "state": first("state"),
        "rows": len(rows),
    }
    for field in _REGISTER_MAX_FIELDS:
        values = [parse_number(r.get(field)) for r in rows]
        numbers = [v for v in values if v is not None]
        out[field] = max(numbers) if numbers else None
    dist = [parse_number(r.get("dist_amount")) for r in rows]
    dist_numbers = [v for v in dist if v is not None]
    out["dist_total"] = sum(dist_numbers) if dist_numbers else None
    out["service_month"] = (out["billing_period_from"] or out["invoice_date"])
    if out["service_month"] is not None:
        out["service_month"] = out["service_month"].replace(day=1)
    return out


def open_balance_from_snapshot(invoice_total: float | None, amount_due: float | None) -> tuple[float | None, str]:
    """(amount_paid, basis): invoice_total - amount_due when the invoice is in the latest aging
    snapshot ('aging_snapshot'); otherwise the invoice is assumed fully paid ('assumed_paid')."""
    total = invoice_total or 0.0
    if amount_due is None:
        return total, "assumed_paid"
    return total - amount_due, "aging_snapshot"
