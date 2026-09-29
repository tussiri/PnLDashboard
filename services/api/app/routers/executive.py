"""Executive routes: the weekly labor P&L (mart.job_week) and the account selector.

`GET /executive/labor-pl?account=All|<parent_account>&sub_account=<name>&delivery=all|self_perform|subcontracted
&weeks=18&week=YYYY-MM-DD` returns one row per (week, site) with every value already apportioned to
the week (docs/api-contract.md, "Executive labor P&L (weekly)" and "Executive slicing"; derivations
in app/weekly.py and docs/executive-pl.md). The browser derives the BU roll-ups, labor % of
invoicing and week-over-week deltas from the rows.

* `sub_account` narrows the scope to one mart.job_week.sub_account label (migration 014; the
  labels per account come from /executive/accounts). `delivery` narrows it by delivery model; a
  row whose job has no delivery_model counts as self_perform when it has hours, else subcontracted
  (DELIVERY_SQL), and the notes say so.

* `weeks` (default 18) is the window of Monday weeks ending at the latest week with labor in the
  requested scope; when `week` lies outside that window the window ends at `week` instead.
* `selected_week` defaults to the latest week in scope whose days_with_labor = 7 (a full week).
* `business_units` come from the settings bu_targets / bu_colors plus any company present in the
  rows that is not configured (null targets), listed in the order of the `bu_order` setting
  (unknown units appended alphabetically) with a 1-based `sort_order`.
* `notes` list every derivation and estimate behind the numbers, including the invoicing / budget /
  subcontract basis mix of the selected week, so the page can disclose them.
* `vendor` (docs/api-contract.md "Vendor cost: projection and live AP look") describes the vendor
  cost of the selected week's dominant month: its status (common.month_status_rows), the projected
  month subcontract cost over the sites in scope (the sum of the monthly figures the selected
  week's slices were apportioned from: the job-cost line when the month is closed, the agency
  allocation, else the trailing-3-closed-months projection - `build_vendor_block`), the live AP
  look (`ap_live`: AP invoices dated in the month, up to as_of, of vendors matching the setting
  `subcontractor_vendor_types`; company-wide because WinTeam AP is not job-linked) and a 6-month
  history of the job-cost subcontract line against AP subcontractor / total invoicing.
* QA scores are not in the warehouse: `qa` is always null.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ..common import (DELIVERY_ALL, DELIVERY_SELF, DELIVERY_SQL, DELIVERY_SUB, DELIVERY_VALUES,
                      DEFAULT_KEY_ACCOUNTS, configured_key_accounts, jsonable, key_accounts_setting,
                      month_end, month_status_rows, parse_delivery, read_setting, scope_clause,
                      source_block)
from ..db import connection
from ..weekly import (BASIS_NONE, BUDGET_DAILY, BUDGET_HBC, CARRY_FORWARD_CLOSED_MONTHS, DT_PREMIUM, INVOICING_AR,
                      INVOICING_CARRY, INVOICING_CONTRACT, INVOICING_JOB_COST, OT_PREMIUM, SUB_AGENCY, SUB_JOB_COST,
                      SUB_PROJECTION, TRAILING_SUB_MONTHS, agency_sub_setting, days_in_month, month_shares,
                      summarize_bases)

router = APIRouter()

DEFAULT_WEEKS = 18
MAX_WEEKS = 104
DEFAULT_BU_TARGETS = {
    "Crane West": {"target": 59.5, "high": 65.0},
    "Crane IFS": {"target": 64.5, "high": 70.0},
    "Crane Southwest": {"target": 64.5, "high": 70.0},
    "Sarus": {"target": 64.5, "high": 70.0},
}
DEFAULT_BU_COLORS = {"Crane West": "#378ADD", "Crane IFS": "#1F9E89", "Crane Southwest": "#D97706", "Sarus": "#7C3AED"}
DEFAULT_BU_ORDER = ["Crane West", "Crane IFS", "Crane Southwest", "Sarus"]
FALLBACK_COLORS = ("#6B7280", "#DC2626", "#0891B2", "#65A30D", "#DB2777")

# DELIVERY_* / DELIVERY_SQL (the effective delivery model of a row), key_accounts_setting,
# parse_delivery and scope_clause live in app/common.py: the reporting scope and this view apply
# the same rules, so they are defined once. Re-exported here for the existing call sites.

ROW_COLUMNS = """
  week_start, company, site_code, job_number, site_name, parent_account, sub_account, delivery_model,
  invoicing, invoicing_basis, invoicing_estimated, carry_forward_source, hours, ot_hours, dt_hours, budget_hours, budget_dollars, budget_basis,
  direct_dollars, ot_dollars, sub_dollars, sub_estimated, sub_basis, total_dollars, labor_cost_basis, days_with_labor, month_shares,
  requested_headcount, pending_requested_headcount
"""

DEFAULT_SUBCONTRACTOR_VENDOR_TYPES: list[str] = ["subcontract", "sub contract", "janitorial", "labor", "staffing", "agency"]
HISTORY_MONTHS = 6
MONTH_CLOSED = "closed"
MONTH_IN_PROGRESS = "in_progress"


def bu_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")


def _f(value: Any) -> float:
    return round(float(value or 0), 2)


def _pct(num: float, den: float) -> float | None:
    return round(num / den * 100.0, 1) if den else None


def _key_accounts() -> list[dict[str, str]]:
    return configured_key_accounts()


def _scope(account: str | None, sub_account: str | None = None, delivery: str = DELIVERY_ALL) -> tuple[str, list[Any]]:
    """common.scope_clause with the configured key accounts."""
    return scope_clause(account, [a["name"] for a in _key_accounts()], sub_account, delivery)


def effective_delivery(row: dict[str, Any]) -> str:
    """Python twin of DELIVERY_SQL for API rows / test fixtures."""
    model = row.get("delivery_model")
    if model in (DELIVERY_SELF, DELIVERY_SUB):
        return model
    return DELIVERY_SELF if float(row.get("hours") or 0) > 0 else DELIVERY_SUB


def delivery_split(rows: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    """{self_perform: {sites, labor}, subcontracted: {sites, vendor}} over the rows (labor = direct + ot)."""
    out = {DELIVERY_SELF: {"sites": 0, "labor": 0.0, "vendor": 0.0}, DELIVERY_SUB: {"sites": 0, "labor": 0.0, "vendor": 0.0}}
    for r in rows:
        bucket = out[effective_delivery(r)]
        bucket["sites"] += 1
        bucket["labor"] += float(r.get("direct_dollars") or 0) + float(r.get("ot_dollars") or 0)
        bucket["vendor"] += float(r.get("sub_dollars") or 0)
    return out


def _parse_week(value: str | None) -> date | None:
    if not value:
        return None
    try:
        parsed = date.fromisoformat(value[:10])
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="week must be an ISO date (YYYY-MM-DD) on a Monday") from exc
    if parsed.weekday() != 0:
        raise HTTPException(status_code=422, detail=f"week must be a Monday; {parsed.isoformat()} is not")
    return parsed


def bu_order_setting(value: Any) -> list[str]:
    """Validated bu_order: distinct non-empty names in the configured order (defaults when malformed)."""
    if not isinstance(value, list):
        return list(DEFAULT_BU_ORDER)
    out: list[str] = []
    for name in value:
        if isinstance(name, str) and name.strip() and name.strip() not in out:
            out.append(name.strip())
    return out or list(DEFAULT_BU_ORDER)


def order_business_units(units: list[dict[str, Any]], order: list[str]) -> list[dict[str, Any]]:
    """Units in the configured order, unknown ones appended alphabetically, each with a 1-based sort_order."""
    rank = {name: i for i, name in enumerate(order)}
    ordered = sorted(units, key=lambda u: (0, rank[u["name"]], u["name"]) if u["name"] in rank else (1, 0, u["name"].lower()))
    return [{**u, "sort_order": i + 1} for i, u in enumerate(ordered)]


def business_units(companies_in_rows: list[str]) -> list[dict[str, Any]]:
    order = bu_order_setting(read_setting("bu_order", DEFAULT_BU_ORDER))
    return order_business_units(_business_units(companies_in_rows), order)


def _business_units(companies_in_rows: list[str]) -> list[dict[str, Any]]:
    targets = read_setting("bu_targets", DEFAULT_BU_TARGETS)
    colors = read_setting("bu_colors", DEFAULT_BU_COLORS)
    if not isinstance(targets, dict):
        targets = DEFAULT_BU_TARGETS
    if not isinstance(colors, dict):
        colors = DEFAULT_BU_COLORS
    names = list(targets.keys()) + [c for c in companies_in_rows if c and c not in targets]
    out: list[dict[str, Any]] = []
    for i, name in enumerate(names):
        t = targets.get(name) if isinstance(targets.get(name), dict) else {}
        try:
            target = float(t["target"]) if t and t.get("target") is not None else None
            high = float(t["high"]) if t and t.get("high") is not None else None
        except (TypeError, ValueError):
            target, high = None, None
        color = colors.get(name) if isinstance(colors.get(name), str) else DEFAULT_BU_COLORS.get(name, FALLBACK_COLORS[i % len(FALLBACK_COLORS)])
        out.append({"key": bu_key(name), "name": name, "color": color, "target_pct": target, "high_pct": high})
    return out


def _row(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "week": r["week_start"].isoformat(),
        "bu": r["company"] or "Unassigned",
        "site": r["site_code"] or r["job_number"],
        "job_number": r["job_number"],
        "site_name": r["site_name"],
        "account": r["parent_account"] or "Unassigned",
        "sub_account": r.get("sub_account"),
        "delivery_model": r["delivery_model"],
        "invoicing": _f(r["invoicing"]),
        "invoicing_basis": r["invoicing_basis"] or BASIS_NONE,
        "invoicing_estimated": bool(r["invoicing_estimated"]),
        "carry_forward_source": r.get("carry_forward_source"),
        "hours": _f(r["hours"]),
        "ot_hours": _f(r["ot_hours"]),
        "dt_hours": _f(r["dt_hours"]),
        "budget_hours": _f(r["budget_hours"]),
        "budget_dollars": _f(r["budget_dollars"]),
        "budget_basis": r["budget_basis"] or BASIS_NONE,
        "direct_dollars": _f(r["direct_dollars"]),
        "ot_dollars": _f(r["ot_dollars"]),
        "sub_dollars": _f(r["sub_dollars"]),
        "sub_estimated": bool(r["sub_estimated"]),
        "sub_basis": r["sub_basis"] or BASIS_NONE,
        "total_dollars": _f(r["total_dollars"]),
        "labor_cost_basis": r["labor_cost_basis"] or "trailing_job_rate",
        "days_with_labor": int(r["days_with_labor"] or 0),
        # PhotoValidation demand open at the end of the week (migration 041); null before the feed loads.
        "requested_headcount": r.get("requested_headcount"),
        "pending_requested_headcount": r.get("pending_requested_headcount"),
    }


def build_notes(selected_rows: list[dict[str, Any]], selected_week: date | None, agency: dict[str, Any],
                contract_rows: int, daily_span: tuple[date | None, date | None], labor_basis: str | None) -> list[str]:
    """Every derivation behind the numbers, with the selected week's basis mix."""
    week_label = selected_week.isoformat() if selected_week else "n/a"
    inv = summarize_bases(selected_rows, "invoicing_basis")
    bud = summarize_bases(selected_rows, "budget_basis")
    sub = summarize_bases(selected_rows, "sub_basis")
    inv_amount = {b: sum(r["invoicing"] for r in selected_rows if r["invoicing_basis"] == b) for b in inv}
    estimated_sub = sum(r["sub_dollars"] for r in selected_rows if r["sub_estimated"])
    carried_rows = [r for r in selected_rows if r.get("invoicing_estimated") or r["invoicing_basis"] == INVOICING_CARRY]
    carried_invoicing = sum(r["invoicing"] for r in carried_rows)
    carried_sources = summarize_bases(carried_rows, "carry_forward_source") if carried_rows else {}
    total_sub = sum(r["sub_dollars"] for r in selected_rows)
    split = delivery_split(selected_rows)
    unlabelled = sum(1 for r in selected_rows if r.get("delivery_model") not in (DELIVERY_SELF, DELIVERY_SUB))
    basis_words = {
        INVOICING_JOB_COST: "closed-month job-cost revenue apportioned by calendar days",
        INVOICING_CONTRACT: "contract billing x 12/53 x week day-share",
        INVOICING_AR: "AR invoices for the service month apportioned by calendar days",
        INVOICING_CARRY: "the latest recent closed month's revenue (greater of job-cost and AR) carried forward, apportioned by calendar days (estimated)",
        BASIS_NONE: "no invoicing source (0)",
    }
    labor_words = {
        "trailing_job_rate": "hours x the job's trailing closed-month rate (job-cost direct labor / actual hours)",
        "hours_x_rate": "hours x the timekeeping rate",
    }
    notes = [
        "Invoicing = closed-month job-cost revenue apportioned to weeks by calendar days (job_cost_month_prorated); "
        "else the contract billing amount x 12/53 x the week's day-share (contract, the 12/53 rule); "
        "else AR invoices for the service month apportioned by calendar days (ar_invoice_prorated); "
        f"else the job's most recent month within the last {CARRY_FORWARD_CLOSED_MONTHS} closed months with job-cost or AR revenue, "
        "carrying the greater of the two forward and apportioning it the same way (carry_forward, invoicing_estimated = true, "
        "carry_forward_source = job_cost | ar_invoice); else 0 (none). "
        "A straddle week takes each month's share separately.",
        f"Carry-forward for week of {week_label}: {len(carried_rows)} of {len(selected_rows)} site(s) are on the carry_forward basis "
        f"(${carried_invoicing:,.0f} of ${sum(r['invoicing'] for r in selected_rows):,.0f} invoicing is estimated"
        + (f"; source: {', '.join(f'{k} = {v}' for k, v in carried_sources.items())}" if carried_sources else "") + ")."
        if selected_rows else f"Carry-forward for week of {week_label}: no rows.",
        f"Invoicing basis mix for week of {week_label}: " + (", ".join(
            f"{b} = {n} site(s), ${inv_amount[b]:,.0f} ({basis_words.get(b, b)})" for b, n in inv.items()) or "no rows") + ".",
        ("Contract billing table is empty (the reference database has no app.contract_billing), so the contract basis never applies; "
         "weeks in months that are not closed fall through to AR invoices or 0."
         if contract_rows == 0 else f"Contract billing has {contract_rows} job-month rate(s); the latest effective month <= the week's month applies."),
        "Hours are timekeeping hours by work date (Monday-Sunday weeks); OT and DT hours are the timekeeping overtime / double-time categories.",
        f"Direct dollars = straight-time labor: {labor_words.get(labor_basis or '', labor_basis or 'hours x rate')}; no premium included.",
        f"OT dollars are an ESTIMATE of the premium: ot_hours x rate x {OT_PREMIUM} + dt_hours x rate x {DT_PREMIUM:.1f}; "
        "the feeds do not carry the paid premium.",
        "Sub dollars = the site's monthly subcontract cost apportioned by calendar days: the job-cost subcontractors line in a closed month "
        "(job_cost); for the agency-sub sites " + (
            f"({', '.join(f'{s} -> job {j}' for s, j in agency['site_jobs'].items())}) AP invoices of '{agency['vendor_match']}' coded to the site "
            f"x {agency['pct']:.0%} by invoice month (agency_ap) when the job-cost line is empty; "
            if agency.get("enabled") else "(agency rule disabled) ") +
        f"a month that is not closed without a known figure is PROJECTED: the site's average weekly subcontract cost over its job-cost months "
        f"among the last {TRAILING_SUB_MONTHS} closed months (sub / days in month x 7, averaged) x the week's days in the month / 7 "
        "(trailing_3mo_projection, sub_estimated = true); a site with no job-cost month in that window projects 0 (none).",
        f"Subcontract basis mix for week of {week_label}: " + (", ".join(f"{b} = {n} site(s)" for b, n in sub.items()) or "no rows") +
        f"; ${estimated_sub:,.0f} of ${total_sub:,.0f} sub is projected (estimated).",
        "Budget = the daily labor budget summed over the week's days when the job's daily budget rows cover them (daily_budget"
        + (f"; daily rows span {daily_span[0].isoformat()} to {daily_span[1].isoformat()}" if daily_span[0] and daily_span[1] else "; no daily rows loaded")
        + "), else the monthly labor budget (daily-budget month sum / hours budget comparison / wage by job) x the week's day-share (hbc), else none. "
        "Budget hours follow the same rule.",
        f"Budget coverage for week of {week_label}: " + (", ".join(f"{b} = {n} site(s)" for b, n in bud.items()) or "no rows") + ".",
        "Total dollars = direct + OT premium estimate + sub. Labor % of invoicing = total / invoicing; BU targets come from the bu_targets setting.",
        f"Delivery split for week of {week_label}: {split[DELIVERY_SELF]['sites']} self-performed site(s) "
        f"(${split[DELIVERY_SELF]['labor']:,.0f} labor = direct + OT estimate), {split[DELIVERY_SUB]['sites']} subcontracted site(s) "
        f"(${split[DELIVERY_SUB]['vendor']:,.0f} vendor cost = sub dollars). "
        "A site whose job has no delivery model counts as self-performed when the week has hours, else as subcontracted"
        + (f"; {unlabelled} such site(s) this week" if unlabelled else "") + ". "
        "Hours, OT and direct / OT dollars are self-performed labor (0 for subcontracted sites); sub dollars are the vendor cost per site "
        "(vendor identity is not job-linked in WinTeam beyond the agency rule).",
        "BU = the job's company (Crane IFS, Crane West, Crane Southwest, Sarus). The original dashboard's Elite BU is not in the data.",
        "QA scores are not in the warehouse; qa is null.",
        "A week appears once it has started (Monday <= today); the current week is partial until Sunday's punches are loaded (days_with_labor).",
    ]
    if any(b not in (BUDGET_DAILY, BUDGET_HBC, BASIS_NONE) for b in bud) or any(b not in (SUB_JOB_COST, SUB_AGENCY, SUB_PROJECTION, BASIS_NONE) for b in sub):
        notes.append("Unexpected basis labels present; check mart.job_week.")
    return notes


# ── vendor cost: projection and live AP look ────────────────────────────────
def vendor_types_setting(value: Any) -> list[str | int]:
    """Validated `subcontractor_vendor_types`: lower-cased non-empty terms (strings) and vendor_type_ids (integers).

    A digit-only string counts as a vendor_type_id. Duplicates are dropped in order; an empty or
    non-list setting falls back to DEFAULT_SUBCONTRACTOR_VENDOR_TYPES.
    """
    if not isinstance(value, list):
        return list(DEFAULT_SUBCONTRACTOR_VENDOR_TYPES)
    out: list[str | int] = []
    for item in value:
        term: str | int | None = None
        if isinstance(item, bool):
            continue
        if isinstance(item, int):
            term = item
        elif isinstance(item, str) and item.strip():
            term = int(item.strip()) if item.strip().isdigit() else item.strip().lower()
        if term is not None and term not in out:
            out.append(term)
    return out or list(DEFAULT_SUBCONTRACTOR_VENDOR_TYPES)


def vendor_type_labels_setting(value: Any) -> dict[str, str]:
    """Validated `vendor_type_labels` (migration 016): {"<vendor_type_id>": label}; malformed entries dropped."""
    if not isinstance(value, dict):
        return {}
    return {str(k).strip(): str(v).strip() for k, v in value.items() if str(k).strip() and isinstance(v, str) and v.strip()}


def match_subcontractor_vendor(vendor_type: str | None, vendor_name: str | None, vendor_type_id: int | None,
                               terms: list[str | int], labels: dict[str, str] | None = None) -> str | None:
    """The label an AP invoice's vendor is grouped under when it looks like a subcontractor, else None.

    A string term matches as a case-insensitive substring of the vendor type first, then of the vendor
    name; an integer term matches the vendor_type_id exactly. The label is the invoice's own vendor_type
    when it has one, else the `vendor_type_labels` label of its vendor_type_id (setting, migration 016),
    else "type <id>" for an id match or the matching term for a name match, so `by_vendor_type` stays
    meaningful for feeds that carry no type label.
    """
    vtype = (vendor_type or "").strip()
    vtype_l, name_l = vtype.lower(), (vendor_name or "").strip().lower()
    labelled = (labels or {}).get(str(vendor_type_id)) if vendor_type_id is not None else None
    for term in terms:
        if isinstance(term, int):
            if vendor_type_id is not None and vendor_type_id == term:
                return vtype or labelled or f"type {term}"
        elif term and (term in vtype_l or term in name_l):
            return vtype or labelled or term
    return None


def scope_label(account: str | None, sub_account: str | None, delivery: str) -> str:
    """Human label of the row scope for the vendor block's scope_note."""
    label = "all key accounts" if account in (None, "", "All") else f"account {account}"
    if sub_account:
        label += f" / {sub_account}"
    if delivery != DELIVERY_ALL:
        label += f" / {delivery} sites"
    return label


def dominant_month(week: date) -> date:
    """The calendar month holding most of the Monday week's days (a straddle week is never a tie: 7 days)."""
    shares = month_shares(week)
    return max(shares, key=lambda m: (shares[m], -m.toordinal()))


def build_vendor_block(month: date, month_status: str, as_of: date, closed_months: list[date], selected_rows: list[dict[str, Any]],
                       ap_rows: list[dict[str, Any]], history_job_cost: dict[date, float], terms: list[str | int],
                       ap_loaded_months: set[date] | None = None, history_job_cost_all: dict[date, float] | None = None,
                       projected_all: float | None = None, labels: dict[str, str] | None = None,
                       scope_label: str = "the selected scope") -> dict[str, Any]:
    """The `vendor` block (pure) - docs/api-contract.md "Vendor cost: projection and live AP look".

    * `selected_rows`: the selected week's raw mart rows (with `month_shares`); the projected month
      subcontract cost is the sum over them of `month_shares[month].sub_month`, the monthly figure each
      site's slice for `month` was apportioned from (job-cost line when closed, agency allocation, or the
      trailing projection = weekly rate x days_in_month / 7), so it reconciles with the rows.
    * `ap_rows`: AP invoices dated up to `as_of`, aggregated per (month, vendor): {month, vendor_number, vendor_name,
      vendor_type, vendor_type_id, invoices, invoiced, through}; those matching `terms` are subcontractor spend.
    * `history_job_cost`: {month: job-cost subcontract sum over the scope's jobs} for the closed months;
      `history_job_cost_all` the same company-wide (every job), so the UI can chart AP (company-wide) against
      job cost on the same scope (`job_cost_sub_all`). `projected_all` is the company-wide projected month
      (the sum of sub_month over every site's row of the selected week) reported as `projected_month_sub_all`.
    * `ap_loaded_months`: months with any AP invoice (defaults to the months present in ap_rows); `ap_live`
      is null when the selected month has none.
    * `labels`: the vendor_type_labels setting (id -> label) for `by_vendor_type`.
    """
    month_key = month.isoformat()
    shares = [((r.get("month_shares") or {}).get(month_key) or {}) for r in selected_rows]
    projected = sum(float(s.get("sub_month") or 0) for s in shares)
    by_basis: dict[str, int] = {}
    for s in shares:
        basis = str(s.get("sub_basis") or BASIS_NONE)
        by_basis[basis] = by_basis.get(basis, 0) + 1
    closed = month in closed_months
    loaded = ap_loaded_months if ap_loaded_months is not None else {r["month"] for r in ap_rows}

    def ap_for(m: date) -> dict[str, Any]:
        matched: list[tuple[str, dict[str, Any]]] = []
        total = 0.0
        for r in ap_rows:
            if r["month"] != m:
                continue
            total += float(r.get("invoiced") or 0)
            label = match_subcontractor_vendor(r.get("vendor_type"), r.get("vendor_name"), r.get("vendor_type_id"), terms, labels)
            if label is not None:
                matched.append((label, r))
        groups: dict[str, dict[str, Any]] = {}
        vendors: set[Any] = set()
        through: date | None = None
        for label, r in matched:
            g = groups.setdefault(label, {"vendor_type": label, "invoiced": 0.0, "invoices": 0, "vendors": set()})
            g["invoiced"] += float(r.get("invoiced") or 0)
            g["invoices"] += int(r.get("invoices") or 0)
            g["vendors"].add(r.get("vendor_number") or r.get("vendor_name"))
            vendors.add(r.get("vendor_number") or r.get("vendor_name"))
            if r.get("through") is not None and (through is None or r["through"] > through):
                through = r["through"]
        return {
            "invoiced_to_date": round(sum(g["invoiced"] for g in groups.values()), 2),
            "invoices": sum(g["invoices"] for g in groups.values()),
            "vendors": len(vendors),
            "through": through.isoformat() if through else None,
            "all_invoiced": round(total, 2),
            "by_vendor_type": sorted(
                [{"vendor_type": g["vendor_type"], "invoiced": round(g["invoiced"], 2), "invoices": g["invoices"], "vendors": len(g["vendors"])}
                 for g in groups.values()], key=lambda g: (-g["invoiced"], g["vendor_type"])),
        }

    ap_live = ap_for(month) if month in loaded else None
    history_months = [m for m in sorted(closed_months) if m <= month][-HISTORY_MONTHS:]
    history = []
    for m in history_months:
        ap = ap_for(m)
        history.append({"month": m.isoformat(), "job_cost_sub": round(float(history_job_cost.get(m, 0.0) or 0.0), 2),
                        "job_cost_sub_all": round(float((history_job_cost_all or {}).get(m, 0.0) or 0.0), 2),
                        "ap_subcontractor_invoiced": ap["invoiced_to_date"], "ap_all_invoiced": ap["all_invoiced"]})
    label = ", ".join(str(t) for t in terms)
    scope_note = (f"projected_month_sub and history[].job_cost_sub are scoped to {scope_label}; projected_month_sub_all, "
                  "history[].job_cost_sub_all and every AP figure (ap_live, ap_subcontractor_invoiced, ap_all_invoiced) are "
                  "company-wide because WinTeam AP invoices are not linked to jobs - compare AP against the _all figures.")
    notes = [
        f"Vendor cost for {month.strftime('%B %Y')} ({month_status.replace('_', ' ')}): projected_month_sub ${projected:,.0f} over "
        f"{len(selected_rows)} site(s) in scope = " + (
            "the closed month's job-cost subcontractors line per site" if closed else
            f"each site's trailing-{TRAILING_SUB_MONTHS}-closed-months weekly rate x {days_in_month(month)} / 7"
            + (f" (agency_ap sites use their AP allocation for the month)" if by_basis.get(SUB_AGENCY) else ""))
        + "; basis mix " + (", ".join(f"{b} = {n}" for b, n in sorted(by_basis.items(), key=lambda kv: -kv[1])) or "none") + ".",
        f"ap_live and history AP figures are COMPANY-WIDE, not per account: WinTeam AP invoices are not linked to jobs. "
        f"Subcontractor spend = AP invoices (effective source view) dated in the month whose vendor type or vendor name contains "
        f"one of [{label}] (setting subcontractor_vendor_types; integers match the vendor_type_id)"
        + ((f"; through {ap_live['through']}, {ap_live['invoices']} invoice(s) of {ap_live['vendors']} vendor(s), "
            f"${ap_live['invoiced_to_date']:,.0f} of ${ap_live['all_invoiced']:,.0f} AP invoiced in the month"
            if ap_live["invoices"] else f"; no matching invoice dated in the month yet (${ap_live['all_invoiced']:,.0f} AP invoiced in total)")
           if ap_live else "; no AP invoices are loaded for the month (ap_live is null)") + ".",
    ]
    return {
        "month": month_key,
        "month_status": month_status,
        "as_of": as_of.isoformat(),
        "projected_month_sub": round(projected, 2),
        "projected_month_sub_all": round(float(projected_all), 2) if projected_all is not None else None,
        "projected_basis": SUB_JOB_COST if closed else SUB_PROJECTION,
        "sites": len(selected_rows),
        "sites_projected": by_basis.get(SUB_PROJECTION, 0),
        "sites_by_basis": by_basis,
        "ap_live": ap_live,
        "history": history,
        "scope_note": scope_note,
        "notes": notes,
    }


AP_VENDOR_MONTH_SQL = """
SELECT date_trunc('month', coalesce(i.invoice_date, i.posting_date))::date AS month,
       i.vendor_number, coalesce(i.vendor_name, v.vendor_name) AS vendor_name, i.vendor_type, v.vendor_type_id,
       count(*) AS invoices, sum(coalesce(i.invoice_amount, 0)) AS invoiced,
       max(coalesce(i.invoice_date, i.posting_date)) AS through
FROM mart.v_ap_invoice_effective i
LEFT JOIN core.dim_vendor v ON v.vendor_number = i.vendor_number
WHERE coalesce(i.invoice_date, i.posting_date) BETWEEN %s AND %s
GROUP BY 1, 2, 3, 4, 5
"""


def _vendor_inputs(cursor: Any, month: date, as_of: date, clause: str, params: list[Any], selected: date) -> dict[str, Any]:
    """{closed_months, ap_rows, history_job_cost, history_job_cost_all, projected_all}: the DB inputs of build_vendor_block.

    closed job-cost months; AP vendor-month rows for the history window and the month (dated up to as_of);
    job-cost subcontract by month over the scope's jobs and company-wide; the company-wide projected month
    (sum of month_shares[month].sub_month over every job_week row of the selected week).
    """
    cursor.execute("SELECT DISTINCT month FROM mart.job_month WHERE revenue_basis = 'job_cost' ORDER BY month")
    closed_months = [r["month"] for r in cursor.fetchall()]
    history_months = [m for m in closed_months if m <= month][-HISTORY_MONTHS:]
    lo = min([month, *history_months])
    hi = min(month_end(month), as_of)            # the selected month is read up to as_of; history months are complete
    cursor.execute(AP_VENDOR_MONTH_SQL, [lo, hi])
    ap_rows = [dict(r) for r in cursor.fetchall()]
    cursor.execute(
        f"""
        SELECT jm.month, sum(coalesce(jm.subcontract_cost, 0)) AS sub
        FROM mart.job_month jm
        WHERE jm.revenue_basis = 'job_cost' AND jm.month = ANY(%s::date[])
          AND jm.job_number IN (SELECT DISTINCT job_number FROM mart.job_week WHERE true{clause})
        GROUP BY 1
        """,
        [history_months, *params],
    )
    history_job_cost = {r["month"]: float(r["sub"] or 0) for r in cursor.fetchall()}
    cursor.execute(
        "SELECT month, sum(coalesce(subcontract_cost, 0)) AS sub FROM mart.job_month WHERE revenue_basis = 'job_cost' AND month = ANY(%s::date[]) GROUP BY 1",
        [history_months],
    )
    history_job_cost_all = {r["month"]: float(r["sub"] or 0) for r in cursor.fetchall()}
    cursor.execute(
        "SELECT coalesce(sum((month_shares -> %s ->> 'sub_month')::numeric), 0) AS sub FROM mart.job_week WHERE week_start = %s",
        [month.isoformat(), selected],
    )
    projected_all = float((cursor.fetchone() or {}).get("sub") or 0)
    return {"closed_months": closed_months, "ap_rows": ap_rows, "history_job_cost": history_job_cost,
            "history_job_cost_all": history_job_cost_all, "projected_all": projected_all}


def _month_status(month: date) -> str:
    status = next((r["status"] for r in month_status_rows() if r["month"] == month), None)
    return MONTH_CLOSED if status == MONTH_CLOSED else MONTH_IN_PROGRESS


@router.get("/executive/labor-pl")
def executive_labor_pl(account: str = Query("All"), weeks: int = Query(DEFAULT_WEEKS, ge=1, le=MAX_WEEKS),
                       week: str | None = Query(None), sub_account: str | None = Query(None),
                       delivery: str = Query(DELIVERY_ALL)) -> dict[str, Any]:
    requested = _parse_week(week)
    delivery = parse_delivery(delivery)
    sub_account = (sub_account or "").strip() or None
    clause, params = _scope(account, sub_account, delivery)
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT max(week_start) FILTER (WHERE hours > 0) AS latest_labor_week,
                   max(week_start) FILTER (WHERE days_with_labor >= 7) AS latest_full_week,
                   max(week_start) AS latest_week,
                   count(*) AS rows
            FROM mart.job_week WHERE true{clause}
            """,
            params,
        )
        anchors = cursor.fetchone() or {}
        end: date | None = anchors.get("latest_labor_week") or anchors.get("latest_week")
        selected: date | None = requested or anchors.get("latest_full_week") or end
        if end is None:
            source = source_block()
            return {"source": source, "as_of": None, "account": account or "All", "sub_account": sub_account, "delivery": delivery,
                    "weeks": [], "selected_week": None, "business_units": business_units([]), "rows": [], "qa": None, "vendor": None,
                    "notes": ["No mart.job_week rows in scope: load a source (finance reference or WinTeam sync), rebuild the marts, "
                              "or widen the account / sub_account / delivery filter."]}
        if selected and (selected > end or selected < end - timedelta(days=(weeks - 1) * 7)):
            end = selected
        start = end - timedelta(days=(weeks - 1) * 7)

        cursor.execute(
            f"""
            SELECT {ROW_COLUMNS}
            FROM mart.job_week
            WHERE week_start BETWEEN %s AND %s{clause}
            ORDER BY week_start, company, total_dollars DESC, job_number
            """,
            [start, end, *params],
        )
        raw_rows = [dict(r) for r in cursor.fetchall()]
        rows = [_row(r) for r in raw_rows]
        cursor.execute("SELECT count(*) AS n FROM core.contract_billing")
        contract_rows = int((cursor.fetchone() or {}).get("n") or 0)
        cursor.execute("SELECT min(budget_date) AS lo, max(budget_date) AS hi FROM core.fact_daily_budget")
        span = cursor.fetchone() or {}
        cursor.execute("SELECT max(work_date) AS d FROM core.fact_timekeeping")
        as_of = (cursor.fetchone() or {}).get("d")
        vendor_month = dominant_month(selected) if selected else None
        vendor_as_of = date.today()
        if vendor_month is not None:
            vendor_inputs = _vendor_inputs(cursor, vendor_month, vendor_as_of, clause, params, selected)

    # every Monday of the window, even weeks no site has rows for, so the picker is a regular grid
    week_list = [(start + timedelta(days=7 * i)).isoformat() for i in range(weeks)]
    selected_iso = selected.isoformat() if selected else None
    selected_rows = [r for r in rows if r["week"] == selected_iso]
    companies = sorted({r["bu"] for r in rows})
    labor_basis = next((r["labor_cost_basis"] for r in selected_rows if r["hours"] > 0), None) or next((r["labor_cost_basis"] for r in rows if r["hours"] > 0), None)
    agency = agency_sub_setting(read_setting("agency_sub", None))
    notes = build_notes(selected_rows, selected, agency, contract_rows, (span.get("lo"), span.get("hi")), labor_basis)
    vendor: dict[str, Any] | None = None
    if vendor_month is not None:
        vendor = build_vendor_block(
            vendor_month, _month_status(vendor_month), vendor_as_of, vendor_inputs["closed_months"],
            [r for r in raw_rows if r["week_start"] == selected], vendor_inputs["ap_rows"], vendor_inputs["history_job_cost"],
            vendor_types_setting(read_setting("subcontractor_vendor_types", None)),
            history_job_cost_all=vendor_inputs["history_job_cost_all"], projected_all=vendor_inputs["projected_all"],
            labels=vendor_type_labels_setting(read_setting("vendor_type_labels", None)),
            scope_label=scope_label(account, sub_account, delivery),
        )
        notes.extend(vendor.pop("notes"))
    return {
        "source": source_block(),
        "as_of": as_of.isoformat() if as_of else None,
        "account": account or "All",
        "sub_account": sub_account,
        "delivery": delivery,
        "weeks": week_list,
        "selected_week": selected_iso,
        "business_units": business_units(companies),
        "ot_bands": jsonable(read_setting("ot_bands", {"warn": 8.0, "severe": 15.0})),
        "rows": rows,
        "qa": None,
        "vendor": vendor,
        "notes": notes,
    }


def build_accounts(keys: list[dict[str, str]], sites: list[dict[str, Any]], order: list[str]) -> list[dict[str, Any]]:
    """The accounts list (pure) from one row per (parent_account, sub_account, job) with its delivery and company.

    `sites` rows: {name, sub_account, job_number, delivery, company}. Per key account (configured
    order): sites, business_units (bu_order), delivery {self_perform, subcontracted} site counts and
    sub_accounts [{name, sites, delivery}] ordered by sites desc then name. "All" comes first with
    the combined counts and no sub_accounts.
    """
    by_order = lambda units: [u["name"] for u in order_business_units([{"name": n} for n in units], order)]  # noqa: E731

    def counts(rows: list[dict[str, Any]]) -> dict[str, int]:
        jobs = {r["job_number"]: r["delivery"] for r in rows}
        return {DELIVERY_SELF: sum(1 for d in jobs.values() if d == DELIVERY_SELF),
                DELIVERY_SUB: sum(1 for d in jobs.values() if d != DELIVERY_SELF)}

    def entry(name: str, label: str, rows: list[dict[str, Any]], with_subs: bool) -> dict[str, Any]:
        out: dict[str, Any] = {
            "name": name, "label": label,
            "sites": len({r["job_number"] for r in rows}),
            "business_units": by_order({r["company"] for r in rows if r.get("company")}),
            "delivery": counts(rows),
        }
        if with_subs:
            groups: dict[str, list[dict[str, Any]]] = {}
            for r in rows:
                groups.setdefault(r.get("sub_account") or name, []).append(r)
            subs = [{"name": sub, "sites": len({r["job_number"] for r in grp}), "delivery": counts(grp)} for sub, grp in groups.items()]
            out["sub_accounts"] = sorted(subs, key=lambda x: (-x["sites"], x["name"].lower()))
        return out

    names = [a["name"] for a in keys]
    in_scope = [r for r in sites if r["name"] in names]
    return [entry("All", "All key accounts", in_scope, False)] + [
        entry(a["name"], a["label"], [r for r in in_scope if r["name"] == a["name"]], True) for a in keys
    ]


@router.get("/executive/accounts")
def executive_accounts() -> dict[str, Any]:
    """Account selector: the configured key accounts (setting `key_accounts`, in order) with site counts, BUs,
    delivery-model counts and sub-accounts (docs/api-contract.md "Executive slicing")."""
    keys = _key_accounts()
    names = [a["name"] for a in keys]
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT parent_account AS name, sub_account, job_number,
                   coalesce(delivery_model, CASE WHEN sum(hours) > 0 THEN '{DELIVERY_SELF}' ELSE '{DELIVERY_SUB}' END) AS delivery,
                   mode() WITHIN GROUP (ORDER BY company) AS company
            FROM mart.job_week
            WHERE parent_account = ANY(%s::text[])
            GROUP BY parent_account, sub_account, job_number, delivery_model
            """,
            (names,),
        )
        sites = [dict(r) for r in cursor.fetchall()]
    order = bu_order_setting(read_setting("bu_order", DEFAULT_BU_ORDER))
    return {"source": source_block(), "accounts": build_accounts(keys, sites, order)}
