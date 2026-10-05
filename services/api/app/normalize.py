"""Promote the latest raw WinTeam payload versions into the core tables (migration 003 / 005 / 008).

Everything here is SQL executed against raw.v_winteam_current (one row per record: the newest
payload version). Each resource is normalized in a single transaction with the session time zone
pinned to UTC so RFC3339 "Z" timestamps land deterministically.

Source coexistence rules (the live API next to the finance_reference export load)
--------------------------------------------------------------------------------
Every core row carries `source`: 'finance_reference' for the export load, 'winteam_api' for rows
this module writes. The two sources share the tables; they never overwrite each other's facts.

* core.dim_job: ONE current row per job_number regardless of source (unique index
  dim_job_current_job_number_idx). The API's jobs payload updates that row in place: winteam_id
  becomes the jobId GUID, and job_name, tiers (region/branch/service_type/manager/vertical via
  ops.app_setting.job_tier_map), address, taxAddress latitude/longitude (geo_precision 'exact'
  when both are present), company (companyNumber -> ops.app_setting.company_numbers), is_active
  and `source = 'winteam_api'` are set. Fields the API does not carry or did not supply
  (delivery_model, account_group, customer_number/name, parent account, city-centroid coordinates,
  date_discontinued, any NULL API field) keep the reference value: the row-level `source` says the
  API is the master of the job attributes it supplies, not that every column came from it.
  Reference-only jobs are never deleted and never deactivated; only rows the API itself supplied
  (`source = 'winteam_api'`) are marked inactive when they drop out of the feed.
* Crane / Sarus namespace: the reference loader keys jobs by bare job_number and records the
  namespace on the row (company_name_raw contains "Sarus" or not). The jobs endpoint carries no
  company name, only companyNumber, so the namespace of an API job is derived from the
  company_numbers label (a label containing "sarus" = Sarus, anything else = Crane, exactly like
  sources/rules.namespace_for). When the label is unmapped the namespace is unknown and the job
  falls back to a plain job_number match. When both namespaces are known and DIFFER (the tenant
  returns Crane job 401 while the reference row 401 is a Sarus job) the reference row is left
  untouched, the collision is logged and counted, and the API job is inserted as its own current
  row under the NAMESPACED number rules.namespaced_job_number (e.g. 'Crane:401'), the reference
  loader's convention for identities that are only unique within one database.
* API facts resolve their job through mart.v_api_job_map (migration 012), the single place that
  says which dim_job row an API jobNumber means: the bare-number row when its company is one of the
  tenant's (company_numbers labels), else the namespaced row; never a row of the other namespace.
  Every normalizer that links facts to jobs stages that map into the TEMP table wt_job_map first
  (job_key_for / job_company_for), and the re-pointing of facts after a jobs sync uses it for API
  rows while reference rows keep the bare-number match. Vendors: Sarus vendor numbers are offset by
  rules.SARUS_VENDOR_OFFSET exactly as the reference loader does; the API tenant's namespace is
  Sarus only when every company_numbers label is a Sarus company, else Crane.
* core.fact_timekeeping: API rows are keyed winteam_id 'api:{timekeepingId}' with
  source 'winteam_api', labor_cost = hours x rate (labor_cost_basis 'hours_x_rate'); reference
  rows ('row:{uuid}') are never touched and the overtime derivation is scoped to API rows.
* core.fact_ar_invoice: 'api:{customerNumber}:{invoiceNumber}', amount_paid from the API
  (open_balance_basis 'api_amount_paid'); reference rows ('ar:{ns}:{invoice}') untouched.
  core.dim_customer rows discovered by the API carry source 'winteam_api'; existing customers keep
  their name unless ops.app_setting.customer_names overrides it.
* core.fact_ap_invoice: 'api:{companyNumber}:{vendorNumber}:{invoiceNumber}', company from
  company_numbers, vendor_number namespaced like the vendors above. core.dim_vendor is keyed by
  vendor_number (one row per warehouse vendor number): the API updates the row's name/contacts and
  sets winteam_id 'api:{vendorNumber}', source 'winteam_api'.
* Every ON CONFLICT ... DO UPDATE is guarded by `WHERE <table>.source = 'winteam_api'` (or applies
  to a dimension the API is allowed to master, see above); every DELETE is scoped to
  `source = 'winteam_api'` and to the records of the resource being re-normalized. Nothing here
  TRUNCATEs. The mart precedence between sources (API rows win the days / months they cover, the
  exports fill the rest) lives in marts.py, not here.

Parsing rules
-------------
* Numbers may arrive as JSON numbers or strings; values that do not look numeric become NULL.
* Dates are taken from the first ten characters of the payload string ("2022-10-01T12:00:00Z"
  -> 2022-10-01) so a UTC noon timestamp never shifts a work date. Timestamps (inTime/outTime)
  are parsed as timestamptz. Unparseable values become NULL rather than failing the load.
* Identifiers such as jobNumber, employeeNumber and customerNumber are stored as text because the
  documentation shows them as both numbers and strings.

Derived fields (disclosed honestly)
-----------------------------------
* fact_timekeeping.labor_cost = hours * rate when rate > 0 (labor_cost_basis 'hours_x_rate').
  A punch with no rate or a zero rate (24% of the live punches on 2026-09-03) is priced with the
  SAME rule the reference loader applies to the export lines (sources/rules.trailing_rate): the
  job's sum(direct_labor) / sum(actual_hours) over its last TRAILING_RATE_MONTHS closed job-cost
  months (core.fact_job_cost_month, month end + close_lag_days in the past, hours and labor > 0),
  unless that is above rules.MAX_JOB_RATE_RATIO x the company rate (labor dollars with almost no
  hours, not a wage), else the company's pooled rate over its last closed months, else the portfolio
  rate. Punches of any source already priced at such a rate are re-priced at the company rate. Such rows
  carry labor_cost_basis 'trailing_job_rate' and `rate` = the imputed rate (so the overtime premium
  estimate uses it too); a punch with no usable rate at all keeps labor_cost NULL with basis 'none'
  so a missing wage is never reported as free labor. The pure mirror `trailing_rates` /
  `price_punch` below is what the tests pin.
  Regular/overtime split: if ops.app_setting.overtime_category_detail_ids is non-empty, hours in
  those categories are overtime (overtime_basis = 'category'); otherwise hours beyond
  overtime_weekly_threshold_hours per (employee, Sunday-based pay week) are allocated to overtime
  in work-date order (overtime_basis = 'weekly_threshold'). Negative adjustment rows keep their
  signed `hours` but contribute 0 to the split because the 001 constraints require non-negative
  components.
* fact_ar_invoice.service_month = month of billingPeriodFrom, else invoiceDate. open_balance is a
  stored column = invoiceTotal - amountPaid (the endpoint exposes no explicit balance).
  is_collectible applies ops.app_setting.ar_treatment_rules to the customer name exactly like
  sources/rules.is_collectible (parent name only when the customer name is blank).
* fact_ap_payment.payment_date = checkDate, else paymentDateAdded. Payments are not linked to
  invoices by the API, so AP "open" amounts are not derivable.
* fact_gl_budget.account_class comes from ops.app_setting.gl_account_classes (account ranges and
  description keywords). fact_gl_budget_month maps period1..12 onto calendar months starting at
  ops.app_setting.fiscal_year_start_month, assuming `fiscalYear` names the calendar year in which
  period1 falls.
* dim_job region/branch/service_type/manager/vertical come from jobTiers via
  ops.app_setting.job_tier_map. Parent accounts are keyed by parentJobNumber (named after that
  job's description when it is in the feed) and jobs without a parent become their own account;
  a job that already has a parent account (reference load) keeps it.
* dim_job.is_active is only maintained when the jobs sync passes the ids it saw (normalize_all
  leaves the flag untouched). API-supplied jobs outside WINTEAM_LOCATION_IDS therefore read as
  inactive; reference-only jobs are not affected.

The whole current raw set is re-promoted on every call (idempotent upserts), which keeps the logic
simple and lets a settings change (tier map, overtime categories, company numbers) take effect on
the next sync.
"""
from __future__ import annotations

import json
import logging
from collections.abc import Collection, Mapping
from typing import Any

from .config import CANADIAN_PROVINCES, RESOURCE_NAMES
from .db import connection
from .sources import rules
from .tenants import PRIMARY, SARUS, SARUS_RESOURCE_NAMES, Tenant

logger = logging.getLogger("normalize")

SOURCE = "winteam_api"
API_PREFIX = "api:"

# Regular expressions used as SQL guards (PostgreSQL POSIX syntax).
NUMBER_RE = r"^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$"
DATE_RE = r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])"
TIMESTAMP_RE = r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$"
GL_CLASSES = ("revenue", "direct_labor", "subcontract", "supplies")


# ── SQL expression builders (field names are code constants, never user input) ───────────
def txt(field: str, src: str = "p") -> str:
    return f"nullif(btrim({src}->>'{field}'), '')"


def num(field: str, src: str = "p") -> str:
    return f"(CASE WHEN {src}->>'{field}' ~ '{NUMBER_RE}' THEN ({src}->>'{field}')::numeric END)"


def integer(field: str, src: str = "p") -> str:
    return f"(CASE WHEN {src}->>'{field}' ~ '{NUMBER_RE}' THEN round(({src}->>'{field}')::numeric)::integer END)"


def day(field: str, src: str = "p") -> str:
    return f"(CASE WHEN {src}->>'{field}' ~ '{DATE_RE}' THEN substring({src}->>'{field}' from 1 for 10)::date END)"


def stamp(field: str, src: str = "p") -> str:
    return f"(CASE WHEN {src}->>'{field}' ~ '{TIMESTAMP_RE}' THEN ({src}->>'{field}')::timestamptz END)"


def boolean(field: str, src: str = "p") -> str:
    return (
        f"(CASE WHEN jsonb_typeof({src}->'{field}') = 'boolean' THEN ({src}->'{field}')::boolean "
        f"WHEN lower({src}->>'{field}') IN ('true', '1', 'yes') THEN true "
        f"WHEN lower({src}->>'{field}') IN ('false', '0', 'no') THEN false END)"
    )


def json_array(field: str, src: str = "p") -> str:
    return f"(CASE WHEN jsonb_typeof({src}->'{field}') = 'array' THEN {src}->'{field}' ELSE '[]'::jsonb END)"


def api_id(expr: str = "source_record_id", tenant: Tenant = PRIMARY) -> str:
    """winteam_id of an API-sourced core row: the tenant's prefix ('api:', 'api:sarus:') + the raw source_record_id."""
    return f"('{tenant.id_prefix}' || {expr})"


def namespace_sql(expr: str) -> str:
    """'Sarus' | 'Crane' from a company label expression (mirrors sources.rules.namespace_for)."""
    return f"(CASE WHEN strpos(lower(coalesce({expr}, '')), 'sarus') > 0 THEN '{rules.NAMESPACE_SARUS}' ELSE '{rules.NAMESPACE_CRANE}' END)"


def company_label_sql(field: str = "companyNumber", src: str = "p") -> str:
    """Dashboard company label for a companyNumber via the %(company_numbers)s jsonb parameter."""
    return f"(%(company_numbers)s::jsonb ->> btrim({src}->>'{field}'))"


JOB_MAP_VIEW = "mart.v_api_job_map"
JOB_MAP_VIEWS = {PRIMARY.key: JOB_MAP_VIEW, SARUS.key: "mart.v_sarus_job_map"}


def job_key_for(expr: str) -> str:
    """job_key an API fact resolves to (wt_job_map = mart.v_api_job_map staged by stage_job_map)."""
    return f"(SELECT m.job_key FROM wt_job_map m WHERE m.raw_job_number = {expr})"


def job_company_for(expr: str) -> str:
    return f"(SELECT m.company FROM wt_job_map m WHERE m.raw_job_number = {expr})"


def stage_job_map(cursor: Any, tenant: Tenant = PRIMARY) -> None:
    """Snapshot the tenant's job map (mart.v_api_job_map | mart.v_sarus_job_map) into the TEMP table wt_job_map."""
    cursor.execute("DROP TABLE IF EXISTS wt_job_map")
    cursor.execute(
        f"CREATE TEMP TABLE wt_job_map ON COMMIT DROP AS "
        f"SELECT raw_job_number, job_number, job_key, company FROM {JOB_MAP_VIEWS[tenant.key]} WHERE raw_job_number IS NOT NULL"
    )
    cursor.execute("CREATE INDEX ON wt_job_map (raw_job_number)")


def vendor_key_for(expr: str) -> str:
    return f"(SELECT v.vendor_key FROM core.dim_vendor v WHERE v.vendor_number = {expr} LIMIT 1)"


def tier_description(tier_param: str) -> str:
    """Description of the job tier whose tierID equals the bound parameter ('None' -> NULL)."""
    return (
        "(SELECT nullif(btrim(t->>'tierValueDescription'), '') FROM jsonb_array_elements("
        + json_array("jobTiers")
        + ") t WHERE t->>'tierID' ~ '^\\d+$' AND (t->>'tierID')::int = "
        + tier_param
        + " AND lower(coalesce(t->>'tierValueDescription', '')) NOT IN ('', 'none') LIMIT 1)"
    )


SOURCE_SQL = "SELECT source_record_id, payload AS p FROM raw.v_winteam_current WHERE resource_name = %(resource)s"


def _tenant_params(tenant: Tenant, resource: str) -> dict[str, Any]:
    """The raw resource name and core source a normalizer reads and writes for `tenant`."""
    return {"resource": tenant.raw_resource(resource), "source": tenant.source, "tenant_company": tenant.company}


def _begin(conn: Any) -> None:
    with conn.cursor() as cursor:
        cursor.execute("SET LOCAL TIME ZONE 'UTC'")


def _setting(conn: Any, key: str, default: Any) -> Any:
    with conn.cursor() as cursor:
        cursor.execute("SELECT value FROM ops.app_setting WHERE key = %s", (key,))
        row = cursor.fetchone()
    return row["value"] if row and row["value"] is not None else default


def _tier_id(tier_map: Any, name: str) -> int | None:
    value = tier_map.get(name) if isinstance(tier_map, dict) else None
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def company_numbers_map(setting: Any) -> dict[str, str]:
    """ops.app_setting.company_numbers as {companyNumber string: label}; malformed entries dropped."""
    if not isinstance(setting, Mapping):
        return {}
    out: dict[str, str] = {}
    for key, value in setting.items():
        k = str(key).strip()
        if k and isinstance(value, str) and value.strip():
            out[k] = value.strip()
    return out


def tenant_namespace(company_numbers: Mapping[str, str]) -> str:
    """Namespace of the API tenant's vendor numbers: Sarus only when every mapped company is Sarus."""
    labels = list(company_numbers.values())
    if labels and all(rules.namespace_for(label) == rules.NAMESPACE_SARUS for label in labels):
        return rules.NAMESPACE_SARUS
    return rules.NAMESPACE_CRANE


def _company_context(conn: Any, tenant: Tenant = PRIMARY) -> dict[str, Any]:
    if tenant.vendor_namespace is not None:
        # A secondary database: ops.app_setting.company_numbers describes the primary tenant only,
        # so none of its labels apply; every row takes the tenant's company and vendor namespace.
        return {
            "company_numbers": json.dumps({}),
            "tenant_namespace": tenant.vendor_namespace,
            "sarus_offset": rules.SARUS_VENDOR_OFFSET,
            "vendor_offset": rules.SARUS_VENDOR_OFFSET if tenant.vendor_namespace == rules.NAMESPACE_SARUS else 0,
        }
    numbers = company_numbers_map(_setting(conn, "company_numbers", {}))
    ns = tenant_namespace(numbers)
    return {
        "company_numbers": json.dumps(numbers),
        "tenant_namespace": ns,
        "sarus_offset": rules.SARUS_VENDOR_OFFSET,
        "vendor_offset": rules.SARUS_VENDOR_OFFSET if ns == rules.NAMESPACE_SARUS else 0,
    }


# ── jobs ─────────────────────────────────────────────────────────────────────
def _normalize_jobs_inner(conn: Any, seen_ids: Collection[str] | None = None) -> int:
    tier_map = _setting(conn, "job_tier_map", {})
    tiers = {name: _tier_id(tier_map, name) for name in ("region", "branch", "service_type", "manager", "vertical")}
    params: dict[str, Any] = {
        "resource": "jobs",
        "provinces": sorted(CANADIAN_PROVINCES),
        "source": SOURCE,
        **{f"tier_{name}": value for name, value in tiers.items()},
        **_company_context(conn),
    }
    with conn.cursor() as cursor:
        # 1. Parse the current raw set once (TEMP, dropped with the transaction).
        #    One row per job_number: should the feed carry two identities for one number (a recycled
        #    job still listed next to its successor) the one that started most recently wins.
        cursor.execute("DROP TABLE IF EXISTS wt_jobs")
        cursor.execute(
            f"""
            CREATE TEMP TABLE wt_jobs ON COMMIT DROP AS
            WITH src AS ({SOURCE_SQL}),
            parsed AS (
            SELECT
              source_record_id AS winteam_id,
              {txt('jobNumber')} AS job_number,
              {txt('jobDescription')} AS job_name,
              {txt('parentJobNumber')} AS parent_job_number,
              {integer('companyNumber')} AS company_number,
              {company_label_sql()} AS company_label,
              CASE WHEN {company_label_sql()} IS NOT NULL THEN {namespace_sql(company_label_sql())} END AS api_namespace,
              {integer('locationId')} AS location_id,
              {integer('typeId')} AS type_id,
              {integer('supervisorId')} AS supervisor_id,
              {integer('hoursRuleId')} AS hours_rule_id,
              {integer('hoursCategoryID')} AS hours_category_id,
              {integer('taxesInsuranceId')} AS taxes_insurance_id,
              {day('dateToStart')} AS date_to_start,
              {txt('notes')} AS notes,
              {txt('jobAddress1', "(p->'address')")} AS address_line_1,
              {txt('jobAddress2', "(p->'address')")} AS address_line_2,
              {txt('jobCity', "(p->'address')")} AS city,
              upper({txt('jobState', "(p->'address')")}) AS state_province,
              {txt('jobZip', "(p->'address')")} AS postal_code,
              CASE WHEN {num('latitude', "(p->'taxAddress')")} BETWEEN -90 AND 90 THEN {num('latitude', "(p->'taxAddress')")} END AS latitude,
              CASE WHEN {num('longitude', "(p->'taxAddress')")} BETWEEN -180 AND 180 THEN {num('longitude', "(p->'taxAddress')")} END AS longitude,
              {json_array('jobTiers')} AS tiers,
              {json_array('customFields')} AS custom_fields,
              {tier_description('%(tier_region)s')} AS region_name,
              {tier_description('%(tier_branch)s')} AS branch_name,
              {tier_description('%(tier_service_type)s')} AS service_type,
              {tier_description('%(tier_manager)s')} AS manager_name,
              {tier_description('%(tier_vertical)s')} AS vertical
            FROM src
            )
            SELECT DISTINCT ON (job_number) * FROM parsed
            WHERE job_number IS NOT NULL AND winteam_id IS NOT NULL
            ORDER BY job_number, date_to_start DESC NULLS LAST, winteam_id
            """,
            params,
        )

        # 2. Namespace conflicts: the same job_number is a different physical job in the other
        #    WinTeam database. The reference row wins; the API record is dropped from this run.
        cursor.execute(
            f"""
            SELECT x.job_number, x.company_label, d.company_name_raw
            FROM wt_jobs x
            JOIN core.dim_job d ON d.job_number = x.job_number AND d.valid_to IS NULL
            WHERE x.api_namespace IS NOT NULL AND d.company_name_raw IS NOT NULL
              AND {namespace_sql('d.company_name_raw')} <> x.api_namespace
            ORDER BY x.job_number
            """
        )
        conflicts = cursor.fetchall() or []
        if conflicts:
            logger.warning(
                "normalize jobs: %s job number(s) belong to the other namespace in the reference load; the reference rows are left "
                "untouched and the API jobs are keyed %s:<number>: %s",
                len(conflicts), params["tenant_namespace"],
                ", ".join(f"{c['job_number']} (api {c['company_label']} vs reference {c['company_name_raw']})" for c in conflicts[:20]),
            )
            cursor.execute(
                f"""
                UPDATE wt_jobs x SET job_number = %(tenant_namespace)s || ':' || x.job_number
                FROM core.dim_job d
                WHERE d.job_number = x.job_number AND d.valid_to IS NULL
                  AND x.api_namespace IS NOT NULL AND d.company_name_raw IS NOT NULL
                  AND {namespace_sql('d.company_name_raw')} <> x.api_namespace
                """,
                params,
            )
        cursor.execute("SELECT count(*) AS n FROM wt_jobs WHERE company_number IS NOT NULL AND company_label IS NULL")
        unmapped = (cursor.fetchone() or {}).get("n") or 0
        if unmapped:
            logger.info("normalize jobs: %s job(s) carry a companyNumber missing from ops.app_setting.company_numbers; company kept as is", unmapped)

        # 3. Parent accounts keyed by parentJobNumber (or the job's own number when it has none).
        cursor.execute(
            """
            WITH accounts AS (
              SELECT DISTINCT ON (account_id) account_id, account_name FROM (
                SELECT coalesce(j.parent_job_number, j.job_number) AS account_id,
                       coalesce(parent.job_name,
                                CASE WHEN j.parent_job_number IS NULL THEN j.job_name END,
                                coalesce(j.parent_job_number, j.job_number)) AS account_name
                FROM wt_jobs j
                LEFT JOIN wt_jobs parent ON parent.job_number = j.parent_job_number
                WHERE coalesce(j.parent_job_number, j.job_number) IS NOT NULL
              ) x
              ORDER BY account_id, account_name
            )
            INSERT INTO core.dim_parent_account (winteam_id, account_name, active)
            SELECT account_id, account_name, true FROM accounts
            ON CONFLICT (winteam_id) DO UPDATE
              SET account_name = excluded.account_name, active = true, warehouse_updated_at = now()
            """
        )

        # 4. Close API-owned current rows whose job number is being re-used by a different WinTeam
        #    identity (job number recycling). Reference rows (winteam_id = job_number) simply adopt
        #    the GUID in step 5.
        cursor.execute(
            """
            UPDATE core.dim_job d
            SET valid_to = now(), is_active = false, status = 'recycled', warehouse_updated_at = now()
            FROM wt_jobs x
            WHERE d.job_number = x.job_number AND d.valid_to IS NULL
              AND d.source = %(source)s AND d.winteam_id <> x.winteam_id
              AND x.winteam_id NOT IN (SELECT winteam_id FROM core.dim_job WHERE valid_to IS NULL)
            """,
            params,
        )

        # 5. Upsert the job dimension: one current row per job_number, whichever source created it.
        cursor.execute(
            """
            INSERT INTO core.dim_job AS d (
              winteam_id, identity_version, parent_account_key, job_number, job_name, status,
              service_type, branch_name, region_name, manager_name, vertical,
              address_line_1, address_line_2, city, state_province, postal_code, country_code,
              latitude, longitude, geo_precision, company_number, location_id, parent_job_number, type_id,
              supervisor_id, hours_rule_id, hours_category_id, taxes_insurance_id, date_to_start,
              notes, tiers, custom_fields, is_active, last_seen_at, warehouse_updated_at,
              source, company, company_name_raw
            )
            SELECT
              x.winteam_id,
              1 + coalesce((SELECT max(h.identity_version) FROM core.dim_job h WHERE h.winteam_id = x.winteam_id), 0),
              (SELECT a.parent_account_key FROM core.dim_parent_account a
                WHERE a.winteam_id = coalesce(x.parent_job_number, x.job_number)),
              x.job_number, x.job_name, 'active',
              x.service_type, x.branch_name, x.region_name, x.manager_name, x.vertical,
              x.address_line_1, x.address_line_2, x.city, x.state_province, x.postal_code,
              CASE WHEN x.state_province IS NULL THEN NULL
                   WHEN x.state_province = ANY(%(provinces)s::text[]) THEN 'CA' ELSE 'US' END,
              x.latitude, x.longitude,
              CASE WHEN x.latitude IS NOT NULL AND x.longitude IS NOT NULL THEN 'exact' END,
              x.company_number, x.location_id, x.parent_job_number, x.type_id,
              x.supervisor_id, x.hours_rule_id, x.hours_category_id, x.taxes_insurance_id, x.date_to_start,
              x.notes, x.tiers, x.custom_fields, true, now(), now(),
              %(source)s, x.company_label, x.company_label
            FROM wt_jobs x
            WHERE x.winteam_id IS NOT NULL AND x.job_number IS NOT NULL
            ON CONFLICT (job_number) WHERE valid_to IS NULL DO UPDATE SET
              winteam_id = excluded.winteam_id,
              parent_account_key = coalesce(d.parent_account_key, excluded.parent_account_key),
              job_name = coalesce(excluded.job_name, d.job_name),
              status = 'active',
              service_type = coalesce(excluded.service_type, d.service_type),
              branch_name = coalesce(excluded.branch_name, d.branch_name),
              region_name = coalesce(excluded.region_name, d.region_name),
              manager_name = coalesce(excluded.manager_name, d.manager_name),
              vertical = coalesce(excluded.vertical, d.vertical),
              address_line_1 = coalesce(excluded.address_line_1, d.address_line_1),
              address_line_2 = coalesce(excluded.address_line_2, d.address_line_2),
              city = coalesce(excluded.city, d.city),
              state_province = coalesce(excluded.state_province, d.state_province),
              postal_code = coalesce(excluded.postal_code, d.postal_code),
              country_code = coalesce(excluded.country_code, d.country_code),
              latitude = coalesce(excluded.latitude, d.latitude),
              longitude = coalesce(excluded.longitude, d.longitude),
              geo_precision = CASE WHEN excluded.latitude IS NOT NULL AND excluded.longitude IS NOT NULL THEN 'exact' ELSE d.geo_precision END,
              company_number = coalesce(excluded.company_number, d.company_number),
              location_id = coalesce(excluded.location_id, d.location_id),
              parent_job_number = coalesce(excluded.parent_job_number, d.parent_job_number),
              type_id = coalesce(excluded.type_id, d.type_id),
              supervisor_id = coalesce(excluded.supervisor_id, d.supervisor_id),
              hours_rule_id = coalesce(excluded.hours_rule_id, d.hours_rule_id),
              hours_category_id = coalesce(excluded.hours_category_id, d.hours_category_id),
              taxes_insurance_id = coalesce(excluded.taxes_insurance_id, d.taxes_insurance_id),
              date_to_start = coalesce(excluded.date_to_start, d.date_to_start),
              notes = coalesce(excluded.notes, d.notes),
              tiers = CASE WHEN jsonb_array_length(excluded.tiers) > 0 THEN excluded.tiers ELSE d.tiers END,
              custom_fields = CASE WHEN jsonb_array_length(excluded.custom_fields) > 0 THEN excluded.custom_fields ELSE d.custom_fields END,
              is_active = true,
              last_seen_at = now(),
              warehouse_updated_at = now(),
              source = excluded.source,
              company = coalesce(excluded.company, d.company),
              company_name_raw = coalesce(d.company_name_raw, excluded.company_name_raw)
            """,
            params,
        )
        affected = cursor.rowcount

        # 6. Activity flags from the ids seen in the latest successful jobs run. Only rows the API
        #    supplied can be deactivated by absence; reference-only jobs keep their flag.
        if seen_ids is not None:
            seen = list(seen_ids)
            cursor.execute(
                """
                UPDATE core.dim_job SET is_active = true, status = 'active', last_seen_at = now(), warehouse_updated_at = now()
                WHERE valid_to IS NULL AND winteam_id = ANY(%(seen)s::text[])
                """,
                {"seen": seen},
            )
            cursor.execute(
                """
                UPDATE core.dim_job SET is_active = false, status = 'inactive', warehouse_updated_at = now()
                WHERE valid_to IS NULL AND is_active AND source = %(source)s AND NOT (winteam_id = ANY(%(seen)s::text[]))
                """,
                {"seen": seen, "source": SOURCE},
            )

        # 7. Tier detail table (replace the tiers of every job the API just supplied).
        cursor.execute(
            """
            DELETE FROM core.job_tier jt USING core.dim_job d
            WHERE jt.job_key = d.job_key AND d.valid_to IS NULL AND d.source = %(source)s
              AND d.winteam_id IN (SELECT winteam_id FROM wt_jobs)
            """,
            params,
        )
        cursor.execute(
            f"""
            WITH rows AS (
              SELECT DISTINCT ON (d.job_key, (t->>'tierID')::int)
                d.job_key, (t->>'tierID')::int AS tier_id,
                {integer('tierValue', 't')} AS tier_value,
                {txt('tierValueDescription', 't')} AS tier_description
              FROM wt_jobs x
              JOIN core.dim_job d ON d.winteam_id = x.winteam_id AND d.valid_to IS NULL
              CROSS JOIN LATERAL jsonb_array_elements(x.tiers) t
              WHERE t->>'tierID' ~ '^\\d+$'
            )
            INSERT INTO core.job_tier (job_key, tier_id, tier_value, tier_description)
            SELECT job_key, tier_id, tier_value, tier_description FROM rows
            ON CONFLICT (job_key, tier_id) DO UPDATE
              SET tier_value = excluded.tier_value, tier_description = excluded.tier_description
            """
        )

        # 8. Parent account vertical = most common vertical among its current jobs.
        cursor.execute(
            """
            UPDATE core.dim_parent_account a SET vertical = s.vertical, warehouse_updated_at = now()
            FROM (
              SELECT parent_account_key, mode() WITHIN GROUP (ORDER BY vertical) AS vertical
              FROM core.dim_job WHERE valid_to IS NULL AND vertical IS NOT NULL AND parent_account_key IS NOT NULL
              GROUP BY parent_account_key
            ) s
            WHERE s.parent_account_key = a.parent_account_key AND a.vertical IS DISTINCT FROM s.vertical
            """
        )

        # 9. Re-point facts loaded before their job existed.
        repoint_facts(cursor)
    return affected



REPOINT_TABLES = (
    "core.fact_timekeeping", "core.fact_schedule", "core.fact_ar_invoice", "core.fact_gl_budget",
    "core.fact_job_budget", "core.fact_ap_distribution",
)


def repoint_facts(cursor: Any) -> None:
    """Point every fact at its current job row.

    Export rows match the bare number (the current row is shared). Each API tenant's rows resolve
    through that tenant's own job map, so a collision number lands on the tenant's row and never on
    the other database's (Crane job 300 -> 'Crane:300', Sarus job 300 -> the bare Sarus row).
    """
    api_sources = [PRIMARY.source, SARUS.source]
    for table in REPOINT_TABLES:
        cursor.execute(
            f"""
            UPDATE {table} f SET job_key = d.job_key
            FROM core.dim_job d
            WHERE f.source <> ALL(%(api_sources)s) AND d.job_number = f.job_number AND d.valid_to IS NULL
              AND f.job_key IS DISTINCT FROM d.job_key
            """,
            {"api_sources": api_sources},
        )
    for tenant in (PRIMARY, SARUS):
        stage_job_map(cursor, tenant)
        for table in REPOINT_TABLES:
            cursor.execute(
                f"""
                UPDATE {table} f SET job_key = m.job_key
                FROM wt_job_map m
                WHERE f.source = %(source)s AND m.raw_job_number = f.job_number AND f.job_key IS DISTINCT FROM m.job_key
                """,
                {"source": tenant.source},
            )


def normalize_jobs(conn: Any, seen_ids: Collection[str] | None = None) -> int:
    """Normalize jobs from the latest landing, then apply configured account groups.

    Grouping runs on the caller's connection. It reads and updates the very core.dim_job rows this
    transaction has just written, so opening a second connection for it blocked on row locks the
    calling transaction itself held - a single-process self-deadlock that hung the worker (and,
    behind its locks, the mart rebuild and every reporting read) until it was killed. The savepoint
    keeps the old guarantee that a grouping failure never fails the sync.
    """
    result = _normalize_jobs_inner(conn, seen_ids)
    try:
        with conn.transaction():
            apply_account_groups(conn)
    except Exception:  # noqa: BLE001 - grouping must never fail a sync
        logger.exception("Account grouping failed after jobs normalization")
    return result

# ── vendors ──────────────────────────────────────────────────────────────────
def normalize_vendors(conn: Any, seen_ids: Collection[str] | None = None, tenant: Tenant = PRIMARY) -> int:
    params = {**_tenant_params(tenant, "vendors"), **_company_context(conn, tenant)}
    with conn.cursor() as cursor:
        cursor.execute(
            f"""
            WITH src AS ({SOURCE_SQL})
            INSERT INTO core.dim_vendor AS v (
              winteam_id, vendor_number, vendor_name, active, vendor_type_id, parent_vendor_number,
              account_number, phone, address, contacts, source, warehouse_updated_at
            )
            SELECT
              {api_id(tenant=tenant)},
              {integer('vendorNumber')} + %(vendor_offset)s,
              coalesce({txt('vendorName')}, 'Vendor ' || source_record_id),
              coalesce({boolean('vendorStatus')}, true),
              {integer('vendorTypeId')},
              {integer('parentVendorNumber')},
              {txt('accountNumber')},
              {txt('phone')},
              CASE WHEN jsonb_typeof(p->'address') = 'object' THEN p->'address' END,
              {json_array('contactsInformation')},
              %(source)s,
              now()
            FROM src
            WHERE {integer('vendorNumber')} IS NOT NULL
            ON CONFLICT (vendor_number) DO UPDATE SET
              winteam_id = excluded.winteam_id,
              vendor_name = excluded.vendor_name,
              active = excluded.active,
              vendor_type_id = excluded.vendor_type_id,
              parent_vendor_number = excluded.parent_vendor_number,
              account_number = excluded.account_number,
              phone = excluded.phone,
              address = excluded.address,
              contacts = excluded.contacts,
              source = excluded.source,
              warehouse_updated_at = now()
            """,
            params,
        )
        affected = cursor.rowcount
        for table in ("core.fact_ap_invoice", "core.fact_ap_payment"):
            cursor.execute(
                f"""
                UPDATE {table} f SET vendor_key = v.vendor_key
                FROM core.dim_vendor v
                WHERE v.vendor_number = f.vendor_number AND f.vendor_key IS DISTINCT FROM v.vendor_key
                """
            )
    return affected


# ── timekeeping ──────────────────────────────────────────────────────────────
def normalize_timekeeping(conn: Any, seen_ids: Collection[str] | None = None, tenant: Tenant = PRIMARY) -> int:
    params = _tenant_params(tenant, "timekeeping")
    with conn.cursor() as cursor:
        stage_job_map(cursor, tenant)
        cursor.execute(
            f"""
            WITH src AS ({SOURCE_SQL}),
            parsed AS (
              SELECT
                {api_id(tenant=tenant)} AS winteam_id,
                {txt('jobNumber')} AS job_number,
                {txt('employeeNumber')} AS employee_source_id,
                {day('workDate')} AS work_date,
                {num('hours')} AS hours,
                {integer('categoryDetailId')} AS category_detail_id,
                {num('rate')} AS rate,
                {stamp('inTime')} AS in_time,
                {stamp('outTime')} AS out_time,
                {num('lunch')} AS lunch,
                {txt('workTicketNumber')} AS work_ticket_number
              FROM src
            )
            INSERT INTO core.fact_timekeeping AS t (
              winteam_id, job_key, job_number, employee_source_id, work_date, hours, regular_hours, overtime_hours,
              labor_cost, category_detail_id, rate, in_time, out_time, lunch, work_ticket_number,
              pay_week_start, overtime_basis, source, company, labor_cost_basis, warehouse_loaded_at
            )
            SELECT
              x.winteam_id, {job_key_for('x.job_number')}, x.job_number, x.employee_source_id, x.work_date,
              x.hours, greatest(coalesce(x.hours, 0), 0), 0,
              CASE WHEN x.rate > 0 THEN round(coalesce(x.hours, 0) * x.rate, 2) END,
              x.category_detail_id, x.rate, x.in_time, x.out_time, x.lunch, x.work_ticket_number,
              x.work_date - extract(dow FROM x.work_date)::int, 'none',
              %(source)s, coalesce(%(tenant_company)s::text, {job_company_for('x.job_number')}),
              CASE WHEN x.rate > 0 THEN 'hours_x_rate' ELSE 'none' END, now()
            FROM parsed x
            WHERE x.work_date IS NOT NULL
            ON CONFLICT (winteam_id) DO UPDATE SET
              job_key = excluded.job_key,
              job_number = excluded.job_number,
              employee_source_id = excluded.employee_source_id,
              work_date = excluded.work_date,
              hours = excluded.hours,
              regular_hours = excluded.regular_hours,
              overtime_hours = excluded.overtime_hours,
              labor_cost = excluded.labor_cost,
              category_detail_id = excluded.category_detail_id,
              rate = excluded.rate,
              in_time = excluded.in_time,
              out_time = excluded.out_time,
              lunch = excluded.lunch,
              work_ticket_number = excluded.work_ticket_number,
              pay_week_start = excluded.pay_week_start,
              overtime_basis = 'none',
              company = excluded.company,
              labor_cost_basis = excluded.labor_cost_basis,
              warehouse_loaded_at = now()
            WHERE t.source = %(source)s
            """,
            params,
        )
        affected = cursor.rowcount
    derive_overtime(conn, tenant.source)
    priced = price_unpriced_punches(conn, tenant.source)
    if priced:
        logger.info("normalize timekeeping (%s): %s unpriced API punch(es) priced at the trailing job rate: %s", tenant.key, sum(priced.values()), priced)
    return affected


# ── pricing of punches the API reports without a rate ───────────────────────
TRAILING_RATE_MONTHS = rules.TRAILING_RATE_MONTHS
TRAILING_JOB_RATE_BASIS = "trailing_job_rate"

# The SQL form of sources/rules.trailing_rate applied to the API rows whose labor_cost is NULL.
PRICE_UNPRICED_SQL = """
WITH closed AS (
  SELECT job_number, company, month, direct_labor, actual_hours
  FROM mart.v_job_cost_month_effective
  WHERE (month + interval '1 month' - interval '1 day')::date + %(lag_days)s::int < current_date
    AND coalesce(actual_hours, 0) > 0 AND coalesce(direct_labor, 0) > 0
),
job_recent AS (
  SELECT job_number, direct_labor, actual_hours, dense_rank() OVER (PARTITION BY job_number ORDER BY month DESC) AS recency
  FROM closed
),
job_rate AS (
  SELECT job_number, sum(direct_labor) / sum(actual_hours) AS rate FROM job_recent WHERE recency <= %(months)s GROUP BY job_number
),
company_recent AS (
  SELECT company, direct_labor, actual_hours, dense_rank() OVER (PARTITION BY company ORDER BY month DESC) AS recency
  FROM closed WHERE company IS NOT NULL
),
company_rate AS (
  SELECT company, sum(direct_labor) / sum(actual_hours) AS rate FROM company_recent WHERE recency <= %(months)s GROUP BY company
),
portfolio_recent AS (
  SELECT direct_labor, actual_hours, dense_rank() OVER (ORDER BY month DESC) AS recency FROM closed
),
portfolio_rate AS (
  SELECT sum(direct_labor) / sum(actual_hours) AS rate FROM portfolio_recent WHERE recency <= %(months)s
),
unpriced AS (
  -- A job rate above max_ratio x its company's rate is labor dollars with almost no hours, not a wage
  -- (rules.MAX_JOB_RATE_RATIO): such a job takes the company rate.
  SELECT t.timekeeping_key,
         CASE WHEN jr.rate IS NOT NULL AND (cr.rate IS NULL OR jr.rate <= %(max_ratio)s * cr.rate) THEN jr.rate ELSE coalesce(cr.rate, pr.rate, jr.rate) END AS rate,
         CASE WHEN jr.rate IS NOT NULL AND (cr.rate IS NULL OR jr.rate <= %(max_ratio)s * cr.rate) THEN 'job'
              WHEN cr.rate IS NOT NULL THEN 'company' WHEN pr.rate IS NOT NULL THEN 'portfolio' END AS basis
  FROM core.fact_timekeeping t
  -- The rate belongs to the job the punch resolved to: a raw number shared by both WinTeam
  -- databases (401, 6325, 99999) is a different job in each, keyed 'Crane:<n>' on one side.
  LEFT JOIN core.dim_job dj ON dj.job_key = t.job_key
  LEFT JOIN job_rate jr ON jr.job_number = coalesce(dj.job_number, t.job_number)
  LEFT JOIN company_rate cr ON cr.company = t.company
  CROSS JOIN portfolio_rate pr
  WHERE t.source = %(source)s AND t.labor_cost_basis IS DISTINCT FROM %(basis)s
)
UPDATE core.fact_timekeeping t
SET source_rate = coalesce(t.source_rate, NULLIF(t.rate, 0)),
    rate = round(u.rate, 4),
    labor_cost = round(coalesce(t.hours, 0) * u.rate, 2),
    labor_cost_basis = %(basis)s
FROM unpriced u
WHERE u.timekeeping_key = t.timekeeping_key AND t.source = %(source)s AND u.rate IS NOT NULL
RETURNING u.basis
"""


# Punches of any source already priced at a trailing job rate above max_ratio x the company rate (priced before
# the guard, or by the reference load) are re-priced at the company rate. Idempotent: a re-priced punch is at
# the company rate, so it no longer matches.
REPRICE_IMPLAUSIBLE_SQL = """
WITH closed AS (
  SELECT company, month, direct_labor, actual_hours
  FROM mart.v_job_cost_month_effective
  WHERE (month + interval '1 month' - interval '1 day')::date + %(lag_days)s::int < current_date
    AND coalesce(actual_hours, 0) > 0 AND coalesce(direct_labor, 0) > 0 AND company IS NOT NULL
),
company_rate AS (
  SELECT company, sum(direct_labor) / sum(actual_hours) AS rate
  FROM (SELECT *, dense_rank() OVER (PARTITION BY company ORDER BY month DESC) AS recency FROM closed) c
  WHERE recency <= %(months)s GROUP BY company
)
UPDATE core.fact_timekeeping t
SET rate = round(cr.rate, 4), labor_cost = round(coalesce(t.hours, 0) * cr.rate, 2)
FROM company_rate cr
WHERE t.company = cr.company AND t.labor_cost_basis = %(basis)s AND t.rate > %(max_ratio)s * cr.rate
"""


def _close_lag_days(conn: Any) -> int:
    try:
        return max(0, int(_setting(conn, "close_lag_days", 5)))
    except (TypeError, ValueError):
        return 5


def price_unpriced_punches(conn: Any, source: str = SOURCE) -> dict[str, int]:
    """Price EVERY API punch at the job's trailing payroll rate (job-cost direct labor / hours over the last closed
    months; company, then portfolio fallback), keeping the API's own rate in `source_rate`.

    The API `rate` is the base pay rate (~8% below the all-in payroll rate the job-cost P&L and the
    executives' figures use), so pricing live punches at it understated labor inside the API window.
    Idempotent: punches already on the trailing basis are skipped."""
    params = {"source": source, "lag_days": _close_lag_days(conn), "months": TRAILING_RATE_MONTHS, "basis": TRAILING_JOB_RATE_BASIS,
              "max_ratio": rules.MAX_JOB_RATE_RATIO}
    with conn.cursor() as cursor:
        cursor.execute(PRICE_UNPRICED_SQL, params)
        rows = cursor.fetchall() or []
        cursor.execute(REPRICE_IMPLAUSIBLE_SQL, params)
        repriced = cursor.rowcount
    if repriced:
        logger.info("re-priced %s punch(es) whose trailing job rate was above %sx the company rate", repriced, rules.MAX_JOB_RATE_RATIO)
    counts: dict[str, int] = {}
    for row in rows:
        basis = row.get("basis") if isinstance(row, Mapping) else None
        counts[str(basis)] = counts.get(str(basis), 0) + 1
    return counts


def month_is_closed(month: Any, lag_days: int, today: Any) -> bool:
    """A job-cost month is closed once its last day + close_lag_days is before `today` (same test as marts.py jc_months)."""
    from calendar import monthrange
    from datetime import date, timedelta

    last = date(month.year, month.month, monthrange(month.year, month.month)[1])
    return last + timedelta(days=lag_days) < today


def trailing_rates(job_cost_rows: list[Mapping[str, Any]], lag_days: int, today: Any, months: int = TRAILING_RATE_MONTHS) -> dict[str, Any]:
    """Pure mirror of PRICE_UNPRICED_SQL: {"job": {job_number: rate}, "company": {company: rate}, "portfolio": rate | None}."""
    usable = [
        r for r in job_cost_rows
        if month_is_closed(r["month"], lag_days, today) and float(r.get("actual_hours") or 0) > 0 and float(r.get("direct_labor") or 0) > 0
    ]

    def pooled(rows: list[Mapping[str, Any]]) -> float | None:
        recent_months = sorted({r["month"] for r in rows}, reverse=True)[:months]
        recent = [r for r in rows if r["month"] in recent_months]
        hours = sum(float(r["actual_hours"]) for r in recent)
        labor = sum(float(r["direct_labor"]) for r in recent)
        return labor / hours if hours > 0 and labor > 0 else None

    jobs = sorted({r["job_number"] for r in usable})
    companies = sorted({r["company"] for r in usable if r.get("company")})
    return {
        "job": {j: pooled([r for r in usable if r["job_number"] == j]) for j in jobs},
        "company": {c: pooled([r for r in usable if r.get("company") == c]) for c in companies},
        "portfolio": pooled(usable),
    }


def price_punch(punch: Mapping[str, Any], rates: Mapping[str, Any]) -> tuple[float | None, float | None, str]:
    """(labor_cost, rate, labor_cost_basis) for one API punch under the same rule as the SQL."""
    hours = float(punch.get("hours") or 0)
    rate = punch.get("rate")
    if rate is not None and float(rate) > 0:
        return round(hours * float(rate), 2), float(rate), "hours_x_rate"
    job, company = rates["job"].get(punch.get("job_number")), rates["company"].get(punch.get("company"))
    if job and company and job > rules.MAX_JOB_RATE_RATIO * company:
        job = None  # labor dollars with almost no hours, not a wage
    imputed = job or company or rates.get("portfolio")
    if imputed:
        return round(hours * imputed, 2), round(imputed, 4), TRAILING_JOB_RATE_BASIS
    return None, (float(rate) if rate is not None else None), "none"


def derive_overtime(conn: Any, source: str = SOURCE) -> None:
    """Split hours into regular/overtime for the API-sourced rows of the fact table (see module docstring).

    Reference rows carry the split the export reported (hours_type) and are never re-derived.
    """
    categories = _setting(conn, "overtime_category_detail_ids", [])
    category_ids = [int(c) for c in categories if str(c).strip().lstrip("-").isdigit()] if isinstance(categories, list) else []
    threshold = _setting(conn, "overtime_weekly_threshold_hours", 40)
    try:
        threshold_hours = float(threshold)
    except (TypeError, ValueError):
        threshold_hours = 40.0
    with conn.cursor() as cursor:
        if category_ids:
            cursor.execute(
                """
                UPDATE core.fact_timekeeping t SET
                  overtime_hours = c.ot,
                  regular_hours = greatest(coalesce(t.hours, 0), 0) - c.ot,
                  overtime_basis = 'category'
                FROM (
                  SELECT timekeeping_key,
                         CASE WHEN category_detail_id = ANY(%(categories)s::int[]) THEN greatest(coalesce(hours, 0), 0) ELSE 0 END AS ot
                  FROM core.fact_timekeeping
                  WHERE source = %(source)s
                ) c
                WHERE c.timekeeping_key = t.timekeeping_key AND t.source = %(source)s
                  AND (t.overtime_hours IS DISTINCT FROM c.ot
                       OR t.regular_hours IS DISTINCT FROM greatest(coalesce(t.hours, 0), 0) - c.ot
                       OR t.overtime_basis IS DISTINCT FROM 'category')
                """,
                {"categories": category_ids, "source": source},
            )
            return
        cursor.execute(
            """
            WITH ranked AS MATERIALIZED (
              SELECT timekeeping_key,
                     greatest(coalesce(hours, 0), 0) AS h,
                     sum(greatest(coalesce(hours, 0), 0)) OVER (
                       PARTITION BY employee_source_id, pay_week_start
                       ORDER BY work_date, in_time NULLS LAST, timekeeping_key
                       ROWS UNBOUNDED PRECEDING
                     ) AS cumulative
              FROM core.fact_timekeeping
              WHERE employee_source_id IS NOT NULL AND source = %(source)s
            ),
            split AS MATERIALIZED (
              SELECT timekeeping_key, h, greatest(0, least(h, cumulative - %(threshold)s::numeric)) AS ot FROM ranked
            )
            UPDATE core.fact_timekeeping t SET
              overtime_hours = s.ot,
              regular_hours = s.h - s.ot,
              overtime_basis = 'weekly_threshold'
            FROM split s
            WHERE s.timekeeping_key = t.timekeeping_key AND t.source = %(source)s
              AND (t.overtime_hours IS DISTINCT FROM s.ot
                   OR t.regular_hours IS DISTINCT FROM s.h - s.ot
                   OR t.overtime_basis IS DISTINCT FROM 'weekly_threshold')
            """,
            {"threshold": threshold_hours, "source": source},
        )
        cursor.execute(
            """
            UPDATE core.fact_timekeeping SET overtime_hours = 0, regular_hours = greatest(coalesce(hours, 0), 0), overtime_basis = 'none'
            WHERE employee_source_id IS NULL AND source = %(source)s
              AND (overtime_hours IS DISTINCT FROM 0 OR regular_hours IS DISTINCT FROM greatest(coalesce(hours, 0), 0) OR overtime_basis IS DISTINCT FROM 'none')
            """,
            {"source": source},
        )


# ── job schedules ────────────────────────────────────────────────────────────
def normalize_job_schedules(conn: Any, seen_ids: Collection[str] | None = None) -> int:
    params = {"resource": "job_schedules", "source": SOURCE}
    with conn.cursor() as cursor:
        stage_job_map(cursor)
        cursor.execute(
            f"""
            WITH src AS ({SOURCE_SQL}),
            parsed AS (
              SELECT
                {api_id()} AS winteam_id,
                {integer('scheduleDetailsID')} AS schedule_details_id,
                {integer('jobPostDetailID')} AS job_post_detail_id,
                {txt('jobNumber')} AS job_number,
                {txt('employeeNumber')} AS employee_source_id,
                {day('workDate')} AS work_date,
                {stamp('inTime')} AS in_time,
                {stamp('outTime')} AS out_time,
                {num('hours')} AS hours,
                {num('lunch')} AS lunch
              FROM src
            )
            INSERT INTO core.fact_schedule AS s (
              winteam_id, schedule_details_id, job_post_detail_id, job_key, job_number, employee_source_id,
              work_date, in_time, out_time, hours, lunch, source, warehouse_loaded_at
            )
            SELECT
              x.winteam_id, x.schedule_details_id, x.job_post_detail_id, {job_key_for('x.job_number')}, x.job_number,
              x.employee_source_id, x.work_date, x.in_time, x.out_time,
              CASE WHEN x.hours >= 0 THEN x.hours END, x.lunch, %(source)s, now()
            FROM parsed x
            WHERE x.work_date IS NOT NULL
            ON CONFLICT (winteam_id) DO UPDATE SET
              schedule_details_id = excluded.schedule_details_id,
              job_post_detail_id = excluded.job_post_detail_id,
              job_key = excluded.job_key,
              job_number = excluded.job_number,
              employee_source_id = excluded.employee_source_id,
              work_date = excluded.work_date,
              in_time = excluded.in_time,
              out_time = excluded.out_time,
              hours = excluded.hours,
              lunch = excluded.lunch,
              warehouse_loaded_at = now()
            WHERE s.source = %(source)s
            """,
            params,
        )
        return cursor.rowcount


# ── GL budgets ───────────────────────────────────────────────────────────────
def normalize_gl_budgets(conn: Any, seen_ids: Collection[str] | None = None) -> int:
    classes = _setting(conn, "gl_account_classes", {})
    classes = {k: v for k, v in classes.items() if k in GL_CLASSES} if isinstance(classes, dict) else {}
    start_month = _setting(conn, "fiscal_year_start_month", 1)
    try:
        start_month = min(12, max(1, int(start_month)))
    except (TypeError, ValueError):
        start_month = 1
    periods = ", ".join(f"coalesce({num(f'period{i}')}, 0)" for i in range(1, 13))
    params = {
        "resource": "gl_budgets", "source": SOURCE, "classes": json.dumps(classes), "class_names": list(GL_CLASSES),
        "start_month": start_month,
    }
    with conn.cursor() as cursor:
        stage_job_map(cursor)
        cursor.execute(
            f"""
            WITH src AS ({SOURCE_SQL}),
            parsed AS (
              SELECT
                {api_id()} AS winteam_id,
                {txt('jobNumber')} AS job_number,
                {integer('fiscalYear')} AS fiscal_year,
                {integer('glBudgetId')} AS gl_budget_id,
                {integer('id')} AS gl_budget_detail_id,
                {integer('glAccountNumber')} AS gl_account_number,
                {txt('glAccountDescription')} AS gl_account_description,
                {integer('financialStatement')} AS financial_statement,
                {integer('jobCostAnalysis')} AS job_cost_analysis,
                {num('budgetTotal')} AS budget_total,
                ARRAY[{periods}]::numeric(18, 2)[] AS period_amounts
              FROM src
            ),
            classified AS (
              SELECT x.*,
                coalesce((
                  SELECT c.key FROM jsonb_each(%(classes)s::jsonb) c
                  WHERE c.key = ANY(%(class_names)s::text[])
                    AND (
                      EXISTS (
                        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.value->'ranges') = 'array' THEN c.value->'ranges' ELSE '[]'::jsonb END) r
                        WHERE jsonb_typeof(r) = 'array' AND jsonb_array_length(r) >= 2
                          AND r->>0 ~ '^-?\\d+$' AND r->>1 ~ '^-?\\d+$'
                          AND x.gl_account_number BETWEEN (r->>0)::int AND (r->>1)::int
                      )
                      OR EXISTS (
                        SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.value->'keywords') = 'array' THEN c.value->'keywords' ELSE '[]'::jsonb END) k
                        WHERE k <> '' AND lower(coalesce(x.gl_account_description, '')) LIKE '%%' || lower(k) || '%%'
                      )
                    )
                  ORDER BY array_position(%(class_names)s::text[], c.key)
                  LIMIT 1
                ), 'other') AS account_class
              FROM parsed x
            )
            INSERT INTO core.fact_gl_budget AS b (
              winteam_id, job_key, job_number, fiscal_year, gl_budget_id, gl_budget_detail_id, gl_account_number,
              gl_account_description, financial_statement, job_cost_analysis, budget_total, period_amounts,
              account_class, source, warehouse_loaded_at
            )
            SELECT
              winteam_id, {job_key_for('job_number')}, job_number, fiscal_year, gl_budget_id, gl_budget_detail_id,
              gl_account_number, gl_account_description, financial_statement::smallint, job_cost_analysis::smallint,
              budget_total, period_amounts, account_class, %(source)s, now()
            FROM classified
            WHERE job_number IS NOT NULL AND fiscal_year IS NOT NULL
            ON CONFLICT (winteam_id) DO UPDATE SET
              job_key = excluded.job_key,
              job_number = excluded.job_number,
              fiscal_year = excluded.fiscal_year,
              gl_budget_id = excluded.gl_budget_id,
              gl_budget_detail_id = excluded.gl_budget_detail_id,
              gl_account_number = excluded.gl_account_number,
              gl_account_description = excluded.gl_account_description,
              financial_statement = excluded.financial_statement,
              job_cost_analysis = excluded.job_cost_analysis,
              budget_total = excluded.budget_total,
              period_amounts = excluded.period_amounts,
              account_class = excluded.account_class,
              warehouse_loaded_at = now()
            WHERE b.source = %(source)s
            """,
            params,
        )
        affected = cursor.rowcount
        cursor.execute(
            """
            INSERT INTO core.fact_gl_budget_month (gl_budget_key, period_no, budget_month, amount)
            SELECT b.gl_budget_key, n,
                   (make_date(b.fiscal_year, %(start_month)s, 1) + ((n - 1) * interval '1 month'))::date,
                   coalesce(b.period_amounts[n], 0)
            FROM core.fact_gl_budget b
            CROSS JOIN generate_series(1, 12) AS n
            WHERE b.source = %(source)s
            ON CONFLICT (gl_budget_key, period_no) DO UPDATE
              SET budget_month = excluded.budget_month, amount = excluded.amount
            """,
            params,
        )
    return affected


# ── accounts payable invoices ────────────────────────────────────────────────
def normalize_job_budgets(conn: Any, seen_ids: Collection[str] | None = None, tenant: Tenant = PRIMARY) -> int:
    """Job budget lines -> core.fact_job_budget (budgeted hours per day of week, plus the rate).

    The only source of budget hours and dollars for this tenant: gl-budgets returns nothing, and the
    export-fed daily budget stopped in July 2026. Resolved to a job_key through the shared
    wt_job_map so a collision number lands on the tenant's row, never the other namespace's.
    """
    params = {**_tenant_params(tenant, "job_budgets"), **_company_context(conn, tenant)}
    with conn.cursor() as cursor:
        stage_job_map(cursor, tenant)
        cursor.execute(
            f"""
            WITH src AS ({SOURCE_SQL}),
            parsed AS (
              SELECT
                {txt('jobNumber')} AS job_number,
                {integer('budgetId')} AS budget_id,
                {integer('lineIndex')} AS line_index,
                {day('effectiveDate')} AS effective_date,
                {day('endDate')} AS end_date,
                {txt('status')} AS status,
                {txt('description')} AS description,
                {integer('hoursType')} AS hours_type,
                {boolean('salaried')} AS salaried,
                {num('billRate')} AS bill_rate,
                {num('payRate')} AS pay_rate,
                {num('sun')} AS hours_sun, {num('mon')} AS hours_mon, {num('tue')} AS hours_tue,
                {num('wed')} AS hours_wed, {num('thu')} AS hours_thu, {num('fri')} AS hours_fri,
                {num('sat')} AS hours_sat, {num('hol')} AS hours_hol
              FROM src
            )
            INSERT INTO core.fact_job_budget AS b (
              source, job_number, job_key, budget_id, line_index, effective_date, end_date, status,
              description, hours_type, salaried, bill_rate, pay_rate,
              hours_sun, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, hours_sat, hours_hol
            )
            SELECT %(source)s, x.job_number, {job_key_for('x.job_number')}, x.budget_id, x.line_index,
                   x.effective_date, x.end_date, x.status, x.description, x.hours_type, x.salaried,
                   x.bill_rate, x.pay_rate, x.hours_sun, x.hours_mon, x.hours_tue, x.hours_wed,
                   x.hours_thu, x.hours_fri, x.hours_sat, x.hours_hol
            FROM parsed x
            WHERE x.job_number IS NOT NULL AND x.budget_id IS NOT NULL AND x.line_index IS NOT NULL
            ON CONFLICT (source, job_number, budget_id, line_index) DO UPDATE SET
              job_key = excluded.job_key, effective_date = excluded.effective_date,
              end_date = excluded.end_date, status = excluded.status,
              description = excluded.description, hours_type = excluded.hours_type,
              salaried = excluded.salaried, bill_rate = excluded.bill_rate, pay_rate = excluded.pay_rate,
              hours_sun = excluded.hours_sun, hours_mon = excluded.hours_mon, hours_tue = excluded.hours_tue,
              hours_wed = excluded.hours_wed, hours_thu = excluded.hours_thu, hours_fri = excluded.hours_fri,
              hours_sat = excluded.hours_sat, hours_hol = excluded.hours_hol,
              warehouse_updated_at = now()
            """,
            params,
        )
        return int(cursor.rowcount or 0)


def normalize_ap_invoice_details(conn: Any, seen_ids: Collection[str] | None = None, tenant: Tenant = PRIMARY) -> int:
    """GL distribution lines -> core.fact_ap_distribution.

    This is the only path by which a payable reaches a site. job_number is resolved to a job_key
    through the same wt_job_map the other API facts use, so a collision number lands on the tenant's
    row rather than the other namespace's; a line coding a job we have never seen keeps its
    job_number and a null job_key rather than being dropped, because the cost is real either way.
    """
    params = {**_tenant_params(tenant, "ap_invoice_details"), **_company_context(conn, tenant)}
    with conn.cursor() as cursor:
        stage_job_map(cursor, tenant)
        cursor.execute(
            f"""
            WITH src AS ({SOURCE_SQL}),
            parsed AS (
              SELECT
                {txt('invoiceNumber')} AS invoice_number,
                {integer('lineIndex')} AS line_index,
                {txt('companyNumber')} AS company_number,
                {integer('vendorNumber')} + %(vendor_offset)s AS vendor_number,
                {txt('accountNumber')} AS gl_account_number,
                {txt('jobNumber')} AS job_number,
                {num('amount')} AS amount,
                {txt('ticketNumber')} AS ticket_number,
                {txt('notes')} AS notes,
                {day('invoiceDate')} AS invoice_date,
                {day('postingDate')} AS posting_date,
                {num('invoiceAmount')} AS invoice_amount
              FROM src
            )
            INSERT INTO core.fact_ap_distribution AS d (
              source, company_number, vendor_number, invoice_number, line_index, gl_account_number,
              job_number, job_key, amount, ticket_number, notes, invoice_date, posting_date, invoice_amount
            )
            SELECT %(source)s, x.company_number, x.vendor_number, x.invoice_number, x.line_index,
                   x.gl_account_number, x.job_number, {job_key_for('x.job_number')}, x.amount,
                   x.ticket_number, x.notes, x.invoice_date, x.posting_date, x.invoice_amount
            FROM parsed x
            WHERE x.invoice_number IS NOT NULL AND x.line_index IS NOT NULL
            ON CONFLICT (source, invoice_number, line_index) DO UPDATE SET
              company_number = excluded.company_number,
              vendor_number = excluded.vendor_number,
              gl_account_number = excluded.gl_account_number,
              job_number = excluded.job_number,
              job_key = excluded.job_key,
              amount = excluded.amount,
              ticket_number = excluded.ticket_number,
              notes = excluded.notes,
              invoice_date = excluded.invoice_date,
              posting_date = excluded.posting_date,
              invoice_amount = excluded.invoice_amount,
              warehouse_updated_at = now()
            """,
            params,
        )
        return int(cursor.rowcount or 0)


def normalize_ap_invoices(conn: Any, seen_ids: Collection[str] | None = None, tenant: Tenant = PRIMARY) -> int:
    params = {**_tenant_params(tenant, "ap_invoices"), **_company_context(conn, tenant)}
    label = f"coalesce(%(tenant_company)s::text, {company_label_sql()})"
    row_namespace = namespace_sql(f"coalesce({label}, %(tenant_namespace)s)")
    with conn.cursor() as cursor:
        cursor.execute(
            f"""
            WITH src AS ({SOURCE_SQL}),
            parsed AS (
              SELECT
                {api_id(tenant=tenant)} AS winteam_id,
                {integer('vendorNumber')} + CASE WHEN {row_namespace} = '{rules.NAMESPACE_SARUS}' THEN %(sarus_offset)s ELSE 0 END AS vendor_number,
                {integer('companyNumber')} AS company_number,
                {label} AS company,
                {txt('invoiceNumber')} AS invoice_number,
                {day('invoiceDate')} AS invoice_date,
                {day('postingDate')} AS posting_date,
                {day('dueDate')} AS due_date,
                {num('invoiceAmount')} AS invoice_amount,
                {txt('poNumber')} AS po_number,
                {txt('notes')} AS notes,
                {boolean('payUseTax')} AS pay_use_tax,
                {num('useTaxAmount')} AS use_tax_amount,
                {txt('useTaxCode')} AS use_tax_code,
                {integer('paymentPlanId')} AS payment_plan_id,
                {integer('paymentMethodId')} AS payment_method_id,
                {integer('creditCardVendorNumber')} AS credit_card_vendor_number,
                {txt('memoLine1')} AS memo_line_1,
                {txt('memoLine2')} AS memo_line_2,
                {boolean('permanentHold')} AS permanent_hold,
                {boolean('includeOn1099')} AS include_on_1099
              FROM src
            )
            INSERT INTO core.fact_ap_invoice AS i (
              winteam_id, vendor_key, vendor_number, company_number, invoice_number, invoice_date, posting_date, due_date,
              invoice_amount, po_number, notes, pay_use_tax, use_tax_amount, use_tax_code, payment_plan_id,
              payment_method_id, credit_card_vendor_number, memo_line_1, memo_line_2, permanent_hold, include_on_1099,
              source, company, vendor_name, warehouse_loaded_at
            )
            SELECT
              x.winteam_id, {vendor_key_for('x.vendor_number')}, x.vendor_number, x.company_number, x.invoice_number,
              x.invoice_date, x.posting_date, x.due_date, x.invoice_amount, x.po_number, x.notes, x.pay_use_tax,
              x.use_tax_amount, x.use_tax_code, x.payment_plan_id, x.payment_method_id, x.credit_card_vendor_number,
              x.memo_line_1, x.memo_line_2, x.permanent_hold, x.include_on_1099,
              %(source)s, x.company,
              (SELECT v.vendor_name FROM core.dim_vendor v WHERE v.vendor_number = x.vendor_number LIMIT 1), now()
            FROM parsed x
            WHERE x.invoice_number IS NOT NULL
            ON CONFLICT (winteam_id) DO UPDATE SET
              vendor_key = excluded.vendor_key,
              vendor_number = excluded.vendor_number,
              company_number = excluded.company_number,
              invoice_number = excluded.invoice_number,
              invoice_date = excluded.invoice_date,
              posting_date = excluded.posting_date,
              due_date = excluded.due_date,
              invoice_amount = excluded.invoice_amount,
              po_number = excluded.po_number,
              notes = excluded.notes,
              pay_use_tax = excluded.pay_use_tax,
              use_tax_amount = excluded.use_tax_amount,
              use_tax_code = excluded.use_tax_code,
              payment_plan_id = excluded.payment_plan_id,
              payment_method_id = excluded.payment_method_id,
              credit_card_vendor_number = excluded.credit_card_vendor_number,
              memo_line_1 = excluded.memo_line_1,
              memo_line_2 = excluded.memo_line_2,
              permanent_hold = excluded.permanent_hold,
              include_on_1099 = excluded.include_on_1099,
              company = coalesce(excluded.company, i.company),
              vendor_name = coalesce(excluded.vendor_name, i.vendor_name),
              warehouse_loaded_at = now()
            WHERE i.source = %(source)s
            """,
            params,
        )
        return cursor.rowcount


# ── accounts receivable invoices ─────────────────────────────────────────────
def normalize_ar_invoices(conn: Any, seen_ids: Collection[str] | None = None, tenant: Tenant = PRIMARY) -> int:
    names = _setting(conn, "customer_names", {})
    treatment = _setting(conn, "ar_treatment_rules", [])
    params = {
        **_tenant_params(tenant, "ar_invoices"),
        "names": json.dumps(names if isinstance(names, dict) else {}),
        "treatment_rules": json.dumps([r for r in treatment if isinstance(r, dict)] if isinstance(treatment, list) else []),
    }
    with conn.cursor() as cursor:
        stage_job_map(cursor, tenant)
        # Customers discovered by the receivables sync; existing rows keep their name and company.
        cursor.execute(
            f"""
            WITH src AS ({SOURCE_SQL})
            INSERT INTO core.dim_customer AS c (customer_number, customer_name, source)
            SELECT DISTINCT n, (%(names)s::jsonb)->>n, %(source)s
            FROM (SELECT {txt('customerNumber')} AS n FROM src) x
            WHERE n IS NOT NULL
            ON CONFLICT (customer_number) DO UPDATE
              SET customer_name = coalesce(excluded.customer_name, c.customer_name),
                  warehouse_updated_at = now()
            """,
            params,
        )
        cursor.execute(
            """
            UPDATE core.dim_customer c SET customer_name = (%(names)s::jsonb)->>c.customer_number, warehouse_updated_at = now()
            WHERE (%(names)s::jsonb) ? c.customer_number AND c.customer_name IS DISTINCT FROM (%(names)s::jsonb)->>c.customer_number
            """,
            params,
        )
        cursor.execute(
            f"""
            WITH src AS ({SOURCE_SQL}),
            parsed AS (
              SELECT
                {api_id(tenant=tenant)} AS winteam_id,
                {txt('customerNumber')} AS customer_number,
                {txt('invoiceNumber')} AS invoice_number,
                {txt('jobNumber')} AS job_number,
                {day('invoiceDate')} AS invoice_date,
                {day('postingDate')} AS posting_date,
                {day('billingPeriodFrom')} AS billing_period_from,
                {day('billingPeriodTo')} AS billing_period_to,
                {txt('terms')} AS terms,
                {integer('termsId')} AS terms_id,
                {txt('salesRep')} AS sales_rep,
                {integer('salesRepId')} AS sales_rep_id,
                {txt('poNumber')} AS po_number,
                {txt('reason')} AS reason,
                {integer('reasonId')} AS reason_id,
                {txt('notes')} AS notes,
                {num('tax')} AS tax,
                {num('amountPaid')} AS amount_paid,
                {num('revenueTotal')} AS revenue_total,
                {num('invoiceTotal')} AS invoice_total,
                {day('lastDatePaid')} AS last_date_paid,
                {txt('collectionStatus')} AS collection_status,
                {txt('invoiceBeingCredited')} AS invoice_being_credited
              FROM src
            ),
            enriched AS (
              SELECT x.*,
                     c.customer_key, c.customer_name, c.company AS customer_company,
                     {job_key_for('x.job_number')} AS job_key,
                     {job_company_for('x.job_number')} AS job_company
              FROM parsed x
              LEFT JOIN core.dim_customer c ON c.customer_number = x.customer_number
            )
            INSERT INTO core.fact_ar_invoice AS i (
              winteam_id, customer_key, customer_number, invoice_number, job_key, job_number, invoice_date, posting_date,
              billing_period_from, billing_period_to, service_month, terms, terms_id, sales_rep, sales_rep_id, po_number,
              reason, reason_id, notes, tax, amount_paid, revenue_total, invoice_total, last_date_paid, collection_status,
              invoice_being_credited, source, company, customer_name, is_collectible, open_balance_basis, warehouse_loaded_at
            )
            SELECT
              x.winteam_id, x.customer_key, x.customer_number, x.invoice_number, x.job_key, x.job_number, x.invoice_date, x.posting_date,
              x.billing_period_from, x.billing_period_to,
              date_trunc('month', coalesce(x.billing_period_from, x.invoice_date))::date,
              x.terms, x.terms_id, x.sales_rep, x.sales_rep_id, x.po_number, x.reason, x.reason_id, x.notes, x.tax,
              x.amount_paid, x.revenue_total, x.invoice_total, x.last_date_paid, x.collection_status,
              x.invoice_being_credited, %(source)s, coalesce(%(tenant_company)s::text, x.job_company, x.customer_company), x.customer_name,
              NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(%(treatment_rules)s::jsonb) r
                WHERE NOT coalesce((r->>'include_collectible_ar')::boolean, false)
                  AND nullif(r->>'match', '') IS NOT NULL
                  AND x.customer_name IS NOT NULL AND x.customer_name ~* (r->>'match')
              ),
              'api_amount_paid', now()
            FROM enriched x
            WHERE x.customer_number IS NOT NULL AND x.invoice_number IS NOT NULL
            ON CONFLICT (winteam_id) DO UPDATE SET
              customer_key = excluded.customer_key,
              customer_number = excluded.customer_number,
              invoice_number = excluded.invoice_number,
              job_key = excluded.job_key,
              job_number = excluded.job_number,
              invoice_date = excluded.invoice_date,
              posting_date = excluded.posting_date,
              billing_period_from = excluded.billing_period_from,
              billing_period_to = excluded.billing_period_to,
              service_month = excluded.service_month,
              terms = excluded.terms,
              terms_id = excluded.terms_id,
              sales_rep = excluded.sales_rep,
              sales_rep_id = excluded.sales_rep_id,
              po_number = excluded.po_number,
              reason = excluded.reason,
              reason_id = excluded.reason_id,
              notes = excluded.notes,
              tax = excluded.tax,
              amount_paid = excluded.amount_paid,
              revenue_total = excluded.revenue_total,
              invoice_total = excluded.invoice_total,
              last_date_paid = excluded.last_date_paid,
              collection_status = excluded.collection_status,
              invoice_being_credited = excluded.invoice_being_credited,
              company = coalesce(excluded.company, i.company),
              customer_name = coalesce(excluded.customer_name, i.customer_name),
              is_collectible = excluded.is_collectible,
              open_balance_basis = 'api_amount_paid',
              warehouse_loaded_at = now()
            WHERE i.source = %(source)s
            """,
            params,
        )
        affected = cursor.rowcount
        # Customers without a parent account inherit the most common one among the jobs the API billed them for.
        cursor.execute(
            """
            UPDATE core.dim_customer c SET parent_account_key = s.parent_account_key, warehouse_updated_at = now()
            FROM (
              SELECT i.customer_number, mode() WITHIN GROUP (ORDER BY j.parent_account_key) AS parent_account_key
              FROM core.fact_ar_invoice i
              JOIN core.dim_job j ON j.job_key = i.job_key
              WHERE j.parent_account_key IS NOT NULL AND i.source = %(source)s
              GROUP BY i.customer_number
            ) s
            WHERE s.customer_number = c.customer_number AND c.parent_account_key IS NULL
            """,
            params,
        )
    return affected


# ── accounts payable payments ────────────────────────────────────────────────
def normalize_ap_payments(conn: Any, seen_ids: Collection[str] | None = None) -> int:
    params = {"resource": "ap_payments", "source": SOURCE, **_company_context(conn)}
    row_namespace = namespace_sql(f"coalesce({company_label_sql()}, %(tenant_namespace)s)")
    with conn.cursor() as cursor:
        cursor.execute(
            f"""
            WITH src AS ({SOURCE_SQL}),
            parsed AS (
              SELECT
                {api_id()} AS winteam_id,
                {integer('paymentMethodId')} AS payment_method_id,
                {txt('paymentMethodDescription')} AS payment_method,
                {txt('checkNumber')} AS check_number,
                {day('checkDate')} AS check_date,
                {day('paymentDateAdded')} AS payment_date_added,
                {num('amount')} AS amount,
                {integer('companyNumber')} AS company_number,
                {txt('companyName')} AS company_name,
                {integer('glCashAccount')} AS gl_cash_account,
                {integer('payeeTypeId')} AS payee_type_id,
                {txt('payeeTypeDescription')} AS payee_type,
                {integer('vendorNumber')} + CASE WHEN {row_namespace} = '{rules.NAMESPACE_SARUS}' THEN %(sarus_offset)s ELSE 0 END AS vendor_number,
                {txt('vendorName')} AS vendor_name,
                {txt('otherVendorId')} AS other_vendor_id,
                {txt('otherVendorName')} AS other_vendor_name,
                {boolean('applyToExpenses')} AS apply_to_expenses,
                {boolean('isSystemGenerated')} AS is_system_generated,
                {txt('externalSystemId')} AS external_system_id
              FROM src
            )
            INSERT INTO core.fact_ap_payment AS pmt (
              winteam_id, payment_method_id, payment_method, check_number, check_date, payment_date_added, payment_date,
              amount, company_number, company_name, gl_cash_account, payee_type_id, payee_type, vendor_key, vendor_number,
              vendor_name, other_vendor_id, other_vendor_name, apply_to_expenses, is_system_generated, external_system_id,
              source, warehouse_loaded_at
            )
            SELECT
              x.winteam_id, x.payment_method_id, x.payment_method, x.check_number, x.check_date, x.payment_date_added,
              coalesce(x.check_date, x.payment_date_added), x.amount, x.company_number, x.company_name, x.gl_cash_account,
              x.payee_type_id, x.payee_type, {vendor_key_for('x.vendor_number')}, x.vendor_number, x.vendor_name,
              x.other_vendor_id, x.other_vendor_name, x.apply_to_expenses, x.is_system_generated, x.external_system_id,
              %(source)s, now()
            FROM parsed x
            ON CONFLICT (winteam_id) DO UPDATE SET
              payment_method_id = excluded.payment_method_id,
              payment_method = excluded.payment_method,
              check_number = excluded.check_number,
              check_date = excluded.check_date,
              payment_date_added = excluded.payment_date_added,
              payment_date = excluded.payment_date,
              amount = excluded.amount,
              company_number = excluded.company_number,
              company_name = excluded.company_name,
              gl_cash_account = excluded.gl_cash_account,
              payee_type_id = excluded.payee_type_id,
              payee_type = excluded.payee_type,
              vendor_key = excluded.vendor_key,
              vendor_number = excluded.vendor_number,
              vendor_name = excluded.vendor_name,
              other_vendor_id = excluded.other_vendor_id,
              other_vendor_name = excluded.other_vendor_name,
              apply_to_expenses = excluded.apply_to_expenses,
              is_system_generated = excluded.is_system_generated,
              external_system_id = excluded.external_system_id,
              warehouse_loaded_at = now()
            WHERE pmt.source = %(source)s
            """,
            params,
        )
        return cursor.rowcount


NORMALIZERS = {
    "jobs": normalize_jobs,
    "vendors": normalize_vendors,
    "timekeeping": normalize_timekeeping,
    "job_schedules": normalize_job_schedules,
    "gl_budgets": normalize_gl_budgets,
    "job_budgets": normalize_job_budgets,
    "ap_invoices": normalize_ap_invoices,
    "ap_invoice_details": normalize_ap_invoice_details,
    "ar_invoices": normalize_ar_invoices,
    "ap_payments": normalize_ap_payments,
}
assert tuple(NORMALIZERS) == RESOURCE_NAMES

# What each tenant promotes into core. The Sarus database lands its jobs raw only: the export owns
# the Sarus job dimension, and its facts resolve through mart.v_sarus_job_map.
TENANT_NORMALIZED = {
    PRIMARY.key: RESOURCE_NAMES,
    SARUS.key: tuple(name for name in SARUS_RESOURCE_NAMES if name != "jobs"),
}


def normalizes(name: str, tenant: Tenant = PRIMARY) -> bool:
    return name in TENANT_NORMALIZED[tenant.key]


def normalize_resource(name: str, seen_ids: Collection[str] | None = None, tenant: Tenant = PRIMARY) -> int:
    """Promote one resource inside a single transaction; returns rows upserted into its core table."""
    normalizer = NORMALIZERS.get(name)
    if normalizer is None:
        raise KeyError(name)
    if not normalizes(name, tenant):
        raise ValueError(f"{name} is not promoted for the {tenant.key} tenant")
    with connection() as conn:
        _begin(conn)
        affected = normalizer(conn, seen_ids) if tenant is PRIMARY else normalizer(conn, seen_ids, tenant=tenant)
        conn.commit()
    logger.info("Normalized %s%s: %s rows", tenant.resource_prefix, name, affected)
    return affected


def normalize_all() -> dict[str, int]:
    return {name: normalize_resource(name) for name in RESOURCE_NAMES}


def apply_account_groups(conn: Any | None = None) -> dict[str, int]:
    """Assign configured account groups to current jobs that are not yet in one.

    Uses the same rule as the export loader (`rules.match_account_group`: any `terms` entry in the
    job name, the job number in `job_numbers`, any `customer_terms` entry in the job's customer
    name; first group in configured order wins). Jobs whose parent account is already one of the
    configured groups are left alone, so loader overrides are never undone; jobs grouped under
    their own name or "Other" (typically jobs first seen through the live API) are regrouped.
    Idempotent; safe to run after every jobs normalization.

    Pass `conn` to run inside a transaction that is already writing core.dim_job (normalize_jobs);
    a fresh connection would wait on that transaction's row locks forever. Called with no
    connection it opens and commits its own.
    """
    if conn is None:
        with connection() as own:
            result = _apply_account_groups(own)
            own.commit()
        return result
    return _apply_account_groups(conn)


def _apply_account_groups(conn: Any) -> dict[str, int]:
    groups = [g for g in (_setting(conn, "account_groups", []) or []) if isinstance(g, dict) and g.get("name")]
    # Only groups WITH rules protect an existing assignment; the rule-less catch-all ("Other") does not.
    group_names = {str(g["name"]).strip() for g in groups
                   if (g.get("terms") or g.get("job_numbers") or g.get("customer_terms"))}
    if not groups:
        return {"jobs_regrouped": 0, "groups": 0}
    regrouped = 0
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT j.job_key, j.job_number, j.job_name, j.customer_name, a.account_name AS parent_account
            FROM core.dim_job j
            LEFT JOIN core.dim_parent_account a ON a.parent_account_key = j.parent_account_key
            WHERE j.valid_to IS NULL
            """
        )
        jobs = cursor.fetchall()
        for job in jobs:
            if (job["parent_account"] or "") in group_names:
                continue
            group = rules.match_account_group(
                job_number=str(job["job_number"]), job_name=job["job_name"],
                customer_names=[job["customer_name"]], groups=groups,
            )
            if not group:
                continue
            cursor.execute(
                """
                INSERT INTO core.dim_parent_account (winteam_id, account_name, active)
                VALUES (%(name)s, %(name)s, true)
                ON CONFLICT (winteam_id) DO UPDATE SET active = true, warehouse_updated_at = now()
                """,
                {"name": group},
            )
            cursor.execute(
                """
                UPDATE core.dim_job SET parent_account_key = (
                  SELECT parent_account_key FROM core.dim_parent_account WHERE account_name = %(name)s ORDER BY parent_account_key LIMIT 1
                ), account_group = %(name)s, warehouse_updated_at = now()
                WHERE job_key = %(job_key)s
                """,
                {"name": group, "job_key": job["job_key"]},
            )
            regrouped += int(cursor.rowcount or 0)
    logger.info("Account groups applied: %s job(s) regrouped", regrouped)
    return {"jobs_regrouped": regrouped, "groups": len(groups)}
