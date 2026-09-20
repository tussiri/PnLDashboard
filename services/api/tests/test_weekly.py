"""Pure tests for the weekly executive labor P&L rules (no database).

Pins: Monday weeks and week/month overlap shares, the 12/53 contract slicing, the OT premium
estimate, the invoicing / budget basis selection order, the dominant-basis rule for straddle weeks,
site_code extraction, the agency_sub setting validation, the executive router's BU helpers and the
loader's reset list.
"""
from __future__ import annotations

from datetime import date

from fastapi import HTTPException

from app.routers.executive import (DEFAULT_SUBCONTRACTOR_VENDOR_TYPES, DELIVERY_SELF, DELIVERY_SQL, DELIVERY_SUB, bu_key,
                                   build_accounts, build_notes, build_vendor_block, delivery_split, dominant_month,
                                   effective_delivery, match_subcontractor_vendor, parse_delivery, scope_clause,
                                   scope_label, vendor_type_labels_setting, vendor_types_setting)
from app.sources.finance_reference import RESET_TABLES
from app.weekly import (
    BASIS_NONE,
    BUDGET_DAILY,
    BUDGET_HBC,
    CONTRACT_WEEKS_PER_MONTH,
    INVOICING_AR,
    INVOICING_CARRY,
    INVOICING_CONTRACT,
    INVOICING_JOB_COST,
    DEFAULT_SUB_ACCOUNT_RULES,
    JOB_WEEK_SQL,
    SUB_ACCOUNT_UPDATE_SQL,
    SUB_AGENCY,
    SUB_JOB_COST,
    SUB_PROJECTION,
    TRAILING_SUB_MONTHS,
    agency_sub_setting,
    carry_forward_source,
    contract_weekly,
    dominant_basis,
    month_overlap_days,
    month_shares,
    ot_dollars,
    project_weekly_sub,
    prorate_month,
    select_budget,
    select_invoicing,
    site_code,
    sub_account_for,
    sub_account_rules_setting,
    summarize_bases,
    trailing_weekly_sub_rate,
    week_start,
)

JUL = date(2026, 7, 1)
AUG = date(2026, 8, 1)


# ── weeks and overlap shares ─────────────────────────────────────────────────
def test_week_start_is_monday() -> None:
    assert week_start(date(2026, 8, 24)) == date(2026, 8, 24)      # Monday
    assert week_start(date(2026, 8, 30)) == date(2026, 8, 24)      # Sunday belongs to the same week
    assert week_start(date(2026, 9, 1)) == date(2026, 8, 31)
    assert week_start(date(2026, 8, 1)) == date(2026, 7, 27)


def test_month_overlap_days_and_shares() -> None:
    straddle = date(2026, 7, 27)                                   # Mon Jul 27 .. Sun Aug 2
    assert month_overlap_days(straddle, JUL) == 5
    assert month_overlap_days(straddle, AUG) == 2
    assert month_shares(straddle) == {JUL: 5, AUG: 2}
    full = date(2026, 8, 24)
    assert month_shares(full) == {AUG: 7}
    assert month_overlap_days(full, JUL) == 0
    # every week's shares sum to 7 days
    for k in range(60):
        w = date.fromordinal(date(2025, 6, 30).toordinal() + 7 * k)
        assert sum(month_shares(w).values()) == 7


def test_prorate_month_apportions_by_calendar_days() -> None:
    assert abs(prorate_month(3100.0, 7, JUL) - 3100.0 * 7 / 31) < 1e-9
    assert abs(prorate_month(3100.0, 5, JUL) - 500.0) < 1e-9
    # the weekly slices of a month reconcile to the month exactly
    total = 0.0
    for k in range(6):
        w = date.fromordinal(date(2026, 6, 29).toordinal() + 7 * k)
        total += prorate_month(496582.27, month_overlap_days(w, JUL), JUL)
    assert abs(total - 496582.27) < 1e-6


# ── 12/53 contract slicing ───────────────────────────────────────────────────
def test_contract_weekly_uses_12_over_53_and_day_share() -> None:
    assert abs(CONTRACT_WEEKS_PER_MONTH - 12 / 53) < 1e-12
    assert abs(contract_weekly(53000.0, 7) - 12000.0) < 1e-9
    assert abs(contract_weekly(53000.0, 5) - 12000.0 * 5 / 7) < 1e-9
    assert contract_weekly(53000.0, 0) == 0.0
    # a straddle week's two slices add up to one full 12/53 week when both months share the rate
    assert abs(contract_weekly(53000.0, 5) + contract_weekly(53000.0, 2) - 12000.0) < 1e-9


# ── OT premium estimate ──────────────────────────────────────────────────────
def test_ot_dollars_estimate() -> None:
    assert ot_dollars(0, 0, 20.0) == 0.0
    assert abs(ot_dollars(10, 0, 20.0) - 100.0) < 1e-9        # 10 OT hours x $20 x 0.5
    assert abs(ot_dollars(0, 4, 20.0) - 80.0) < 1e-9          # 4 DT hours x $20 x 1.0
    assert abs(ot_dollars(10, 4, 20.0) - 180.0) < 1e-9
    assert "* %(ot_premium)s::numeric" in JOB_WEEK_SQL and "* %(dt_premium)s::numeric" in JOB_WEEK_SQL


# ── basis selection order ────────────────────────────────────────────────────
def test_invoicing_precedence_job_cost_then_contract_then_ar_then_none() -> None:
    amount, basis = select_invoicing(496582.27, 50000.0, 40000.0, 7, JUL)
    assert basis == INVOICING_JOB_COST and abs(amount - 496582.27 * 7 / 31) < 1e-9
    amount, basis = select_invoicing(None, 53000.0, 40000.0, 7, AUG)
    assert basis == INVOICING_CONTRACT and abs(amount - 12000.0) < 1e-9
    amount, basis = select_invoicing(0.0, None, 31000.0, 7, AUG)
    assert basis == INVOICING_AR and abs(amount - 7000.0) < 1e-9
    amount, basis = select_invoicing(None, None, 0.0, 7, AUG, carry_forward_revenue=496582.27)
    assert basis == INVOICING_CARRY and abs(amount - 496582.27 * 7 / 31) < 1e-9
    amount, basis = select_invoicing(None, None, 0.0, 2, AUG, carry_forward_revenue=496582.27)
    assert basis == INVOICING_CARRY and abs(amount - 496582.27 * 2 / 31) < 1e-9
    # AR for the month beats the carry-forward; a zero carry-forward is none
    assert select_invoicing(None, None, 31000.0, 7, AUG, carry_forward_revenue=999.0)[1] == INVOICING_AR
    amount, basis = select_invoicing(None, None, 0.0, 7, AUG, carry_forward_revenue=0.0)
    assert basis == BASIS_NONE and amount == 0.0
    amount, basis = select_invoicing(None, None, 0.0, 7, AUG)
    assert basis == BASIS_NONE and amount == 0.0


def test_carry_forward_source_is_latest_recent_closed_month_with_greatest_of_job_cost_and_ar() -> None:
    closed = [date(2026, m, 1) for m in range(1, 8)]                   # Jan..Jul closed
    jc = {date(2026, 7, 1): 496582.27, date(2026, 6, 1): 560667.69, date(2026, 3, 1): 100.0}
    assert carry_forward_source(closed, jc, AUG) == (date(2026, 7, 1), 496582.27, "job_cost")
    # a partial July job-cost row loses to the July AR billing (IAG1: $18,636 vs $144,054)
    assert carry_forward_source(closed, {date(2026, 7, 1): 18636.16}, AUG, {date(2026, 7, 1): 144053.95}) == (date(2026, 7, 1), 144053.95, "ar_invoice")
    # no July job-cost row at all but July AR (BDL3/7): July AR is carried, not June's job-cost figure
    assert carry_forward_source(closed, {date(2026, 6, 1): 580884.60}, AUG, {date(2026, 7, 1): 498393.18}) == (date(2026, 7, 1), 498393.18, "ar_invoice")
    assert carry_forward_source(closed, {date(2026, 7, 1): 100.0}, AUG, {date(2026, 7, 1): 100.0})[2] == "job_cost"   # ties -> job_cost
    assert carry_forward_source(closed, {date(2026, 6, 1): 1.0}, AUG) == (date(2026, 6, 1), 1.0, "job_cost")
    # July, June and May empty: March is outside the 3-closed-month window
    assert carry_forward_source(closed, {date(2026, 3, 1): 100.0}, AUG, {date(2026, 3, 1): 900.0}) is None
    assert carry_forward_source(closed, {}, AUG, {date(2026, 5, 1): 100.0}) == (date(2026, 5, 1), 100.0, "ar_invoice")
    # only months before the slice month count
    assert carry_forward_source(closed, {date(2026, 7, 1): 1.0}, JUL) is None
    assert carry_forward_source([], jc, AUG) is None
    assert "carry_forward" in JOB_WEEK_SQL and "%(carry_months)s" in JOB_WEEK_SQL and "greatest(coalesce(j.revenue, 0), coalesce(a.revenue, 0))" in JOB_WEEK_SQL
    # a contract of 0 is still a contract (explicitly zero-billed month)
    assert select_invoicing(None, 0.0, 999.0, 7, AUG) == (0.0, INVOICING_CONTRACT)


def test_budget_precedence_daily_then_monthly_then_none() -> None:
    assert select_budget(1234.5, True, 31000.0, 7, JUL) == (1234.5, BUDGET_DAILY)
    amount, basis = select_budget(None, False, 31000.0, 7, JUL)
    assert basis == BUDGET_HBC and abs(amount - 7000.0) < 1e-9
    assert select_budget(None, False, None, 7, JUL) == (None, BASIS_NONE)
    # daily rows that do not cover the slice fall back to the monthly budget
    amount, basis = select_budget(500.0, False, 31000.0, 5, JUL)
    assert basis == BUDGET_HBC and abs(amount - 5000.0) < 1e-9


def test_dominant_basis_prefers_non_none_then_most_days() -> None:
    assert dominant_basis([(INVOICING_JOB_COST, 5, JUL), (BASIS_NONE, 2, AUG)]) == INVOICING_JOB_COST
    assert dominant_basis([(BASIS_NONE, 5, JUL), (INVOICING_AR, 2, AUG)]) == INVOICING_AR
    assert dominant_basis([(INVOICING_JOB_COST, 3, JUL), (INVOICING_CONTRACT, 4, AUG)]) == INVOICING_CONTRACT
    assert dominant_basis([(INVOICING_JOB_COST, 7, JUL)]) == INVOICING_JOB_COST
    assert dominant_basis([(BASIS_NONE, 7, JUL)]) == BASIS_NONE
    assert dominant_basis([]) == BASIS_NONE


# ── site codes and settings ──────────────────────────────────────────────────
def test_site_code_extraction() -> None:
    assert site_code("Amazon - LGB3") == "LGB3"
    assert site_code("Amazon - BDL3/7") == "BDL3/7"
    assert site_code("Amazon - DET6 MM") == "DET6 MM"
    assert site_code("Amazon - Project - Crane IFS") == "Project - Crane IFS"
    assert site_code("Plano ISD") == "Plano ISD"
    assert site_code("  FXG_562 / 3562 Wilmar MN ") == "FXG_562 / 3562 Wilmar MN"
    assert site_code(None) is None


def test_agency_sub_setting_validation() -> None:
    cfg = agency_sub_setting({"vendor_match": "KM Group", "pct": "0.7", "site_jobs": {"lgb3": 500, "APC2": "505"}})
    assert cfg["vendor_match"] == "km group" and cfg["pct"] == 0.7
    assert cfg["site_jobs"] == {"LGB3": "500", "APC2": "505"} and cfg["enabled"]
    assert not agency_sub_setting({"vendor_match": "", "pct": 0.7, "site_jobs": {"LGB3": "500"}})["enabled"]
    assert not agency_sub_setting({"vendor_match": "km group", "pct": 0, "site_jobs": {"LGB3": "500"}})["enabled"]
    assert not agency_sub_setting({"vendor_match": "km group", "pct": 0.7, "site_jobs": {}})["enabled"]
    defaults = agency_sub_setting(None)
    assert defaults["site_jobs"] == {"LGB3": "500", "APC2": "505", "PSP3": "504"} and defaults["enabled"]


def test_router_helpers_and_notes() -> None:
    assert bu_key("Crane West") == "crane_west" and bu_key("Crane IFS") == "crane_ifs"
    rows = [
        {"invoicing_basis": INVOICING_JOB_COST, "invoicing": 100.0, "budget_basis": BUDGET_DAILY, "sub_basis": "job_cost", "sub_dollars": 10.0, "sub_estimated": False},
        {"invoicing_basis": INVOICING_JOB_COST, "invoicing": 50.0, "budget_basis": BUDGET_HBC, "sub_basis": SUB_PROJECTION, "sub_dollars": 5.0, "sub_estimated": True},
        {"invoicing_basis": BASIS_NONE, "invoicing": 0.0, "budget_basis": BASIS_NONE, "sub_basis": BASIS_NONE, "sub_dollars": 0.0, "sub_estimated": False},
        {"invoicing_basis": INVOICING_CARRY, "invoicing": 25.0, "invoicing_estimated": True, "carry_forward_source": "ar_invoice", "budget_basis": BUDGET_HBC, "sub_basis": BASIS_NONE, "sub_dollars": 0.0, "sub_estimated": False},
    ]
    assert summarize_bases(rows, "invoicing_basis") == {INVOICING_JOB_COST: 2, BASIS_NONE: 1, INVOICING_CARRY: 1}
    notes = build_notes(rows, date(2026, 8, 24), agency_sub_setting(None), 0, (date(2025, 12, 5), date(2026, 7, 26)), "trailing_job_rate")
    joined = "\n".join(notes)
    assert "12/53" in joined and "x 0.5" in joined and "QA scores" in joined and "Elite" in joined
    assert "job_cost_month_prorated = 2 site(s), $150" in joined
    assert "Contract billing table is empty" in joined
    assert "$5 of $15 sub is projected (estimated)" in joined and "trailing_3mo_projection" in joined
    assert "Unexpected basis labels" not in joined
    assert "1 of 4 site(s) are on the carry_forward basis ($25 of $175 invoicing is estimated; source: ar_invoice = 1)" in joined
    assert "daily rows span 2025-12-05 to 2026-07-26" in joined


def test_reset_list_covers_the_weekly_inputs_and_mart() -> None:
    assert {"core.fact_daily_budget", "core.contract_billing", "mart.job_week"} <= set(RESET_TABLES)


# ── sub-accounts (migration 014) ─────────────────────────────────────────────
def test_sub_account_education_prefixes_and_customer_fallback() -> None:
    edu = "Education"
    assert sub_account_for(edu, "Plano - Plano East Senior High School", None) == "Plano Independent School District"
    assert sub_account_for(edu, "Plano Independent School District", "Plano Independent School District") == "Plano Independent School District"
    assert sub_account_for(edu, "WS-Blue Haze Elementary", None) == "White Settlement Independent School District"
    assert sub_account_for(edu, "White Settlement Independent School District", "White Settlement Independent School Dist.") \
        == "White Settlement Independent School District"
    assert sub_account_for(edu, "Henderson-Wylie Primary School", "") == "Henderson Independent School District"
    assert sub_account_for(edu, "Henderson High School", None) == "Henderson Independent School District"
    assert sub_account_for(edu, "Crowley - N Crowley High School", None) == "Crowley Independent School District"
    assert sub_account_for(edu, "Crowley ISD", "Crowley ISD") == "Crowley Independent School District"
    assert sub_account_for(edu, "Crawley - Middle School", None) == "Crowley Independent School District"   # spelling variant
    assert sub_account_for(edu, "Aldine ISD - Admin", None) == "Aldine Independent School District"
    # an inner word matches on the customer_name basis ("... plano - x"), a run-on word does not
    assert sub_account_for(edu, "ISD Plano - Wells Elementary", None) == "Plano Independent School District"
    assert sub_account_for(edu, "Planoville Academy", None) == edu
    # no prefix: the customer name when it differs from the account, else the account
    assert sub_account_for(edu, "Jackson-Madison County Schools District", "Jackson-Madison County Schools District") \
        == "Jackson-Madison County Schools District"
    assert sub_account_for(edu, "Some School", None) == edu
    assert sub_account_for(edu, "Some School", "  education ") == edu


def test_sub_account_fedex_prefix_only_then_default() -> None:
    assert sub_account_for("FedEx", "FXE_AGCA Pittsburgh PA", "FedEx") == "FedEx Express (FXE)"
    assert sub_account_for("FedEx", "FXG_562 / 3562 Wilmar MN", None) == "FedEx Ground (FXG)"
    assert sub_account_for("FedEx", "fxe_dfw Dallas TX", "FedEx - CA") == "FedEx Express (FXE)"
    # job_prefix basis: the customer name never applies; the default does
    assert sub_account_for("FedEx", "FedEx - Arcadia, CA", "FedEx - CA") == "FedEx"
    assert sub_account_for("FedEx", "FXPO_Enterprise Pricing Office Lakeland FL", "FedEx") == "FedEx"
    assert sub_account_for("FedEx", "FedEx - FXE Ramp", "FedEx") == "FedEx"                  # inner words do not count
    assert sub_account_for("FedEx", None, None) == "FedEx"


def test_sub_account_other_accounts_customer_vs_account() -> None:
    assert sub_account_for("Amazon", "Amazon - LGB3", "Amazon.com Services LLC") == "Amazon.com Services LLC"
    assert sub_account_for("Amazon", "Amazon - Mgmt", None) == "Amazon"
    assert sub_account_for("Whole Foods", "Whole Foods - BLV", "Whole Foods") == "Whole Foods"
    assert sub_account_for("Whole Foods", "Whole Foods - BLW", "Whole Foods Market") == "Whole Foods Market"
    assert sub_account_for("Aldi", "Aldi - WEB", "ALDI Inc.") == "ALDI Inc."
    assert sub_account_for(None, "X", None) == "Unassigned"
    # explicit rules win over the defaults; a job_prefix rule without a default falls back to the account
    rules = {"Amazon": {"basis": "job_prefix", "prefix_map": {"amazon - project": "Amazon projects"}}}
    assert sub_account_for("Amazon", "Amazon - Project - Crane IFS", "Amazon.com Services LLC", rules) == "Amazon projects"
    assert sub_account_for("Amazon", "Amazon - LGB3", "Amazon.com Services LLC", rules) == "Amazon"
    # longest key wins
    rules = {"*": {"basis": "customer_name", "prefix_map": {"ws": "short", "ws-": "long"}}}
    assert sub_account_for("Education", "WS-North Elementary", None, rules) == "long"


def test_sub_account_rules_setting_validation() -> None:
    assert sub_account_rules_setting(None) == DEFAULT_SUB_ACCOUNT_RULES
    assert sub_account_rules_setting({}) == DEFAULT_SUB_ACCOUNT_RULES
    cfg = sub_account_rules_setting({"FedEx": {"basis": "JOB_PREFIX", "prefix_map": {" FXE ": " Express "}, "default": " FedEx "},
                                     "Bad": "nope", "Loose": {"basis": "??", "prefix_map": "x"}})
    assert cfg["FedEx"] == {"basis": "job_prefix", "prefix_map": {"fxe": "Express"}, "default": "FedEx"}
    assert cfg["Loose"] == {"basis": "customer_name", "prefix_map": {}} and "Bad" not in cfg
    assert "UPDATE mart.job_week" in SUB_ACCOUNT_UPDATE_SQL and "unnest(" in SUB_ACCOUNT_UPDATE_SQL


# ── delivery scoping ─────────────────────────────────────────────────────────
def test_delivery_param_and_scope_sql() -> None:
    assert parse_delivery(None) == "all" and parse_delivery(" Self_Perform ") == DELIVERY_SELF
    try:
        parse_delivery("vendor")
    except HTTPException as exc:                       # noqa: F821 - imported below
        assert exc.status_code == 422
    else:
        raise AssertionError("expected 422")
    keys = ["FedEx", "Amazon"]
    assert scope_clause("All", keys) == (" AND parent_account = ANY(%s::text[])", [keys])
    assert scope_clause("Education", keys) == (" AND parent_account = %s", ["Education"])
    clause, params = scope_clause("Education", keys, " Plano Independent School District ", DELIVERY_SUB)
    assert clause == f" AND parent_account = %s AND sub_account = %s AND {DELIVERY_SQL} = %s"
    assert params == ["Education", "Plano Independent School District", DELIVERY_SUB]
    # NULL delivery_model: self-performed when the row has hours, else subcontracted (SQL and Python twins agree)
    assert "coalesce(delivery_model, CASE WHEN hours > 0 THEN 'self_perform' ELSE 'subcontracted' END)" == DELIVERY_SQL
    assert effective_delivery({"delivery_model": None, "hours": 12.0}) == DELIVERY_SELF
    assert effective_delivery({"delivery_model": None, "hours": 0}) == DELIVERY_SUB
    assert effective_delivery({"delivery_model": "subcontracted", "hours": 40}) == DELIVERY_SUB
    base = {"invoicing_basis": INVOICING_CARRY, "invoicing": 1000.0, "invoicing_estimated": True, "carry_forward_source": "job_cost",
            "budget_basis": BUDGET_HBC, "sub_basis": BASIS_NONE, "sub_estimated": False}
    rows = [
        {**base, "delivery_model": "self_perform", "hours": 40, "direct_dollars": 800.0, "ot_dollars": 50.0, "sub_dollars": 0.0},
        {**base, "delivery_model": None, "hours": 10, "direct_dollars": 200.0, "ot_dollars": 0.0, "sub_dollars": 0.0},
        {**base, "delivery_model": "subcontracted", "hours": 0, "direct_dollars": 0.0, "ot_dollars": 0.0, "sub_dollars": 3000.0, "sub_basis": "job_cost"},
    ]
    split = delivery_split(rows)
    assert split[DELIVERY_SELF] == {"sites": 2, "labor": 1050.0, "vendor": 0.0}
    assert split[DELIVERY_SUB] == {"sites": 1, "labor": 0.0, "vendor": 3000.0}
    notes = "\n".join(build_notes(rows, date(2026, 8, 24), agency_sub_setting(None), 0, (None, None), None))
    assert "Delivery split for week of 2026-08-24: 2 self-performed site(s) ($1,050 labor" in notes
    assert "1 subcontracted site(s) ($3,000 vendor cost" in notes and "1 such site(s) this week" in notes


# ── accounts shape ───────────────────────────────────────────────────────────
def test_build_accounts_shape() -> None:
    keys = [{"name": "FedEx", "label": "FedEx (incl. FXE, FXG)"}, {"name": "Education", "label": "School districts"}]
    sites = [
        {"name": "FedEx", "sub_account": "FedEx Express (FXE)", "job_number": "1", "delivery": "subcontracted", "company": "Crane IFS"},
        {"name": "FedEx", "sub_account": "FedEx Express (FXE)", "job_number": "2", "delivery": "self_perform", "company": "Sarus"},
        {"name": "FedEx", "sub_account": "FedEx Ground (FXG)", "job_number": "3", "delivery": "subcontracted", "company": "Crane IFS"},
        {"name": "FedEx", "sub_account": "FedEx", "job_number": "4", "delivery": "self_perform", "company": "Crane West"},
        {"name": "FedEx", "sub_account": "FedEx", "job_number": "5", "delivery": "self_perform", "company": "Crane West"},
        {"name": "Education", "sub_account": None, "job_number": "9", "delivery": "self_perform", "company": None},
        {"name": "Amazon", "sub_account": "Amazon.com Services LLC", "job_number": "500", "delivery": "subcontracted", "company": "Crane West"},
    ]
    accounts = build_accounts(keys, sites, ["Crane West", "Crane IFS", "Crane Southwest", "Sarus"])
    assert [a["name"] for a in accounts] == ["All", "FedEx", "Education"]     # Amazon is not a key account here
    assert accounts[0] == {"name": "All", "label": "All key accounts", "sites": 6, "business_units": ["Crane West", "Crane IFS", "Sarus"],
                           "delivery": {"self_perform": 4, "subcontracted": 2}}
    fedex = accounts[1]
    assert fedex["sites"] == 5 and fedex["delivery"] == {"self_perform": 3, "subcontracted": 2}
    assert fedex["business_units"] == ["Crane West", "Crane IFS", "Sarus"]
    assert fedex["sub_accounts"] == [
        {"name": "FedEx", "sites": 2, "delivery": {"self_perform": 2, "subcontracted": 0}},
        {"name": "FedEx Express (FXE)", "sites": 2, "delivery": {"self_perform": 1, "subcontracted": 1}},
        {"name": "FedEx Ground (FXG)", "sites": 1, "delivery": {"self_perform": 0, "subcontracted": 1}},
    ]
    # a job not yet labelled (NULL sub_account) is listed under the account name
    assert accounts[2]["sub_accounts"] == [{"name": "Education", "sites": 1, "delivery": {"self_perform": 1, "subcontracted": 0}}]
    assert accounts[2]["business_units"] == []


# ── vendor cost: projection (migration 015) ─────────────────────────────────
MAY, JUN = date(2026, 5, 1), date(2026, 6, 1)


def test_project_weekly_sub_averages_the_last_three_closed_months() -> None:
    # weekly rates: May 31,000/31*7 = 7,000; June 30,000/30*7 = 7,000; July 62,000/31*7 = 14,000 -> average 9,333.33
    months = [(MAY, 31000.0), (JUN, 30000.0), (JUL, 62000.0)]
    rate = trailing_weekly_sub_rate(months)
    assert rate is not None and abs(rate - 28000.0 / 3) < 1e-9
    assert abs(project_weekly_sub(months, 7, 31) - 28000.0 / 3) < 1e-9                 # a full week in August
    assert abs(project_weekly_sub(months, 2, 31) - 28000.0 / 3 * 2 / 7) < 1e-9         # the 2 August days of a straddle week
    # order of the input does not matter, and only the 3 most recent months count
    older = [(date(2026, 2, 1), 1e9), (JUL, 62000.0), (MAY, 31000.0), (JUN, 30000.0)]
    assert abs(project_weekly_sub(older, 7, 31) - 28000.0 / 3) < 1e-9
    assert TRAILING_SUB_MONTHS == 3
    # the weekly slices of a projected month reconcile to the projected month (rate x days_in_month / 7)
    total = 0.0
    for k in range(6):
        w = date.fromordinal(date(2026, 7, 27).toordinal() + 7 * k)
        total += project_weekly_sub(months, month_overlap_days(w, AUG), 31)
    assert abs(total - 28000.0 / 3 * 31 / 7) < 1e-6


def test_project_weekly_sub_with_fewer_months_and_zero() -> None:
    assert abs(project_weekly_sub([(JUL, 62000.0)], 7, 30) - 14000.0) < 1e-9             # one month: its own weekly rate
    assert abs(project_weekly_sub([(JUN, 30000.0), (JUL, 62000.0)], 7, 30) - 10500.0) < 1e-9
    # a booked 0 in a job-cost month lowers the average; no job-cost month at all projects 0
    assert abs(project_weekly_sub([(JUN, 0.0), (JUL, 62000.0)], 7, 30) - 7000.0) < 1e-9
    assert project_weekly_sub([], 7, 30) == 0.0 and trailing_weekly_sub_rate([]) is None
    assert project_weekly_sub([(JUL, 62000.0)], 0, 30) == 0.0
    # the SQL mirrors the rule: a projection basis, the trailing window and the per-slice monthly figure
    assert "'trailing_3mo_projection'" in JOB_WEEK_SQL and "%(trailing_months)s" in JOB_WEEK_SQL and "'sub_month'" in JOB_WEEK_SQL
    assert "'carry_forward'" not in JOB_WEEK_SQL.split("-- subcontract:")[1].split("-- budget:")[0]


# ── vendor cost: live AP look ────────────────────────────────────────────────
def test_vendor_types_setting_and_matching() -> None:
    assert vendor_types_setting(None) == DEFAULT_SUBCONTRACTOR_VENDOR_TYPES
    assert vendor_types_setting([]) == DEFAULT_SUBCONTRACTOR_VENDOR_TYPES
    assert vendor_types_setting(" Subcontract ") == DEFAULT_SUBCONTRACTOR_VENDOR_TYPES        # not a list
    assert vendor_types_setting([" Subcontract ", "janitorial", "JANITORIAL", 6, "9", "", True, None]) == ["subcontract", "janitorial", 6, 9]
    terms = vendor_types_setting(["subcontract", "janitorial", 6])
    # type label first, then the vendor name; the label is the vendor_type when the feed carries one
    assert match_subcontractor_vendor("Subcontractor", "ABC Services", None, terms) == "Subcontractor"
    assert match_subcontractor_vendor(None, "Advantage Janitorial", None, terms) == "janitorial"
    assert match_subcontractor_vendor("", "Cape Fear JANITORIAL LLC", 3, terms) == "janitorial"
    assert match_subcontractor_vendor(None, "KM Group", 6, terms) == "type 6"                   # vendor_type_id match
    assert match_subcontractor_vendor("Staffing", "KM Group", 6, terms) == "Staffing"
    assert match_subcontractor_vendor(None, "Georgia Power", 3, terms) is None
    assert match_subcontractor_vendor(None, None, None, terms) is None
    assert match_subcontractor_vendor("Agency", "Jobble", None, DEFAULT_SUBCONTRACTOR_VENDOR_TYPES) == "Agency"
    # vendor_type_labels (migration 016): the id's label replaces "type N" and a name-matched term when the id is labelled
    labels = vendor_type_labels_setting({"6": "Subcontractor", 9: "Professional", "": "x", "7": ""})
    assert labels == {"6": "Subcontractor", "9": "Professional"}
    assert vendor_type_labels_setting(None) == {} and vendor_type_labels_setting(["6"]) == {}
    assert match_subcontractor_vendor(None, "KM Group, Inc.", 6, terms, labels) == "Subcontractor"
    assert match_subcontractor_vendor(None, "Advantage Janitorial", 6, terms, labels) == "Subcontractor"
    assert match_subcontractor_vendor(None, "Advantage Janitorial", 1, terms, labels) == "janitorial"
    assert match_subcontractor_vendor("Staffing", "KM Group", 6, terms, labels) == "Staffing"
    assert match_subcontractor_vendor(None, "KM Group", 7, terms, labels) is None
    assert scope_label("All", None, "all") == "all key accounts"
    assert scope_label("FedEx", "FedEx Express (FXE)", DELIVERY_SUB) == "account FedEx / FedEx Express (FXE) / subcontracted sites"


def test_dominant_month_of_a_week() -> None:
    assert dominant_month(date(2026, 8, 24)) == AUG
    assert dominant_month(date(2026, 7, 27)) == JUL          # 5 July days, 2 August days
    assert dominant_month(date(2026, 8, 31)) == date(2026, 9, 1)   # 1 August day, 6 September days


def test_build_vendor_block_shape_and_sums() -> None:
    aug_key, sep_key = "2026-08-01", "2026-09-01"
    closed = [date(2026, 2, 1), date(2026, 3, 1), date(2026, 4, 1), MAY, JUN, JUL]
    # the selected week (Aug 24) rows carry, per month slice, the monthly figure the slice came from
    rows = [
        {"job_number": "500", "month_shares": {aug_key: {"days": 7, "sub_basis": SUB_PROJECTION, "sub_estimated": True, "sub_month": 41333.33}}},
        {"job_number": "505", "month_shares": {aug_key: {"days": 7, "sub_basis": SUB_AGENCY, "sub_estimated": False, "sub_month": 13500.0}}},
        {"job_number": "510", "month_shares": {aug_key: {"days": 7, "sub_basis": BASIS_NONE, "sub_estimated": False, "sub_month": 0}}},
        {"job_number": "511", "month_shares": {aug_key: {"days": 7, "sub_basis": SUB_PROJECTION, "sub_estimated": True, "sub_month": 1000.0}}},
    ]
    ap = [
        {"month": AUG, "vendor_number": 1150, "vendor_name": "Advantage Janitorial", "vendor_type": None, "vendor_type_id": 6, "invoices": 3, "invoiced": 12000.0, "through": date(2026, 8, 20)},
        {"month": AUG, "vendor_number": 1236, "vendor_name": "Cape Fear Janitorial LLC", "vendor_type": None, "vendor_type_id": 6, "invoices": 1, "invoiced": 3000.0, "through": date(2026, 8, 28)},
        {"month": AUG, "vendor_number": 1300, "vendor_name": "KM Group", "vendor_type": "Subcontractor", "vendor_type_id": 6, "invoices": 4, "invoiced": 40000.0, "through": date(2026, 8, 25)},
        {"month": AUG, "vendor_number": 1400, "vendor_name": "Georgia Power", "vendor_type": None, "vendor_type_id": 3, "invoices": 2, "invoiced": 900.0, "through": date(2026, 8, 30)},
        {"month": JUL, "vendor_number": 1150, "vendor_name": "Advantage Janitorial", "vendor_type": None, "vendor_type_id": 6, "invoices": 2, "invoiced": 8000.0, "through": date(2026, 7, 31)},
        {"month": JUL, "vendor_number": 1400, "vendor_name": "Georgia Power", "vendor_type": None, "vendor_type_id": 3, "invoices": 1, "invoiced": 500.0, "through": date(2026, 7, 15)},
        {"month": JUN, "vendor_number": 1400, "vendor_name": "Georgia Power", "vendor_type": None, "vendor_type_id": 3, "invoices": 1, "invoiced": 450.0, "through": date(2026, 6, 15)},
    ]
    history_job_cost = {JUL: 709680.0, JUN: 147322.0, MAY: 111580.0}
    history_all = {JUL: 3200000.0, JUN: 900000.0}
    terms = vendor_types_setting(["janitorial", "subcontract"])
    block = build_vendor_block(AUG, "in_progress", date(2026, 9, 3), closed, rows, ap, history_job_cost, terms,
                               history_job_cost_all=history_all, projected_all=1234567.891, labels={"6": "Subcontractor"},
                               scope_label="account Amazon")
    notes = block.pop("notes")
    assert block["month"] == aug_key and block["month_status"] == "in_progress" and block["as_of"] == "2026-09-03"
    assert block["projected_month_sub"] == 55833.33 and block["projected_basis"] == SUB_PROJECTION
    assert block["projected_month_sub_all"] == 1234567.89
    assert block["scope_note"].startswith("projected_month_sub and history[].job_cost_sub are scoped to account Amazon; ")
    assert "company-wide" in block["scope_note"] and "not linked to jobs" in block["scope_note"]
    assert block["sites"] == 4 and block["sites_projected"] == 2
    assert block["sites_by_basis"] == {SUB_PROJECTION: 2, SUB_AGENCY: 1, BASIS_NONE: 1}
    live = block["ap_live"]
    assert live["invoiced_to_date"] == 55000.0 and live["invoices"] == 8 and live["vendors"] == 3 and live["through"] == "2026-08-28"
    assert live["all_invoiced"] == 55900.0
    assert live["by_vendor_type"] == [{"vendor_type": "Subcontractor", "invoiced": 55000.0, "invoices": 8, "vendors": 3}]
    # without labels the name-matched type-6 vendors group under the term and the id match under "type 6"
    plain = build_vendor_block(AUG, "in_progress", date(2026, 9, 3), closed, rows, ap, history_job_cost, terms)
    assert plain["ap_live"]["by_vendor_type"] == [
        {"vendor_type": "Subcontractor", "invoiced": 40000.0, "invoices": 4, "vendors": 1},
        {"vendor_type": "janitorial", "invoiced": 15000.0, "invoices": 4, "vendors": 2},
    ]
    assert plain["projected_month_sub_all"] is None and all(h["job_cost_sub_all"] == 0.0 for h in plain["history"])
    typed = build_vendor_block(AUG, "in_progress", date(2026, 9, 3), closed, rows, ap, history_job_cost, vendor_types_setting([6]))
    assert typed["ap_live"]["by_vendor_type"] == [
        {"vendor_type": "Subcontractor", "invoiced": 40000.0, "invoices": 4, "vendors": 1},
        {"vendor_type": "type 6", "invoiced": 15000.0, "invoices": 4, "vendors": 2},
    ]
    # history: the last 6 closed months up to the selected month, job-cost sub scoped, AP company-wide
    assert [h["month"] for h in block["history"]] == ["2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01"]
    assert block["history"][-1] == {"month": "2026-07-01", "job_cost_sub": 709680.0, "job_cost_sub_all": 3200000.0,
                                    "ap_subcontractor_invoiced": 8000.0, "ap_all_invoiced": 8500.0}
    assert block["history"][-2] == {"month": "2026-06-01", "job_cost_sub": 147322.0, "job_cost_sub_all": 900000.0,
                                    "ap_subcontractor_invoiced": 0.0, "ap_all_invoiced": 450.0}
    assert block["history"][0]["job_cost_sub"] == 0.0 and block["history"][0]["ap_all_invoiced"] == 0.0
    joined = "\n".join(notes)
    assert "COMPANY-WIDE" in joined and "not linked to jobs" in joined and "[janitorial, subcontract]" in joined
    assert "projected_month_sub $55,833" in joined and "trailing_3mo_projection = 2, agency_ap = 1, none = 1" in joined
    assert "through 2026-08-28, 8 invoice(s) of 3 vendor(s), $55,000 of $55,900" in joined
    # a closed month: the job-cost basis, a full-month AP look, no null
    jul_rows = [{"job_number": "500", "month_shares": {"2026-07-01": {"days": 7, "sub_basis": SUB_JOB_COST, "sub_estimated": False, "sub_month": 12345.0}}}]
    jul = build_vendor_block(JUL, "closed", date(2026, 9, 3), closed, jul_rows, ap, history_job_cost, terms)
    assert jul["projected_basis"] == SUB_JOB_COST and jul["projected_month_sub"] == 12345.0 and jul["sites_projected"] == 0
    assert jul["ap_live"]["invoiced_to_date"] == 8000.0 and [h["month"] for h in jul["history"]][-1] == "2026-07-01"
    assert "the closed month's job-cost subcontractors line" in "\n".join(jul["notes"])
    # no AP loaded for the month -> ap_live is null and the note says so
    sep = build_vendor_block(date(2026, 9, 1), "in_progress", date(2026, 9, 3), closed,
                             [{"job_number": "500", "month_shares": {sep_key: {"days": 6, "sub_basis": SUB_PROJECTION, "sub_estimated": True, "sub_month": 40000.0}}}],
                             ap, history_job_cost, terms)
    assert sep["ap_live"] is None and sep["projected_month_sub"] == 40000.0 and "ap_live is null" in "\n".join(sep["notes"])
    # AP loaded for the month but nothing matched yet: zeros, through null, and the note says so
    none = build_vendor_block(JUN, "closed", date(2026, 9, 3), closed, jul_rows, ap, history_job_cost, terms)
    assert none["ap_live"] == {"invoiced_to_date": 0.0, "invoices": 0, "vendors": 0, "through": None, "all_invoiced": 450.0, "by_vendor_type": []}
    assert "no matching invoice dated in the month yet ($450 AP invoiced in total)" in "\n".join(none["notes"])
