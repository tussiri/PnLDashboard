"""Pure tests for the finance reference source rules (no database).

Pins: account-group matching, company aliasing / namespaces, the AR collectible rule, aging bucket
mapping, the trailing-rate fallback chain, the hours-budget-comparison de-duplication rule, the AR
register -> invoice aggregation, and the export string parsers.
"""
from __future__ import annotations

from datetime import date, time

from app.sources import rules
from app.sources.finance_reference import REAL_JOB_TIER_MAP, RESET_TABLES, read_job_master
from app.routers.labor import labor_cost_definition

ACCOUNT_GROUPS = [
    {"name": "Amazon", "terms": ["amazon"], "job_numbers": [], "customer_terms": ["amazon"]},
    {"name": "FedEx", "terms": ["fedex", "fed ex", "fxg"], "job_numbers": [], "customer_terms": ["fedex", "fed ex", "fxg"]},
    {"name": "Education", "terms": ["white settlement", "ws-", "isd"], "job_numbers": [], "customer_terms": ["whit01", "isd"]},
    {"name": "Aldi", "terms": ["aldi, inc"], "job_numbers": ["164"], "customer_terms": ["aldi, inc"]},
    {"name": "Other", "terms": [], "job_numbers": [], "customer_terms": []},
]
TREATMENT_RULES = [{"match": "ServiceMaster|Service Master|Elite| FM ", "treatment": "offset_settlement", "include_collectible_ar": False}]


# ── account groups ───────────────────────────────────────────────────────────
def test_account_group_by_job_name_term() -> None:
    assert rules.match_account_group(job_number="4", job_name="Amazon - DTW1", customer_names=[], groups=ACCOUNT_GROUPS) == "Amazon"
    assert rules.match_account_group(job_number="400", job_name="FXG_562 / 3562 Wilmar MN", customer_names=[], groups=ACCOUNT_GROUPS) == "FedEx"


def test_account_group_by_job_number_and_customer_term() -> None:
    assert rules.match_account_group(job_number="164", job_name="Some store", customer_names=[], groups=ACCOUNT_GROUPS) == "Aldi"
    assert rules.match_account_group(job_number="127", job_name="West Elementary", customer_names=["WHIT01 district"], groups=ACCOUNT_GROUPS) == "Education"
    assert rules.match_account_group(job_number="1", job_name="Akrometrix", customer_names=["Akrometrix", None], groups=ACCOUNT_GROUPS) is None


def test_account_group_order_and_override() -> None:
    # "Amazon" is listed first, so a job matching Amazon and FedEx terms is Amazon.
    assert rules.match_account_group(job_number="9", job_name="Amazon pallets via FedEx", customer_names=[], groups=ACCOUNT_GROUPS) == "Amazon"
    assert rules.match_account_group(job_number="9", job_name="Amazon pallets", customer_names=[], groups=ACCOUNT_GROUPS, override="Whole Foods") == "Whole Foods"
    # The catch-all group with no rules never matches, so the caller can fall back to the AR customer.
    assert rules.match_account_group(job_number="77", job_name="Plain office", customer_names=["Nobody LLC"], groups=[{"name": "Other"}]) is None


def test_vertical_regex() -> None:
    verticals = [{"name": "Education", "match": "school|college|universit|charter|academ"}, {"name": "Government", "match": "city of|county"}]
    assert rules.match_vertical("Lincoln High School", [], verticals) == "Education"
    assert rules.match_vertical("Site 12", ["City of Plano"], verticals) == "Government"
    assert rules.match_vertical("Warehouse", ["Acme"], verticals) is None


# ── companies ────────────────────────────────────────────────────────────────
def test_company_aliases_defaults_and_setting_override() -> None:
    aliases = rules.normalise_aliases({"Crane Integrated Facility Services Inc.": "Crane IFS", "New Opco LLC": "New Opco"})
    assert rules.alias_company("ServiceMaster by Crane IFS", aliases) == "Crane IFS"
    assert rules.alias_company("crane west opco llc", aliases) == "Crane West"
    assert rules.alias_company("Sarus Co LLC", aliases) == "Sarus"
    assert rules.alias_company("Crane", aliases) == "Crane IFS"       # batch-level name
    assert rules.alias_company("New Opco LLC", aliases) == "New Opco"
    assert rules.alias_company("Unknown Entity", aliases) == "Unknown Entity"
    assert rules.alias_company("", aliases) is None and rules.alias_company(None) is None


def test_namespace_and_vendor_offset() -> None:
    assert rules.namespace_for("ServiceMaster by Sarus Co") == "Sarus"
    assert rules.namespace_for("Sarus") == "Sarus"
    assert rules.namespace_for("Crane West Opco LLC") == "Crane"
    assert rules.namespace_for(None) == "Crane"
    assert rules.warehouse_vendor_number("Crane", 1064) == 1064
    assert rules.warehouse_vendor_number("Sarus", 1064) == 1064 + rules.SARUS_VENDOR_OFFSET


# ── collectible AR ───────────────────────────────────────────────────────────
def test_collectible_rule() -> None:
    assert rules.is_collectible("Amazon.com Services LLC", None, TREATMENT_RULES) is True
    assert rules.is_collectible("ServiceMaster of Edmonton", None, TREATMENT_RULES) is False
    # The billed customer decides; the parent is only consulted when the customer name is blank.
    assert rules.is_collectible("FedEx", "ServiceMaster Clean National Accounts", TREATMENT_RULES) is True
    assert rules.is_collectible(None, "Service Master Clean", TREATMENT_RULES) is False
    assert rules.is_collectible("ABC FM Services", None, TREATMENT_RULES) is False
    assert rules.is_collectible("ServiceMaster Elite", None, [{**TREATMENT_RULES[0], "include_collectible_ar": True}]) is True
    assert rules.is_collectible("ServiceMaster Elite", None, []) is True


# ── aging buckets ────────────────────────────────────────────────────────────
def test_ar_bucket_from_groups_and_days() -> None:
    assert rules.ar_bucket_from_groups({"group0": "0", "group1": "702.00", "group2": "0", "group3": "0", "group4": "0"}) == "bucket_1_30"
    assert rules.ar_bucket_from_groups({"group0": "0", "group1": "0", "group2": "0", "group3": "0", "group4": "12.5"}) == "bucket_90_plus"
    assert rules.ar_bucket_from_groups({"group0": "5", "group1": "0"}) == "bucket_current"
    assert rules.ar_bucket_from_groups({"group1": "0"}) is None
    assert rules.ar_bucket_for_days(0) == "bucket_current"
    assert rules.ar_bucket_for_days(30) == "bucket_1_30"
    assert rules.ar_bucket_for_days(31) == "bucket_31_60"
    assert rules.ar_bucket_for_days(90) == "bucket_61_90"
    assert rules.ar_bucket_for_days(91) == "bucket_90_plus"


def test_ap_buckets_split_group1_by_days_past_due() -> None:
    not_due = rules.ap_buckets({"group1": "330.11", "group2": "0", "group3": "0", "group4": "0", "days_past_due": "-50"})
    assert not_due["bucket_current"] == 330.11 and not_due["bucket_1_30"] == 0
    past = rules.ap_buckets({"group1": "100", "group2": "0", "group3": "0", "group4": "0", "days_past_due": "12"})
    assert past["bucket_1_30"] == 100 and past["bucket_current"] == 0
    old = rules.ap_buckets({"group1": "0", "group2": "0", "group3": "0", "group4": "1379", "days_past_due": "200"})
    assert old["bucket_90_plus"] == 1379


# ── trailing rate ────────────────────────────────────────────────────────────
def _month_row(month: date, labor: float, hours: float, closed: bool = True) -> dict:
    return {"month": month, "direct_labor": labor, "actual_hours": hours, "closed": closed}


def test_trailing_rate_uses_last_three_closed_months_with_hours() -> None:
    rows = [
        _month_row(date(2026, 3, 1), 1000, 100),          # older, dropped by the 3-month window
        _month_row(date(2026, 4, 1), 2000, 100),
        _month_row(date(2026, 5, 1), 0, 0),               # no hours: ignored
        _month_row(date(2026, 6, 1), 3000, 100),
        _month_row(date(2026, 7, 1), 4000, 100),
        _month_row(date(2026, 8, 1), 9000, 100, closed=False),   # in progress: never used
    ]
    rate, basis = rules.trailing_rate(rows, company_rate=15.0, portfolio_rate=18.0)
    assert basis == "job"
    assert rate == (2000 + 3000 + 4000) / 300


def test_trailing_rate_fallbacks() -> None:
    open_only = [_month_row(date(2026, 8, 1), 9000, 100, closed=False)]
    assert rules.trailing_rate(open_only, company_rate=15.5, portfolio_rate=18.0) == (15.5, "company")
    assert rules.trailing_rate([], company_rate=None, portfolio_rate=18.25) == (18.25, "portfolio")
    assert rules.trailing_rate([], company_rate=None, portfolio_rate=None) == (None, "none")


# ── HBC de-duplication ───────────────────────────────────────────────────────
def test_hbc_job_budget_takes_the_single_carried_value() -> None:
    rows = [
        {"employee_number": "1", "bud_labor_dollars": "229051.20", "total_daily_budgeted_hours": "14315.70"},
        {"employee_number": "2", "bud_labor_dollars": "0.0000", "total_daily_budgeted_hours": "14315.70"},
        {"employee_number": "3", "bud_labor_dollars": "0.0000", "total_daily_budgeted_hours": "0"},
    ]
    budget, hours, consistent = rules.hbc_job_budget(rows)
    assert (budget, hours, consistent) == (229051.20, 14315.70, True)


def test_hbc_job_budget_flags_inconsistent_groups_and_empty_budgets() -> None:
    rows = [{"bud_labor_dollars": "100"}, {"bud_labor_dollars": "250"}]
    budget, hours, consistent = rules.hbc_job_budget(rows)
    assert budget == 250 and hours is None and consistent is False
    assert rules.hbc_job_budget([{"bud_labor_dollars": "0"}]) == (None, None, True)


# ── AR register aggregation ──────────────────────────────────────────────────
def test_register_rows_collapse_to_one_invoice_with_max_totals() -> None:
    header = {"invoice_number": "163233", "customer_number": "FEDX01", "customer_name": "FedEx Ground", "invoice_total": "202521.09",
              "revenue_total": "202521.09", "tax": "0", "invoice_date": "7/31/2026", "billing_period_from": "7/1/2026",
              "billing_period_to": "7/31/2026", "service_location_job_number": "800", "dist_amount": None}
    detail_1 = {**header, "invoice_total": "0.0000", "revenue_total": "0.0000", "dist_amount": "150000.00", "dist_job_number": "801"}
    detail_2 = {**header, "invoice_total": "0.0000", "revenue_total": "0.0000", "dist_amount": "52521.09", "dist_job_number": "817"}
    duplicate_from_second_batch = dict(header)
    inv = rules.aggregate_register_rows([detail_1, header, detail_2, duplicate_from_second_batch])
    assert inv["invoice_total"] == 202521.09 and inv["revenue_total"] == 202521.09
    assert inv["dist_total"] == 202521.09
    assert inv["job_number"] == "800" and inv["customer_number"] == "FEDX01"
    assert inv["invoice_date"] == date(2026, 7, 31) and inv["service_month"] == date(2026, 7, 1)
    assert inv["rows"] == 4


def test_register_service_month_falls_back_to_invoice_date() -> None:
    inv = rules.aggregate_register_rows([{"invoice_number": "1", "invoice_date": "9/30/2025", "invoice_total": "10", "revenue_total": "10"}])
    assert inv["service_month"] == date(2025, 9, 1) and inv["dist_total"] is None


def test_open_balance_basis() -> None:
    assert rules.open_balance_from_snapshot(1000.0, 250.0) == (750.0, "aging_snapshot")
    assert rules.open_balance_from_snapshot(1000.0, None) == (1000.0, "assumed_paid")


# ── parsers and geography ────────────────────────────────────────────────────
def test_export_parsers() -> None:
    assert rules.parse_export_date("8/10/2026") == date(2026, 8, 10)
    assert rules.parse_export_date("8/10/2026 3:00:11 AM") == date(2026, 8, 10)
    assert rules.parse_export_date("2026-08-10") == date(2026, 8, 10)
    assert rules.parse_export_date("13/45/2026") is None and rules.parse_export_date("") is None
    assert rules.parse_export_time("15:25") == time(15, 25) and rules.parse_export_time("25:00") is None
    assert rules.parse_number("1,234.50") == 1234.5 and rules.parse_number("abc") is None and rules.parse_number(True) is None
    assert rules.period_to_month(202607) == date(2026, 7, 1) and rules.period_to_month("bad") is None
    assert rules.parse_flag("True") is True and rules.parse_flag("0") is False and rules.parse_flag("maybe") is None


def test_region_country_and_centroid_key() -> None:
    assert rules.region_for_state("GA") == "Southeast" and rules.region_for_state("TX") == "Southwest"
    assert rules.region_for_state("MN") == "Midwest" and rules.region_for_state("WA") == "West"
    assert rules.region_for_state("ON") == "Canada" and rules.region_for_state("ZZ") is None
    assert rules.country_for_state("AB") == "CA" and rules.country_for_state("ga") == "US"
    assert rules.centroid_key(" Plano ", "tx") == "Plano|TX" and rules.centroid_key(None, "TX") is None


def test_job_master_csv_reader(tmp_path) -> None:
    path = tmp_path / "jobs.csv"
    path.write_text(
        "\ufeffJobNumber,Tier1_Description,Tier2_Description,Tier3_Description,Tier4_Description,Tier5_Description,Tier6_Description,Tier7_Description,"
        "Active,JobDescription,JobAddress1,JobAddress2,JobCity,JobState,JobZip,TypeID,TypeDescription,DiscontinueDate,DateToStart,DateEntered,"
        "CompanyNumber,CompanyName,ParentJobNumber,SupervisorID,Supervisor\n"
        "12,Plano,Texas,Southwest,Contract Janitorial,SMFM,Self-Service,None,False,WS-West Elementary,8901 White Settlement Rd,,Fort Worth,tx,76108,"
        "1,Education,7/31/2025,2/15/2026,4/24/2025 3:21:23 PM,3,Crane Southwest Opco LLC,112.0,26,Silvestre Perez\n",
        encoding="utf-8",
    )
    rows = read_job_master(path)
    assert len(rows) == 1
    row = rows[0]
    assert row["job_number"] == "12" and row["tiers"][3] == "Southwest" and row["tiers"][7] is None
    assert row["active"] is False and row["date_discontinued"] == date(2025, 7, 31) and row["date_to_start"] == date(2026, 2, 15)
    assert row["state"] == "TX" and row["parent_job_number"] == "112" and row["company_name"] == "Crane Southwest Opco LLC"


def test_reset_scope_and_tier_map() -> None:
    assert "ops.app_setting" not in RESET_TABLES and "mart.rebuild_log" not in RESET_TABLES
    assert {"core.dim_job", "core.fact_timekeeping", "mart.job_month", "mart.forecast_run_meta"} <= set(RESET_TABLES)
    # the live API's raw landings and watermarks survive a reference reload (migration 011 precedence)
    assert "raw.winteam_record" not in RESET_TABLES and "ops.source_watermark" not in RESET_TABLES
    assert REAL_JOB_TIER_MAP == {"branch": 1, "region": 3, "service_type": 4, "manager": 7, "vertical": 6}


def test_labor_cost_definition_follows_primary_source() -> None:
    assert "trailing" in labor_cost_definition("finance_reference")
    assert labor_cost_definition("winteam_api") == labor_cost_definition(None)


def test_a_job_rate_far_above_the_company_rate_is_not_a_wage() -> None:
    """Job cost with labor dollars but almost no hours (Norcross, job 34: $2,174 over 7.96 h) prices at the company rate."""
    rows = [_month_row(date(2026, 3, 1), 2173.98, 7.96)]
    assert rules.trailing_rate(rows, company_rate=21.4, portfolio_rate=20.0) == (21.4, "company")
    plausible = [_month_row(date(2026, 3, 1), 6000, 100)]  # $60/h: under 3x, kept
    assert rules.trailing_rate(plausible, company_rate=21.4, portfolio_rate=20.0) == (60.0, "job")
