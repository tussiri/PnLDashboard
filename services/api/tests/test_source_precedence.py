"""Source precedence between the live WinTeam API and the finance_reference export load.

Three things are pinned without a database:

1. the day / invoice grain precedence rule (migration 011 views) through the pure mirror functions
   in marts.py, plus string assertions on the migration and on the SQL every consumer emits (no
   consumer reads core.fact_timekeeping / fact_ar_invoice / fact_ap_invoice directly any more);
2. the pricing of API punches that arrive without a rate (normalize.price_unpriced_punches and its
   pure mirror trailing_rates / price_punch: the reference loader's trailing job-rate rule);
3. the scope of the finance_reference reset: only rows of that source, never the raw landings,
   watermarks or anything the API wrote.
"""
from __future__ import annotations

import re
import sys
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import marts, normalize, pace, weekly  # noqa: E402
from app.routers import executive, labor, reporting  # noqa: E402
from app.sources import finance_reference as fr  # noqa: E402

_HERE = Path(__file__).resolve()
# repo checkout: <repo>/database/migrations; api image / container: <services/api>/database/migrations (Dockerfile COPY)
_MIGRATION_DIRS = [_HERE.parents[1] / "database" / "migrations"] + ([_HERE.parents[3] / "database" / "migrations"] if len(_HERE.parents) > 3 else [])
MIGRATION_FILE = next((d / "011_source_precedence.sql" for d in _MIGRATION_DIRS if (d / "011_source_precedence.sql").exists()), None)
MIGRATION = MIGRATION_FILE.read_text(encoding="utf-8") if MIGRATION_FILE else ""
MIGRATION_012 = (MIGRATION_FILE.parent / "012_job_collisions_bu_order.sql").read_text(encoding="utf-8") if MIGRATION_FILE else ""
API_COMPANIES = ["Crane IFS", "Crane West", "Crane Southwest"]


def flat(sql: str) -> str:
    return " ".join(sql.split())


# ── 1. precedence rule ───────────────────────────────────────────────────────
def punch(source: str, day: date, company: str | None = "Crane IFS", hours: float = 8.0, job: str = "500") -> dict[str, Any]:
    return {"source": source, "work_date": day, "company": company, "hours": hours, "job_number": job}


def test_api_window_is_min_max_of_api_rows_only() -> None:
    rows = [
        punch("finance_reference", date(2026, 8, 1)),
        punch("winteam_api", date(2026, 8, 20)),
        punch("winteam_api", date(2026, 9, 3)),
        punch("finance_reference", date(2026, 9, 10)),
    ]
    assert marts.api_window(rows, "work_date") == (date(2026, 8, 20), date(2026, 9, 3))
    assert marts.api_window([punch("finance_reference", date(2026, 8, 1))], "work_date") == (None, None)


def test_inside_the_window_only_api_rows_count_for_covered_companies() -> None:
    rows = [
        punch("finance_reference", date(2026, 8, 19)),               # before the window: counts
        punch("finance_reference", date(2026, 8, 20)),               # first window day: superseded
        punch("finance_reference", date(2026, 8, 25), hours=4.0),    # inside: superseded
        punch("finance_reference", date(2026, 9, 1), company=None),  # unknown company inside: treated as covered
        punch("finance_reference", date(2026, 8, 27), company="Sarus"),  # company the API does not serve: counts
        punch("winteam_api", date(2026, 8, 20)),
        punch("winteam_api", date(2026, 9, 3)),
        punch("finance_reference", date(2026, 9, 4)),                # after the window: counts
    ]
    kept = marts.effective_rows(rows, "work_date", API_COMPANIES)
    assert [(r["source"], r["work_date"]) for r in kept] == [
        ("finance_reference", date(2026, 8, 19)),
        ("finance_reference", date(2026, 8, 27)),
        ("winteam_api", date(2026, 8, 20)),
        ("winteam_api", date(2026, 9, 3)),
        ("finance_reference", date(2026, 9, 4)),
    ]


def test_gap_day_inside_the_window_is_trusted_as_no_punches() -> None:
    # The API has punches on Aug 20 and Aug 22 but none on Aug 21; the export line for Aug 21 does
    # NOT fill the gap because the API is the system of record inside its window.
    rows = [
        punch("winteam_api", date(2026, 8, 20)),
        punch("finance_reference", date(2026, 8, 21)),
        punch("winteam_api", date(2026, 8, 22)),
    ]
    kept = marts.effective_rows(rows, "work_date", API_COMPANIES)
    assert {r["work_date"] for r in kept} == {date(2026, 8, 20), date(2026, 8, 22)}


def test_without_api_rows_every_export_row_counts_and_empty_company_list_means_plain_date_window() -> None:
    rows = [punch("finance_reference", date(2026, 8, 25), company="Sarus"), punch("finance_reference", date(2026, 9, 1))]
    assert marts.effective_rows(rows, "work_date", API_COMPANIES) == rows
    with_api = rows + [punch("winteam_api", date(2026, 8, 25))]
    # no company_numbers configured: every export row inside the window is superseded, Sarus included
    assert [r["source"] for r in marts.effective_rows(with_api, "work_date", [])] == ["finance_reference", "winteam_api"]
    assert marts.effective_rows(with_api, "work_date", [])[0]["work_date"] == date(2026, 9, 1)


def test_ar_invoice_precedence_is_by_customer_and_invoice_number() -> None:
    rows = [
        {"source": "finance_reference", "customer_number": "AMAZ01", "invoice_number": "160334", "amount_paid": 0},
        {"source": "winteam_api", "customer_number": "AMAZ01", "invoice_number": "160334", "amount_paid": 466652.31},
        {"source": "finance_reference", "customer_number": "AMAZ01", "invoice_number": "160335", "amount_paid": 0},
        {"source": "finance_reference", "customer_number": "FEDX01", "invoice_number": "160334", "amount_paid": 0},
        {"source": "winteam_api", "customer_number": "COST01", "invoice_number": "999", "amount_paid": 1},
    ]
    kept = marts.effective_ar_rows(rows)
    assert [(r["source"], r["customer_number"], r["invoice_number"]) for r in kept] == [
        ("winteam_api", "AMAZ01", "160334"),
        ("finance_reference", "AMAZ01", "160335"),
        ("finance_reference", "FEDX01", "160334"),
        ("winteam_api", "COST01", "999"),
    ]


@pytest.mark.skipif(MIGRATION_FILE is None, reason="database/migrations not present next to the test tree")
def test_migration_011_defines_the_views_and_seeds_company_numbers() -> None:
    text = flat(MIGRATION)
    for view in ("mart.v_source_precedence", "mart.v_timekeeping_effective", "mart.v_ar_invoice_effective", "mart.v_ap_invoice_effective",
                 "mart.v_timekeeping_daily", "mart.v_ar_open", "mart.v_ap_vendor_month"):
        assert f"CREATE OR REPLACE VIEW {view} AS" in text, view
    # the window is taken over API rows only, and export rows are excluded inside it for covered companies
    assert "min(work_date) FROM core.fact_timekeeping WHERE source = 'winteam_api'" in text
    assert "t.work_date BETWEEN p.timekeeping_from AND p.timekeeping_to" in text
    assert "t.company = ANY (p.api_companies)" in text
    assert "a.customer_number = i.customer_number AND a.invoice_number = i.invoice_number" in text
    assert "coalesce(i.invoice_date, i.posting_date) BETWEEN p.ap_invoice_from AND p.ap_invoice_to" in text
    # legacy views now read the effective facts
    assert "FROM mart.v_timekeeping_effective t GROUP BY job_number, job_key, work_date" in text
    assert "FROM mart.v_ar_invoice_effective i LEFT JOIN core.dim_customer" in text
    assert "FROM mart.v_ap_invoice_effective i LEFT JOIN core.dim_vendor" in text
    seed = re.search(r"UPDATE ops\.app_setting SET value = '(\{.*?\})'::jsonb.*?WHERE key = 'company_numbers' AND value = '\{\}'::jsonb", text)
    assert seed and '"1": "Crane IFS"' in seed.group(1) and '"2": "Crane West"' in seed.group(1) and '"3": "Crane Southwest"' in seed.group(1)


@pytest.mark.parametrize("module", [marts, weekly, pace, labor, reporting])
def test_consumers_read_the_effective_views_not_the_fact_tables(module: Any) -> None:
    source = Path(module.__file__).read_text(encoding="utf-8")
    for line in source.splitlines():
        code = line.split("#", 1)[0]
        if "core.fact_timekeeping" in code or "core.fact_ap_invoice" in code:
            # the only direct reads left are existence checks (marts_empty_but_facts_exist)
            assert "EXISTS (SELECT 1 FROM" in code, f"{module.__name__}: {line.strip()}"
        if "core.fact_ar_invoice" in code:
            assert "EXISTS (SELECT 1 FROM" in code or "i.ar_invoice_key = o.ar_invoice_key" in code, f"{module.__name__}: {line.strip()}"
    assert "mart.v_timekeeping_effective" in source or module is reporting
    if module is marts:
        assert "mart.v_ar_invoice_effective" in source and "mart.v_ap_invoice_effective" in source


# ── 2. pricing of unpriced API punches ───────────────────────────────────────
JC = [
    # job 500 (Crane IFS): closed months Jun/Jul, in-progress Aug (not closed on 2026-09-03 with lag 5)
    {"job_number": "500", "company": "Crane IFS", "month": date(2026, 5, 1), "direct_labor": 1000.0, "actual_hours": 50.0},
    {"job_number": "500", "company": "Crane IFS", "month": date(2026, 6, 1), "direct_labor": 2100.0, "actual_hours": 100.0},
    {"job_number": "500", "company": "Crane IFS", "month": date(2026, 7, 1), "direct_labor": 2000.0, "actual_hours": 100.0},
    {"job_number": "500", "company": "Crane IFS", "month": date(2026, 8, 1), "direct_labor": 9999.0, "actual_hours": 1.0},
    # older month outside the trailing 3
    {"job_number": "500", "company": "Crane IFS", "month": date(2026, 4, 1), "direct_labor": 100000.0, "actual_hours": 10.0},
    # job 501 has hours but no labor: unusable
    {"job_number": "501", "company": "Crane West", "month": date(2026, 7, 1), "direct_labor": 0.0, "actual_hours": 80.0},
    # job 502 (Crane West) prices the company
    {"job_number": "502", "company": "Crane West", "month": date(2026, 7, 1), "direct_labor": 3000.0, "actual_hours": 100.0},
]
TODAY = date(2026, 9, 3)


def test_trailing_rates_pool_the_last_three_closed_months() -> None:
    rates = normalize.trailing_rates(JC, lag_days=5, today=TODAY)
    # May + Jun + Jul (Aug is not closed, Apr is the 4th month back): 5100 / 250
    assert rates["job"]["500"] == pytest.approx(20.4)
    assert "501" not in rates["job"]
    assert rates["job"]["502"] == pytest.approx(30.0)
    assert rates["company"]["Crane IFS"] == pytest.approx(20.4)
    assert rates["company"]["Crane West"] == pytest.approx(30.0)
    assert rates["portfolio"] == pytest.approx((5100.0 + 3000.0) / 350.0)
    # a wider lag leaves July open, so the trailing three closed months become Apr + May + Jun
    assert normalize.trailing_rates(JC, lag_days=40, today=TODAY)["job"]["500"] == pytest.approx(103100.0 / 160.0)


def test_month_is_closed_matches_the_marts_rule() -> None:
    assert normalize.month_is_closed(date(2026, 7, 1), 5, TODAY)
    assert not normalize.month_is_closed(date(2026, 8, 1), 5, TODAY)
    assert normalize.month_is_closed(date(2026, 8, 1), 2, date(2026, 9, 3))
    assert not normalize.month_is_closed(date(2026, 8, 1), 3, date(2026, 9, 3))


def test_price_punch_prefers_api_rate_then_job_then_company_then_portfolio() -> None:
    rates = normalize.trailing_rates(JC, lag_days=5, today=TODAY)
    assert normalize.price_punch({"job_number": "500", "company": "Crane IFS", "hours": 8, "rate": 18.5}, rates) == (148.0, 18.5, "hours_x_rate")
    assert normalize.price_punch({"job_number": "500", "company": "Crane IFS", "hours": 8, "rate": 0}, rates) == (163.2, 20.4, "trailing_job_rate")
    assert normalize.price_punch({"job_number": "501", "company": "Crane West", "hours": 10, "rate": None}, rates) == (300.0, 30.0, "trailing_job_rate")
    portfolio = round((5100.0 + 3000.0) / 350.0, 4)
    assert normalize.price_punch({"job_number": "777", "company": "Sarus", "hours": 2, "rate": 0}, rates) == (round(2 * (5100.0 + 3000.0) / 350.0, 2), portfolio, "trailing_job_rate")
    assert normalize.price_punch({"job_number": "777", "company": None, "hours": 2, "rate": 0}, {"job": {}, "company": {}, "portfolio": None}) == (None, 0.0, "none")


def test_price_punch_takes_the_company_rate_when_the_job_rate_is_not_a_wage() -> None:
    rates = {"job": {"34": 203.31}, "company": {"Crane IFS": 21.4}, "portfolio": 20.0}
    assert normalize.price_punch({"job_number": "34", "company": "Crane IFS", "hours": 10, "rate": None}, rates) == (214.0, 21.4, "trailing_job_rate")


def test_the_pricing_sql_guards_and_reprices_implausible_job_rates() -> None:
    assert "%(max_ratio)s * cr.rate" in normalize.PRICE_UNPRICED_SQL
    assert "t.rate > %(max_ratio)s * cr.rate" in normalize.REPRICE_IMPLAUSIBLE_SQL
    import re
    for sql in (normalize.PRICE_UNPRICED_SQL, normalize.REPRICE_IMPLAUSIBLE_SQL):
        assert not re.search(r"%(?!\(\w+\)s)", sql)  # psycopg reads every % as a placeholder


class RecordingCursor:
    def __init__(self, conn: "RecordingConn") -> None:
        self.conn = conn
        self.rowcount = 3

    def __enter__(self) -> "RecordingCursor":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def execute(self, sql: str, params: Any = None) -> None:
        self.conn.statements.append((sql, params))

    def fetchone(self) -> dict[str, Any] | None:
        return None

    def fetchall(self) -> list[dict[str, Any]]:
        return []


class RecordingConn:
    def __init__(self) -> None:
        self.statements: list[tuple[str, Any]] = []

    def cursor(self) -> RecordingCursor:
        return RecordingCursor(self)


def test_timekeeping_normalization_prices_api_rows_at_trailing_rate() -> None:
    conn = RecordingConn()
    normalize.normalize_timekeeping(conn)
    pricing = [(flat(sql), params) for sql, params in conn.statements if "labor_cost_basis = %(basis)s" in sql]
    assert len(pricing) == 2  # price the unpriced, then re-price implausible job rates (any source)
    text, params = pricing[0]
    assert params == {"source": "winteam_api", "lag_days": 5, "months": 3, "basis": "trailing_job_rate", "max_ratio": 3.0}
    assert "t.rate > %(max_ratio)s * cr.rate" in pricing[1][0]
    assert "FROM mart.v_job_cost_month_effective" in text
    assert "WHERE t.source = %(source)s AND t.labor_cost_basis IS DISTINCT FROM %(basis)s" in text
    assert re.search(r"UPDATE core\.fact_timekeeping t SET .* WHERE u\.timekeeping_key = t\.timekeeping_key AND t\.source = %\(source\)s AND u\.rate IS NOT NULL", text)
    assert "jr.rate <= %(max_ratio)s * cr.rate" in text and "coalesce(cr.rate, pr.rate, jr.rate)" in text
    assert "recency <= %(months)s" in text
    # the upsert itself still prices rate > 0 rows as hours x rate and leaves the others NULL / 'none'
    upsert = flat(next(sql for sql, _ in conn.statements if "INSERT INTO core.fact_timekeeping" in sql))
    assert "CASE WHEN x.rate > 0 THEN round(coalesce(x.hours, 0) * x.rate, 2) END" in upsert
    assert "CASE WHEN x.rate > 0 THEN 'hours_x_rate' ELSE 'none' END" in upsert
    # ordering: upsert, overtime derivation, then pricing
    order = [i for i, (sql, _) in enumerate(conn.statements) if "INSERT INTO core.fact_timekeeping" in sql or "labor_cost_basis = %(basis)s" in sql]
    assert order == sorted(order) and len(order) == 3


# ── 3. reset scope of the reference loader ───────────────────────────────────
def test_reset_never_touches_raw_landings_watermarks_or_api_rows() -> None:
    conn = RecordingConn()
    cleared = fr.reset_warehouse(conn)
    statements = [(flat(sql), params) for sql, params in conn.statements]
    joined = " ".join(text for text, _ in statements)
    for table in fr.NEVER_RESET_TABLES:
        assert table not in joined, table
    assert "winteam_api" not in joined
    truncates = [text for text, _ in statements if text.upper().startswith("TRUNCATE")]
    assert len(truncates) == 1
    assert set(re.findall(r"(mart\.\w+)", truncates[0])) == set(fr.RESET_MART_TABLES)
    deletes = [(text, params) for text, params in statements if text.upper().startswith("DELETE FROM")]
    deleted_tables = {re.match(r"DELETE FROM (\S+)", text).group(1) for text, _ in deletes}
    assert deleted_tables == set(fr.RESET_FACT_TABLES) | set(fr.RESET_DIM_TABLES) | {"core.dim_parent_account"}
    for text, params in deletes:
        if "core.dim_parent_account" in text:
            # no source column: only accounts nothing points at any more
            assert "NOT EXISTS (SELECT 1 FROM core.dim_job" in text and "NOT EXISTS (SELECT 1 FROM core.dim_customer" in text
            continue
        assert text.endswith("WHERE source = %(source)s"), text
        assert params == {"source": "finance_reference"}
    # API rows pointing at a reference-only dimension row are unlinked, never deleted
    updates = [(text, params) for text, params in statements if text.upper().startswith("UPDATE")]
    assert {re.match(r"UPDATE (\S+)", text).group(1) for text, _ in updates} == {fact for fact, *_ in fr._FK_TO_DIM}
    for text, params in updates:
        assert "f.source <> %(source)s" in text and "WHERE d.source = %(source)s" in text and params == {"source": "finance_reference"}
    # dims go after the facts and the FK unlinking
    kinds = [text.split()[0].upper() for text, _ in statements]
    assert kinds.index("UPDATE") > kinds.index("DELETE") and kinds[-1] == "DELETE"
    assert set(cleared) == set(fr.RESET_TABLES) | {"core.dim_parent_account"}


def test_reset_table_lists_are_consistent() -> None:
    assert "raw.winteam_record" not in fr.RESET_TABLES and "ops.source_watermark" not in fr.RESET_TABLES
    assert "ops.app_setting" not in fr.RESET_TABLES and "mart.rebuild_log" not in fr.RESET_TABLES
    assert {"core.dim_job", "core.fact_timekeeping", "mart.job_month", "mart.forecast_run_meta"} <= set(fr.RESET_TABLES)
    assert not set(fr.RESET_TABLES) & set(fr.NEVER_RESET_TABLES)


def test_loader_dimension_inserts_tolerate_api_owned_rows() -> None:
    source = Path(fr.__file__).read_text(encoding="utf-8")
    assert "INSERT INTO core.dim_parent_account (winteam_id, account_name, active) VALUES (%(winteam_id)s, %(account_name)s, true) \"\n            \"ON CONFLICT (winteam_id) DO UPDATE" in source
    job_insert = source[source.index("INSERT INTO core.dim_job ("):]
    job_insert = job_insert[: job_insert.index("rows,\n")]
    assert "ON CONFLICT (job_number) WHERE valid_to IS NULL DO UPDATE SET" in job_insert
    # the API keeps what it supplied: exact coordinates and the row's own source
    assert "CASE WHEN core.dim_job.geo_precision = 'exact' THEN core.dim_job.latitude" in job_insert
    assert "source = " not in flat(job_insert).split("DO UPDATE SET", 1)[1]
    # reference-only attributes are always refreshed from the export
    for column in ("delivery_model", "account_group", "customer_number", "customer_name", "date_discontinued"):
        assert f"{column} = excluded.{column}" in job_insert, column
    vendor_insert = source[source.index("INSERT INTO core.dim_vendor (winteam_id, vendor_number, vendor_name, active, source)"):]
    vendor_insert = vendor_insert[: vendor_insert.index("params,")]
    assert "ON CONFLICT (vendor_number) DO NOTHING" in vendor_insert


# ── 4. job-number collisions (migration 012) ────────────────────────────────
DIMS = [
    {"job_number": "300", "job_key": 5505, "company": "Sarus", "valid_to": None},
    {"job_number": "Crane:300", "job_key": 9001, "company": "Crane IFS", "valid_to": None},
    {"job_number": "401", "job_key": 5617, "company": "Sarus", "valid_to": None},
    {"job_number": "500", "job_key": 7000, "company": "Crane IFS", "valid_to": None},
    {"job_number": "501", "job_key": 7001, "company": None, "valid_to": None},
    {"job_number": "500", "job_key": 6999, "company": "Crane IFS", "valid_to": "2026-01-01"},
]


def test_api_facts_resolve_only_to_tenant_company_rows() -> None:
    assert marts.resolve_api_job("500", DIMS, API_COMPANIES) == ("500", 7000)          # tenant row: bare number
    assert marts.resolve_api_job("501", DIMS, API_COMPANIES) == ("501", 7001)          # no company = tenant's
    assert marts.resolve_api_job("300", DIMS, API_COMPANIES) == ("Crane:300", 9001)    # Sarus owns 300: namespaced row
    assert marts.resolve_api_job("401", DIMS, API_COMPANIES) == ("Crane:401", None)    # no namespaced row yet: never Sarus
    assert marts.resolve_api_job("777", DIMS, API_COMPANIES) == ("777", None)          # unknown number stays itself
    assert marts.resolve_api_job("300", DIMS, []) == ("300", 5505)                     # nothing configured: plain match


def test_api_namespace_mirrors_tenant_namespace() -> None:
    assert marts.api_namespace(API_COMPANIES) == "Crane" == normalize.tenant_namespace({"1": "Crane IFS", "2": "Crane West"})
    assert marts.api_namespace(["Sarus Co"]) == "Sarus" == normalize.tenant_namespace({"9": "Sarus Co"})
    assert marts.api_namespace([]) == "Crane"


@pytest.mark.skipif(MIGRATION_FILE is None, reason="database/migrations not present next to the test tree")
def test_migration_012_resolves_api_jobs_through_one_map() -> None:
    text = flat(MIGRATION_012)
    assert "CREATE OR REPLACE VIEW mart.v_api_job_map AS" in text
    assert "d.company = ANY (p.api_companies)" in text and "p.api_namespace || ':' || d.job_number" in text
    assert "ELSE 'Crane' END" in text and "LIKE '%sarus%'" in text
    for view in ("mart.v_timekeeping_effective", "mart.v_ar_invoice_effective"):
        body = text.split(f"CREATE OR REPLACE VIEW {view} AS", 1)[1].split("UNION ALL", 1)[0]
        assert "LEFT JOIN mart.v_api_job_map m ON m.raw_job_number =" in body and "source = 'winteam_api'" in body
        assert "THEN m.job_key ELSE" in body and "THEN m.job_number ELSE" in body
    # column positions of the resolved columns match the fact tables (CREATE OR REPLACE keeps the shape)
    tk = text.split("CREATE OR REPLACE VIEW mart.v_timekeeping_effective AS SELECT", 1)[1].split("FROM core.fact_timekeeping", 1)[0]
    assert tk.startswith(" t.timekeeping_key, t.winteam_id, CASE WHEN m.raw_job_number IS NOT NULL THEN m.job_key ELSE t.job_key END AS job_key, t.employee_source_id")
    ar = text.split("CREATE OR REPLACE VIEW mart.v_ar_invoice_effective AS SELECT", 1)[1].split("FROM core.fact_ar_invoice", 1)[0]
    assert "i.invoice_number, CASE WHEN m.raw_job_number IS NOT NULL THEN m.job_key ELSE i.job_key END AS job_key, CASE WHEN m.raw_job_number IS NOT NULL THEN m.job_number ELSE i.job_number END AS job_number, i.invoice_date" in ar
    assert "('bu_order', '[\"Crane West\", \"Crane IFS\", \"Crane Southwest\", \"Sarus\"]'::jsonb" in text and "ON CONFLICT (key) DO NOTHING" in text


def test_normalizers_stage_the_job_map_before_linking_facts() -> None:
    for name in ("timekeeping", "job_schedules", "gl_budgets", "ar_invoices"):
        conn = RecordingConn()
        normalize.NORMALIZERS[name](conn)
        texts = [flat(sql) for sql, _ in conn.statements]
        staged = next(i for i, t in enumerate(texts) if t.startswith("CREATE TEMP TABLE wt_job_map ON COMMIT DROP AS SELECT raw_job_number, job_number, job_key, company FROM mart.v_api_job_map"))
        first_use = next(i for i, t in enumerate(texts) if "FROM wt_job_map m WHERE m.raw_job_number" in t)
        assert staged < first_use, name
        assert not any("FROM core.dim_job j WHERE j.job_number" in t for t in texts), name


def test_jobs_sync_repoints_api_facts_through_the_map_and_reference_facts_by_bare_number() -> None:
    conn = RecordingConn()
    normalize.normalize_jobs(conn, ["g-1"])
    repoints = [(flat(sql), p) for sql, p in conn.statements if flat(sql).startswith("UPDATE core.fact_") and "SET job_key" in sql]
    assert len(repoints) == 18  # 6 fact tables x (reference, primary api, Sarus api)
    for text, params in repoints:
        if "FROM wt_job_map m" in text:
            assert params["source"] in ("winteam_api", "winteam_sarus")
            assert "f.source = %(source)s AND m.raw_job_number = f.job_number" in text
        else:
            assert params["api_sources"] == ["winteam_api", "winteam_sarus"]
            assert "f.source <> ALL(%(api_sources)s) AND d.job_number = f.job_number AND d.valid_to IS NULL" in text


# ── 5. business-unit order ──────────────────────────────────────────────────
def test_business_units_follow_bu_order_with_unknowns_appended_alphabetically() -> None:
    units = [{"name": n} for n in ("Sarus", "Crane IFS", "Zeta Co", "Crane West", "Alpha LLC", "Crane Southwest")]
    ordered = executive.order_business_units(units, ["Crane West", "Crane IFS", "Crane Southwest", "Sarus"])
    assert [u["name"] for u in ordered] == ["Crane West", "Crane IFS", "Crane Southwest", "Sarus", "Alpha LLC", "Zeta Co"]
    assert [u["sort_order"] for u in ordered] == [1, 2, 3, 4, 5, 6]
    assert executive.bu_order_setting(None) == executive.DEFAULT_BU_ORDER
    assert executive.bu_order_setting(["Sarus", "", "Sarus", 3, " Crane IFS "]) == ["Sarus", "Crane IFS"]
    assert executive.bu_order_setting([]) == executive.DEFAULT_BU_ORDER



# ── 6. one connection per transaction (the worker self-deadlock) ────────────
class GroupingCursor(RecordingCursor):
    """RecordingCursor that answers the two reads account grouping makes."""

    def __init__(self, conn: "GroupingConn") -> None:
        super().__init__(conn)
        self._rows: list[dict[str, Any]] = []

    def execute(self, sql: str, params: Any = None) -> None:
        super().execute(sql, params)
        text = " ".join(sql.split())
        if "FROM ops.app_setting WHERE key" in text and params == ("account_groups",):
            self._rows = [{"value": [{"name": "Acme", "terms": ["acme"]}]}]
        elif text.startswith("SELECT j.job_key, j.job_number, j.job_name"):
            self._rows = [{"job_key": 7, "job_number": "100", "job_name": "Acme Tower",
                           "customer_name": "Acme Corp", "parent_account": "Other"}]
        else:
            self._rows = []

    def fetchone(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None

    def fetchall(self) -> list[dict[str, Any]]:
        return list(self._rows)


class GroupingConn(RecordingConn):
    def __init__(self) -> None:
        super().__init__()
        self.transactions = 0
        self.commits = 0

    def cursor(self) -> GroupingCursor:
        return GroupingCursor(self)

    def commit(self) -> None:
        self.commits += 1

    @contextmanager
    def transaction(self):
        self.transactions += 1
        yield self


def test_account_grouping_runs_on_the_callers_connection(monkeypatch) -> None:
    """normalize_jobs must never open a second connection for the grouping step.

    The grouping UPDATEs the core.dim_job rows the calling transaction has just written, so a
    fresh connection waits on that transaction's row locks - and since it is the same process,
    nothing ever releases them. That self-deadlock hung the worker for hours, holding locks the
    mart rebuild (and every reporting read behind it) needed.
    """
    def forbidden(*_args: Any, **_kwargs: Any):
        raise AssertionError("normalize_jobs opened a second database connection")

    monkeypatch.setattr(normalize, "connection", forbidden)
    conn = GroupingConn()
    normalize.normalize_jobs(conn, ["g-1"])
    texts = [flat(sql) for sql, _ in conn.statements]
    assert any(t.startswith("UPDATE core.dim_job SET parent_account_key") for t in texts)
    # the grouping is wrapped in exactly one savepoint so a failure cannot abort the jobs upsert
    assert conn.transactions == 1


def test_standalone_account_grouping_still_opens_its_own_connection(monkeypatch) -> None:
    conn = GroupingConn()
    opened: list[bool] = []

    @contextmanager
    def fake_connection(**_kwargs: Any):
        opened.append(True)
        yield conn

    monkeypatch.setattr(normalize, "connection", fake_connection)
    assert normalize.apply_account_groups() == {"jobs_regrouped": 3, "groups": 1}
    assert opened == [True] and conn.commits == 1


def test_the_overtime_split_counts_earlier_hours_of_the_pay_week_from_another_source() -> None:
    """The API joining a pay week mid-week (its backfill start): the reference export's earlier days count toward 40 hours."""
    conn = RecordingConn()
    normalize.derive_overtime(conn)
    sql = flat(next(s for s, _ in conn.statements if "weekly_threshold" in s))
    assert "o.source <> %(source)s AND o.work_date >= f.pay_week AND o.work_date < f.first_day" in sql
    assert "coalesce(c.h, 0) + sum(a.h) OVER" in sql
