"""The Sarus WinTeam database, read live beside the primary (Crane) one.

The two databases reuse each other's job, vendor, employee and invoice numbers, so these tests pin
the separation: Sarus rows land under their own raw names, core source and winteam_id prefix; they
resolve jobs through the Sarus map; and precedence gives each database its own window over the
export rows of its own company only, so a Sarus backfill never moves the Crane window and a Crane
invoice never hides a Sarus one.
"""
from __future__ import annotations

import re
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from app import marts, normalize
from app.config import Settings
from app.sources import rules
from app.tenants import API_SOURCES, PRIMARY, SARUS, SARUS_RESOURCE_NAMES
from app.winteam import PullResult, RESOURCES, WinTeamIngestion

from test_source_coexistence import RecordingConn, flat

MIGRATIONS = Path(__file__).resolve().parents[3] / "database" / "migrations"
MIGRATION_026 = MIGRATIONS / "026_sarus_tenant.sql"
SARUS_NORMALIZED = tuple(name for name in SARUS_RESOURCE_NAMES if name != "jobs")


# ── the tenants themselves ───────────────────────────────────────────────────
def test_tenants_never_share_a_key() -> None:
    assert PRIMARY.source != SARUS.source and set(API_SOURCES) == {PRIMARY.source, SARUS.source}
    assert PRIMARY.integration != SARUS.integration
    # the primary prefix must not be a prefix of Sarus ids read as primary ids: 'api:sarus:9' is never a Crane id
    assert SARUS.id_prefix.startswith(PRIMARY.id_prefix) and SARUS.id_prefix != PRIMARY.id_prefix
    assert PRIMARY.raw_resource("timekeeping") == "timekeeping"
    assert SARUS.raw_resource("timekeeping") == "sarus/timekeeping"
    assert SARUS.company == rules.NAMESPACE_SARUS


def test_sarus_settings_drop_the_primary_scoping() -> None:
    env = {
        "WINTEAM_BASE_URL": "https://example.test/wtnextgen", "WINTEAM_TENANT_ID": "crane", "WINTEAM_ENABLED": "true",
        "WINTEAM_LOCATION_IDS": "4,5", "WINTEAM_CUSTOMER_NUMBERS": "AMAZ01,FEDX01",
        "WINTEAM_SARUS_TENANT_ID": "sarus", "WINTEAM_SARUS_ENABLED": "true",
    }
    sarus = Settings.load(env).sarus_settings()
    assert sarus.winteam_tenant_id == "sarus" and sarus.winteam_enabled
    assert sarus.winteam_resources == SARUS_RESOURCE_NAMES
    assert sarus.winteam_location_ids == () and sarus.winteam_customer_numbers == ()
    assert set(SARUS_RESOURCE_NAMES) <= set(RESOURCES)


# ── normalizers ──────────────────────────────────────────────────────────────
def run_sarus() -> dict[str, list[tuple[str, Any]]]:
    out: dict[str, list[tuple[str, Any]]] = {}
    for name in SARUS_NORMALIZED:
        conn = RecordingConn({"company_numbers": {"1": "Crane IFS"}, "overtime_category_detail_ids": []})
        normalize.NORMALIZERS[name](conn, None, tenant=SARUS)
        out[name] = conn.statements
    return out


SARUS_RUN = run_sarus()


@pytest.mark.parametrize("name", SARUS_NORMALIZED)
def test_sarus_reads_its_own_raw_rows_and_writes_its_own_source(name: str) -> None:
    reads = [(flat(sql), params) for sql, params in SARUS_RUN[name] if "raw.v_winteam_current" in sql]
    assert reads, name
    for _, params in reads:
        assert params["resource"] == f"sarus/{name}"
        assert params["source"] == "winteam_sarus"
    for sql, params in SARUS_RUN[name]:
        text = flat(sql)
        # nothing is ever written under the primary source by the Sarus tenant
        if params and isinstance(params, dict) and "source" in params:
            assert params["source"] == "winteam_sarus", (name, text[:80])
        assert "'api:' ||" not in text, (name, text[:80])


@pytest.mark.parametrize("name", ("timekeeping", "ap_invoices", "ar_invoices", "vendors"))
def test_sarus_keys_are_prefixed(name: str) -> None:
    table = {"timekeeping": "core.fact_timekeeping", "ap_invoices": "core.fact_ap_invoice",
             "ar_invoices": "core.fact_ar_invoice", "vendors": "core.dim_vendor"}[name]
    text = next(flat(sql) for sql, _ in SARUS_RUN[name] if f"INSERT INTO {table} AS" in sql)
    assert "('api:sarus:' || source_record_id)" in text


@pytest.mark.parametrize("name", ("timekeeping", "job_budgets", "ap_invoice_details", "ar_invoices"))
def test_sarus_jobs_resolve_through_the_sarus_map(name: str) -> None:
    staged = [flat(sql) for sql, _ in SARUS_RUN[name] if "CREATE TEMP TABLE wt_job_map" in sql]
    assert staged and all("FROM mart.v_sarus_job_map" in text for text in staged)
    assert not any("mart.v_api_job_map" in flat(sql) for sql, _ in SARUS_RUN[name])


def test_sarus_rows_are_company_sarus_and_vendors_offset() -> None:
    tk = next((flat(sql), p) for sql, p in SARUS_RUN["timekeeping"] if "INSERT INTO core.fact_timekeeping" in sql)
    assert "coalesce(%(tenant_company)s::text," in tk[0] and tk[1]["tenant_company"] == "Sarus"
    ar = next((flat(sql), p) for sql, p in SARUS_RUN["ar_invoices"] if "INSERT INTO core.fact_ar_invoice" in sql)
    assert "coalesce(%(tenant_company)s::text, x.job_company, x.customer_company)" in ar[0] and ar[1]["tenant_company"] == "Sarus"
    ap = next((flat(sql), p) for sql, p in SARUS_RUN["ap_invoices"] if "INSERT INTO core.fact_ap_invoice" in sql)
    assert ap[1]["tenant_company"] == "Sarus" and ap[1]["sarus_offset"] == rules.SARUS_VENDOR_OFFSET
    # the primary's company_numbers never label a Sarus row
    assert ap[1]["company_numbers"] == "{}" and ap[1]["tenant_namespace"] == rules.NAMESPACE_SARUS
    vendors = next(p for sql, p in SARUS_RUN["vendors"] if "INSERT INTO core.dim_vendor" in sql)
    assert vendors["vendor_offset"] == rules.SARUS_VENDOR_OFFSET
    details = next((flat(sql), p) for sql, p in SARUS_RUN["ap_invoice_details"] if "INSERT INTO core.fact_ap_distribution" in sql)
    assert "{}".format("+ %(vendor_offset)s AS vendor_number") in details[0] and details[1]["vendor_offset"] == rules.SARUS_VENDOR_OFFSET


def test_sarus_overtime_and_pricing_stay_inside_sarus_rows() -> None:
    updates = [(flat(sql), p) for sql, p in SARUS_RUN["timekeeping"] if "UPDATE core.fact_timekeeping" in sql]
    assert updates and all(p["source"] == "winteam_sarus" for _, p in updates)


def test_primary_normalizers_are_unchanged_by_the_tenant_parameter() -> None:
    conn = RecordingConn({"company_numbers": {"1": "Crane IFS"}})
    normalize.normalize_timekeeping(conn)
    reads = [p for sql, p in conn.statements if "raw.v_winteam_current" in sql]
    assert reads[0]["resource"] == "timekeeping" and reads[0]["source"] == "winteam_api" and reads[0]["tenant_company"] is None
    staged = [flat(sql) for sql, _ in conn.statements if "CREATE TEMP TABLE wt_job_map" in sql]
    assert staged and all("FROM mart.v_api_job_map" in text for text in staged)


def test_punches_are_priced_by_the_job_they_resolved_to() -> None:
    text = flat(normalize.PRICE_UNPRICED_SQL)
    assert "LEFT JOIN core.dim_job dj ON dj.job_key = t.job_key" in text
    assert "jr.job_number = coalesce(dj.job_number, t.job_number)" in text


def test_sarus_promotes_no_jobs_and_is_refused_resources_it_does_not_read() -> None:
    assert not normalize.normalizes("jobs", SARUS) and normalize.normalizes("jobs", PRIMARY)
    assert normalize.normalizes("timekeeping", SARUS)
    with pytest.raises(ValueError):
        normalize.normalize_resource("job_schedules", tenant=SARUS)


def test_repoint_covers_both_databases_and_the_new_fact_tables() -> None:
    conn = RecordingConn()
    with conn.cursor() as cursor:
        normalize.repoint_facts(cursor)
    texts = [(flat(sql), p) for sql, p in conn.statements]
    for table in ("core.fact_job_budget", "core.fact_ap_distribution", "core.fact_timekeeping", "core.fact_ar_invoice"):
        assert any(f"UPDATE {table} f SET job_key = d.job_key" in t and p["api_sources"] == ["winteam_api", "winteam_sarus"] for t, p in texts)
        assert any(f"UPDATE {table} f SET job_key = m.job_key" in t and p["source"] == "winteam_sarus" for t, p in texts)
    maps = [t for t, _ in texts if "CREATE TEMP TABLE wt_job_map" in t]
    assert any("mart.v_api_job_map" in t for t in maps) and any("mart.v_sarus_job_map" in t for t in maps)


# ── connector ────────────────────────────────────────────────────────────────
class LandingCursor:
    def __init__(self, conn: "LandingConn") -> None:
        self.conn = conn
        self.rowcount = 1

    def __enter__(self) -> "LandingCursor":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def execute(self, sql: str, params: Any = None) -> None:
        self.conn.statements.append((flat(sql), params))

    def fetchall(self) -> list[dict[str, Any]]:
        return []


class LandingConn:
    def __init__(self) -> None:
        self.statements: list[tuple[str, Any]] = []

    def transaction(self) -> "LandingConn":
        return self

    def __enter__(self) -> "LandingConn":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def cursor(self) -> LandingCursor:
        return LandingCursor(self)


def test_sarus_lands_under_its_own_resource_names() -> None:
    conn = LandingConn()
    ingestion = WinTeamIngestion(Settings.load({}), tenant=SARUS)
    ingestion._land(conn, "run", RESOURCES["timekeeping"], [{"timekeepingId": 7, "jobNumber": "300"}], PullResult())
    _, params = conn.statements[-1]
    assert params[1] == "sarus/timekeeping" and params[2] == "7"
    primary = LandingConn()
    WinTeamIngestion(Settings.load({}))._land(primary, "run", RESOURCES["timekeeping"], [{"timekeepingId": 7}], PullResult())
    assert primary.statements[-1][1][1] == "timekeeping"


def test_sarus_walks_its_own_job_list_and_customers() -> None:
    ingestion = WinTeamIngestion(Settings.load({}), tenant=SARUS)
    conn = LandingConn()
    ingestion._active_job_numbers(conn)
    text, params = conn.statements[-1]
    assert "FROM raw.v_winteam_current" in text and params == ("sarus/jobs",)
    conn = LandingConn()
    ingestion._customer_numbers(conn)
    text, params = conn.statements[-1]
    assert "company = %(company)s" in text and params == {"company": "Sarus"}
    conn = LandingConn()
    ingestion._ap_invoices_missing_details(conn)
    _, params = conn.statements[-1]
    assert params["source"] == "winteam_sarus" and params["resource"] == "sarus/ap_invoice_details"
    assert params["integration"] == "winteam_sarus"


# ── precedence (pure mirror of migration 026) ────────────────────────────────
def punch(source: str, day: date, company: str | None) -> dict[str, Any]:
    return {"source": source, "work_date": day, "company": company}


API_COMPANIES = ["Crane IFS", "Crane West", "Crane Southwest"]


def test_sarus_backfill_does_not_widen_the_crane_window() -> None:
    rows = [
        punch("winteam_api", date(2026, 7, 30), "Crane IFS"),
        punch("winteam_api", date(2026, 9, 20), "Crane IFS"),
        punch("winteam_sarus", date(2025, 9, 1), "Sarus"),
        punch("winteam_sarus", date(2026, 9, 18), "Sarus"),
        punch("finance_reference", date(2026, 3, 2), "Crane IFS"),   # before the Crane window: kept
        punch("finance_reference", date(2026, 3, 2), "Sarus"),       # inside the Sarus window: superseded
        punch("finance_reference", date(2025, 8, 18), "Sarus"),      # before the Sarus window: kept
        punch("finance_reference", date(2026, 8, 3), "Crane IFS"),   # inside the Crane window: superseded
    ]
    kept = marts.effective_rows(rows, "work_date", API_COMPANIES)
    assert [(r["source"], r["work_date"], r["company"]) for r in kept] == [
        ("winteam_api", date(2026, 7, 30), "Crane IFS"),
        ("winteam_api", date(2026, 9, 20), "Crane IFS"),
        ("winteam_sarus", date(2025, 9, 1), "Sarus"),
        ("winteam_sarus", date(2026, 9, 18), "Sarus"),
        ("finance_reference", date(2026, 3, 2), "Crane IFS"),
        ("finance_reference", date(2025, 8, 18), "Sarus"),
    ]


def test_without_sarus_api_rows_sarus_exports_keep_counting() -> None:
    rows = [punch("winteam_api", date(2026, 8, 1), "Crane IFS"), punch("finance_reference", date(2026, 8, 5), "Sarus")]
    assert marts.effective_rows(rows, "work_date", API_COMPANIES) == rows


def test_invoices_are_superseded_only_within_their_own_database() -> None:
    rows = [
        {"source": "finance_reference", "company": "Sarus", "customer_number": "AMAZ01", "invoice_number": "5001"},
        {"source": "winteam_api", "company": "Crane IFS", "customer_number": "AMAZ01", "invoice_number": "5001"},
        {"source": "finance_reference", "company": "Sarus", "customer_number": "WHOL01", "invoice_number": "77"},
        {"source": "winteam_sarus", "company": "Sarus", "customer_number": "WHOL01", "invoice_number": "77"},
        {"source": "finance_reference", "company": "Crane IFS", "customer_number": "WHOL01", "invoice_number": "77"},
    ]
    kept = marts.effective_ar_rows(rows)
    assert [(r["source"], r["company"], r["invoice_number"]) for r in kept] == [
        ("finance_reference", "Sarus", "5001"),   # a Crane API invoice with the same number does not hide it
        ("winteam_api", "Crane IFS", "5001"),
        ("winteam_sarus", "Sarus", "77"),
        ("finance_reference", "Crane IFS", "77"),  # nor does a Sarus API invoice hide a Crane one
    ]


def test_sarus_job_map_mirror() -> None:
    dims = [
        {"job_number": "300", "job_key": 5505, "company": "Sarus", "valid_to": None},
        {"job_number": "Crane:300", "job_key": 9001, "company": "Crane IFS", "valid_to": None},
        {"job_number": "401", "job_key": 5617, "company": "Sarus", "valid_to": None},
        {"job_number": "1200", "job_key": 42, "company": "Crane IFS", "valid_to": None},
    ]
    # v_sarus_job_map is v_api_job_map with the tenant fixed to Sarus
    assert marts.resolve_api_job("300", dims, ["Sarus"]) == ("300", 5505)
    assert marts.resolve_api_job("1200", dims, ["Sarus"]) == ("Sarus:1200", None)
    assert marts.resolve_api_job("300", dims, API_COMPANIES) == ("Crane:300", 9001)


# ── migration 026 ────────────────────────────────────────────────────────────
@pytest.mark.skipif(not MIGRATION_026.exists(), reason="database/migrations not present next to the test tree")
def test_migration_026_scopes_each_window_to_its_own_database() -> None:
    text = flat(MIGRATION_026.read_text())
    assert "'winteam_sarus'" in text and "CREATE OR REPLACE VIEW mart.v_sarus_job_map AS" in text
    # the Crane window is still taken over winteam_api rows only
    assert "min(work_date) FROM core.fact_timekeeping WHERE source = 'winteam_api') AS timekeeping_from" in text
    assert "min(work_date) FROM core.fact_timekeeping WHERE source = 'winteam_sarus') AS sarus_timekeeping_from" in text
    assert "t.work_date BETWEEN p.sarus_timekeeping_from AND p.sarus_timekeeping_to AND t.company = 'Sarus'" in text
    assert "LEFT JOIN mart.v_sarus_job_map m ON m.raw_job_number = t.job_number WHERE t.source = 'winteam_sarus'" in text
    assert "a.source = CASE WHEN i.company = 'Sarus' THEN 'winteam_sarus' ELSE 'winteam_api' END" in text
    assert "AND i.company = 'Sarus'" in text
    # the appended precedence columns come after every existing one (CREATE OR REPLACE VIEW can only append)
    order = [m.group(1) for m in re.finditer(r"\) AS (\w+)", text.split("CREATE OR REPLACE VIEW mart.v_source_precedence AS")[1].split(";")[0])]
    assert order[:7] == ["timekeeping_from", "timekeeping_to", "ap_invoice_from", "ap_invoice_to", "ar_invoices_api", "api_companies", "api_namespace"]
    assert "CHECK (source IN ('winteam', 'winteam_api', 'winteam_sarus', 'finance_reference', 'manual', 'config'))" in text
