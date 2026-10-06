"""Source coexistence: the SQL normalize.py emits must never touch finance_reference rows.

These tests run every normalizer against a fake cursor that records the statements and asserts
their shape: API rows are keyed 'api:...', every fact upsert is guarded by `source = 'winteam_api'`,
every DELETE is source-scoped, nothing TRUNCATEs, the job dimension is keyed by job_number, and the
Crane / Sarus namespace decision mirrors sources/rules.
"""
from __future__ import annotations

import re
from typing import Any

import pytest

from app import normalize
from app.sources import rules

FACT_TABLES = (
    "core.fact_timekeeping",
    "core.fact_schedule",
    "core.fact_gl_budget",
    "core.fact_ap_invoice",
    "core.fact_ar_invoice",
    "core.fact_ap_payment",
)


class RecordingCursor:
    def __init__(self, conn: "RecordingConn") -> None:
        self.conn = conn
        self.rowcount = 0
        self._rows: list[dict[str, Any]] = []

    def __enter__(self) -> "RecordingCursor":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def execute(self, sql: str, params: Any = None) -> None:
        self.conn.statements.append((sql, params))
        self._rows = []
        flat = " ".join(sql.split())
        if flat.startswith("SELECT value FROM ops.app_setting"):
            key = params[0]
            if key in self.conn.settings:
                self._rows = [{"value": self.conn.settings[key]}]
        elif "FROM wt_jobs x JOIN core.dim_job d" in flat:
            self._rows = list(self.conn.conflicts)
        elif flat.startswith("SELECT count(*) AS n FROM wt_jobs"):
            self._rows = [{"n": 0}]
        self.rowcount = 3

    def fetchone(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None

    def fetchall(self) -> list[dict[str, Any]]:
        return list(self._rows)


class RecordingConn:
    def __init__(self, settings: dict[str, Any] | None = None, conflicts: list[dict[str, Any]] | None = None) -> None:
        self.settings = settings or {}
        self.conflicts = conflicts or []
        self.statements: list[tuple[str, Any]] = []

    def cursor(self) -> RecordingCursor:
        return RecordingCursor(self)


def flat(sql: str) -> str:
    return " ".join(sql.split())


def run_all(settings: dict[str, Any] | None = None) -> dict[str, list[tuple[str, Any]]]:
    out: dict[str, list[tuple[str, Any]]] = {}
    for name, normalizer in normalize.NORMALIZERS.items():
        conn = RecordingConn(settings)
        normalizer(conn, ["g-1"] if name == "jobs" else None)
        out[name] = conn.statements
    return out


ALL = run_all({"company_numbers": {"1": "Crane IFS", "2": "Crane West"}, "overtime_category_detail_ids": []})


# ── no TRUNCATE, every DELETE is source-scoped ───────────────────────────────
def test_nothing_truncates_and_deletes_are_source_scoped() -> None:
    for name, statements in ALL.items():
        for sql, params in statements:
            text = flat(sql)
            assert "TRUNCATE" not in text.upper(), f"{name}: {text[:80]}"
            if re.search(r"\bDELETE FROM\b", text, re.IGNORECASE):
                target = re.search(r"DELETE FROM (\S+)", text).group(1)
                if target == "wt_jobs":
                    continue  # the staging TEMP table of this run
                assert "source = %(source)s" in text, f"{name}: unscoped delete on {target}"
                assert params["source"] == normalize.SOURCE


# ── fact upserts: api: keys and source guard ─────────────────────────────────
@pytest.mark.parametrize("table", FACT_TABLES)
def test_fact_upserts_are_keyed_api_and_guarded_by_source(table: str) -> None:
    inserts = [
        (flat(sql), params)
        for statements in ALL.values()
        for sql, params in statements
        if flat(sql).startswith("WITH src AS") and f"INSERT INTO {table} AS" in flat(sql)
    ]
    assert inserts, f"no upsert into {table}"
    for text, params in inserts:
        assert "('api:' || source_record_id)" in text
        assert re.search(r"ON CONFLICT \(winteam_id\) DO UPDATE SET .* WHERE \w+\.source = %\(source\)s$", text), text[-200:]
        assert params["source"] == "winteam_api"
        assert "%(source)s, " in text or ", %(source)s" in text  # the source column is written on insert


def test_timekeeping_rows_carry_hours_x_rate_and_company() -> None:
    text = flat(next(sql for sql, _ in ALL["timekeeping"] if "INSERT INTO core.fact_timekeeping" in sql))
    assert "labor_cost_basis" in text and "'hours_x_rate'" in text
    # a zero / missing rate is an unknown wage, never free labor
    assert "CASE WHEN x.rate > 0 THEN round(coalesce(x.hours, 0) * x.rate, 2) END" in text
    assert "CASE WHEN x.rate > 0 THEN 'hours_x_rate' ELSE 'none' END" in text
    # the job (and its company) is resolved through the staged mart.v_api_job_map, never a bare dim_job lookup
    assert "SELECT m.company FROM wt_job_map m WHERE m.raw_job_number = x.job_number" in text
    assert "SELECT m.job_key FROM wt_job_map m WHERE m.raw_job_number = x.job_number" in text
    assert "core.dim_job" not in text
    assert "overtime_basis = 'none'" in text


def test_overtime_derivation_only_touches_api_rows() -> None:
    for settings in ({"overtime_category_detail_ids": [15, 16]}, {"overtime_category_detail_ids": []}):
        conn = RecordingConn(settings)
        normalize.derive_overtime(conn)
        updates = [(flat(sql), params) for sql, params in conn.statements if "UPDATE core.fact_timekeeping" in sql]
        assert updates
        for text, params in updates:
            assert "source = %(source)s" in text
            assert params["source"] == "winteam_api"
            # the window / category scan itself is restricted, not only the final UPDATE
            assert text.count("source = %(source)s") >= 2 or "employee_source_id IS NULL AND source" in text
        if not settings["overtime_category_detail_ids"]:
            # the window scan must be materialized once, not re-planned per updated row (97 s -> 0.6 s on 15k punches)
            assert any("WITH api AS MATERIALIZED" in text and "ranked AS MATERIALIZED" in text for text, _ in updates)


def test_ar_invoices_use_api_amount_paid_and_treatment_rules() -> None:
    text = flat(next(sql for sql, _ in ALL["ar_invoices"] if "INSERT INTO core.fact_ar_invoice" in sql))
    assert "'api_amount_paid'" in text
    assert "amount_paid = excluded.amount_paid" in text
    assert "%(treatment_rules)s::jsonb" in text and "~* (r->>'match')" in text
    customers = flat(next(sql for sql, _ in ALL["ar_invoices"] if "INSERT INTO core.dim_customer" in sql))
    assert "%(source)s" in customers and "coalesce(excluded.customer_name, c.customer_name)" in customers
    parent = flat(next(sql for sql, _ in ALL["ar_invoices"] if "parent_account_key = s.parent_account_key" in sql))
    assert "i.source = %(source)s" in parent and "c.parent_account_key IS NULL" in parent


# ── dimensions ───────────────────────────────────────────────────────────────
def test_dim_job_is_keyed_by_job_number_and_keeps_reference_fields() -> None:
    statements = [flat(sql) for sql, _ in ALL["jobs"]]
    upsert = next(s for s in statements if "INSERT INTO core.dim_job AS d" in s)
    assert "ON CONFLICT (job_number) WHERE valid_to IS NULL DO UPDATE SET" in upsert
    assert "winteam_id = excluded.winteam_id" in upsert
    assert "parent_account_key = coalesce(d.parent_account_key, excluded.parent_account_key)" in upsert
    assert "job_name = coalesce(excluded.job_name, d.job_name)" in upsert
    assert "latitude = coalesce(excluded.latitude, d.latitude)" in upsert
    assert "THEN 'exact' ELSE d.geo_precision END" in upsert
    assert "company = coalesce(excluded.company, d.company)" in upsert
    assert "source = excluded.source" in upsert
    for kept in ("delivery_model", "account_group", "customer_number", "date_discontinued"):
        assert kept not in upsert, f"{kept} must stay a reference-only field"
    # deactivation by absence only for API-supplied rows
    deactivate = next(s for s in statements if "is_active = false, status = 'inactive'" in s)
    assert "source = %(source)s" in deactivate
    # recycling closes API-owned identities only
    recycle = next(s for s in statements if "status = 'recycled'" in s)
    assert "d.source = %(source)s" in recycle
    # tier replacement is scoped to the jobs the API just supplied
    tiers = next(s for s in statements if "DELETE FROM core.job_tier" in s)
    assert "d.source = %(source)s" in tiers and "IN (SELECT winteam_id FROM wt_jobs)" in tiers


def test_dim_job_namespace_conflicts_are_namespaced_and_logged(caplog) -> None:
    conflicts = [{"job_number": "401", "company_label": "Crane IFS", "company_name_raw": "ServiceMaster by Sarus Co"}]
    conn = RecordingConn({"company_numbers": {"1": "Crane IFS"}}, conflicts)
    with caplog.at_level("WARNING", logger="normalize"):
        normalize.normalize_jobs(conn, ["g-1"])
    assert "401 (api Crane IFS vs reference ServiceMaster by Sarus Co)" in caplog.text
    assert not [sql for sql, _ in conn.statements if flat(sql).startswith("DELETE FROM wt_jobs")]
    renames = [(flat(sql), p) for sql, p in conn.statements if flat(sql).startswith("UPDATE wt_jobs x SET job_number = %(tenant_namespace)s || ':' || x.job_number")]
    assert len(renames) == 1 and "<> x.api_namespace" in renames[0][0] and renames[0][1]["tenant_namespace"] == "Crane"
    staging = flat(next(sql for sql, _ in conn.statements if "CREATE TEMP TABLE wt_jobs" in sql))
    assert "%(company_numbers)s::jsonb ->> btrim(p->>'companyNumber')" in staging
    assert "SELECT DISTINCT ON (job_number) * FROM parsed" in staging


def test_dim_vendor_and_ap_use_the_reference_namespace_offset() -> None:
    vendors = flat(next(sql for sql, _ in ALL["vendors"] if "INSERT INTO core.dim_vendor AS v" in sql))
    assert "ON CONFLICT (vendor_number) DO UPDATE SET" in vendors
    assert "+ %(vendor_offset)s" in vendors and "('api:' || source_record_id)" in vendors
    params = next(p for sql, p in ALL["vendors"] if "INSERT INTO core.dim_vendor AS v" in sql)
    assert params["vendor_offset"] == 0  # Crane tenant
    ap = flat(next(sql for sql, _ in ALL["ap_invoices"] if "INSERT INTO core.fact_ap_invoice" in sql))
    assert "THEN %(sarus_offset)s ELSE 0 END AS vendor_number" in ap
    ap_params = next(p for sql, p in ALL["ap_invoices"] if "INSERT INTO core.fact_ap_invoice" in sql)
    assert ap_params["sarus_offset"] == rules.SARUS_VENDOR_OFFSET and ap_params["tenant_namespace"] == "Crane"


def test_gl_budget_months_are_rebuilt_for_api_budgets_only() -> None:
    months = flat(next(sql for sql, _ in ALL["gl_budgets"] if "INSERT INTO core.fact_gl_budget_month" in sql))
    assert "WHERE b.source = %(source)s" in months


# ── namespace decision (pure) ────────────────────────────────────────────────
def test_company_numbers_map_and_tenant_namespace() -> None:
    assert normalize.company_numbers_map({"1": "Crane IFS", 2: " Crane West ", "3": "", "4": 7}) == {"1": "Crane IFS", "2": "Crane West"}
    assert normalize.company_numbers_map("nope") == {}
    assert normalize.tenant_namespace({}) == rules.NAMESPACE_CRANE
    assert normalize.tenant_namespace({"1": "Crane IFS", "2": "Sarus"}) == rules.NAMESPACE_CRANE
    assert normalize.tenant_namespace({"1": "ServiceMaster by Sarus Co"}) == rules.NAMESPACE_SARUS
    # the SQL namespace expression mirrors rules.namespace_for: substring 'sarus', case-insensitive, else Crane
    sql = normalize.namespace_sql("x.label")
    assert "strpos(lower(coalesce(x.label, '')), 'sarus') > 0" in sql
    assert f"THEN '{rules.NAMESPACE_SARUS}' ELSE '{rules.NAMESPACE_CRANE}' END" in sql
    assert rules.namespace_for("ServiceMaster by Sarus Co") == rules.NAMESPACE_SARUS
    assert rules.namespace_for("Crane IFS") == rules.NAMESPACE_CRANE
