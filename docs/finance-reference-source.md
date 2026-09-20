# Finance reference source (real WinTeam report exports)

Last verified: 2026-09-02 against the local restored dump.

The dashboard has two server-side sources that fill the same warehouse (`core`, `mart`):

| Source | What it is | Loader | `source.primary_source` |
|---|---|---|---|
| `winteam_api` | the documented WinTeam / TEAM Concourse GET endpoints (or the simulator) | `services/api/app/winteam.py` + `normalize.py` | `winteam_api` |
| `finance_reference` | the real WinTeam **report exports** restored from the Finance_Dashboard PostgreSQL dump into a read-only database `finance_reference` | `services/api/app/sources/finance_reference.py` | `finance_reference` |

They coexist: every fact/dim row carries `source`, a reference load first clears only the previous
reference load (`reset_warehouse`, see "Reset behaviour"), and the marts read the
`mart.v_*_effective` views that arbitrate between the two (docs/winteam-live-source.md
"Precedence"). The browser reads `source.primary_source` on every payload to know which one last
filled the marts.

## Configuration

| Variable | Meaning |
|---|---|
| `FINANCE_REFERENCE_DATABASE_URL` | `postgresql://...` URL of the read-only reference database. Empty = source not configured (`GET /integrations/finance-reference` says `configured: false`). Local default (compose.yaml): `postgresql://facilities_app:facilities_dev@postgres:5432/finance_reference` - the dump restored inside the same Postgres container; the app role has SELECT on schemas `core`, `mart`, `raw`, `app`. |
| `FINANCE_REFERENCE_DATA_DIR` | Optional directory holding `Crane_job_master_report.csv` and `city_centroids.json`. Default: `services/api/app/sources/data/`, which carries copies of `sources/winteam_exports/Crane_job_master_report.csv` and `sources/geo/city_centroids.json` (the API image does not contain the repository's `sources/` tree). Refresh the copies when those files change. |

The connection is opened read-only (`db.reference_connection`), so the loader can never write to
the dump.

## Operating it

```bash
# status: configured?, reference date ranges, last load and its per-table runs
curl http://127.0.0.1:15173/api/v1/integrations/finance-reference
# full replace of the warehouse from the reference database (about 25 s locally; nginx allows 900 s)
curl -X POST -H "X-Admin-Token: $INGESTION_ADMIN_TOKEN" http://127.0.0.1:15173/api/v1/integrations/finance-reference/load
```

`load` runs these steps in order, each in its own transaction and its own
`ops.integration_sync_run` row (`integration_name = 'finance_reference'`; the whole load also gets a
parent row with `resource_name = 'load'` whose id is the returned `run_id`):

1. **reset** - deletes the previous reference load only (see "Reset behaviour" below): fact rows
   `WHERE source = 'finance_reference'`, reference-only dimension rows, and empties the derived
   marts (`mart.job_month`, `mart.portfolio_month`, `mart.job_week`, `mart.forecast_run_meta` which
   cascades to every forecast table). Never touched: `raw.winteam_record`, `ops.source_watermark`,
   `ops.app_setting`, `ops.integration_sync_run`, `mart.rebuild_log` and any row with
   `source = 'winteam_api'`. The rows cleared per table are returned in `notes.cleared` (`-1` for a
   mart table = emptied, rebuilt at the end).
2. **settings** - `account_groups` and `ar_treatment_rules` are upserted from
   `app.platform_config.config_json`; `job_tier_map` is set to the real tenant layout
   `{"branch": 1, "region": 3, "service_type": 4, "manager": 7, "vertical": 6}` (what the Crane job
   master shows); `company_aliases` is left as seeded/edited.
3. **stage** - the reference tables are copied (`COPY`) into TEMP tables on the loader's connection;
   rows from `superseded` import batches are excluded, rows without a batch are kept. The job master
   CSV and the centroid file are read from the data directory.
4. **dim_job** - see below.
5. **fact_job_cost_month** <- `mart.job_profitability_monthly`.
6. **fact_labor_budget_month** <- daily budget / hours budget comparison / wage by job.
7. **fact_timekeeping** <- `core.fact_timekeeping_detail_line`, then labor cost by trailing rate.
8. **fact_ar_invoice**, `fact_ar_aging_snapshot`, `dim_customer` <- AR register + AR aging snapshots.
9. **fact_ap_invoice**, `fact_ap_aging_snapshot`, `fact_ap_payment`, `dim_vendor` <- AP exports.
10. **marts** - `marts.rebuild_all()` (job_month, portfolio_month, forecast engine v2), then
    `ops.app_setting.primary_source = 'finance_reference'`.

If a step fails the load stops, its run row carries the error, `primary_source` is not changed and
the marts stay empty (the reset already happened): fix the cause and run the load again - every
load is a full replace of this source, there is no watermark to reset.

### Reset behaviour (changed 2026-09-03 for the live API source)

`reset_warehouse` used to `TRUNCATE` the raw landings, the watermarks and every core table. Since
the live WinTeam API shares the warehouse (`docs/winteam-live-source.md`) it is scoped to this
source:

| Table group | Rule |
|---|---|
| fact tables (`fact_timekeeping`, `fact_schedule`, `fact_gl_budget` (+ `_month` by cascade), `fact_ar_invoice`, `fact_ap_invoice`, `fact_ap_payment`, `fact_job_cost_month`, `fact_labor_budget_month`, `fact_daily_budget`, `contract_billing`, `fact_ar_aging_snapshot`, `fact_ap_aging_snapshot`) | `DELETE ... WHERE source = 'finance_reference'` |
| `dim_job` | reference-only rows (`source = 'finance_reference'`, i.e. `winteam_id = job_number`) are deleted, `job_tier` cascades. A row the API has taken over (`source = 'winteam_api'`: jobId GUID, exact coordinates, live tiers) is **kept**; the loader's `dim_job` insert is now an upsert on the current `job_number` that fills only what the API did not supply (coalesce on name / tiers / address, coordinates only when `geo_precision <> 'exact'`) and always refreshes the reference-only columns (`delivery_model`, `account_group`, `customer_number` / `customer_name`, `date_discontinued`, `company_name_raw`). `source`, `is_active` and `status` of such a row stay the API's. |
| `dim_customer`, `dim_vendor` | reference-sourced rows deleted; API-sourced rows kept (`dim_customer` insert was already an upsert, `dim_vendor`'s is now `ON CONFLICT (vendor_number) DO NOTHING`) |
| `dim_parent_account` (no `source` column) | accounts no `dim_job` / `dim_customer` row points at any more are deleted; the loader's insert is now `ON CONFLICT (winteam_id) DO UPDATE` |
| API fact rows whose `job_key` / `customer_key` / `vendor_key` point at a reference-only dimension row | the pointer is set to NULL before the dimension row goes (the marts join on the natural keys; the next API jobs / vendors normalization re-points them) |
| `mart.job_month`, `mart.portfolio_month`, `mart.job_week`, `mart.forecast_run_meta` | `TRUNCATE ... CASCADE` (derived; `marts.rebuild_all` refills them at the end of the load) |
| `raw.winteam_record`, `ops.source_watermark`, `ops.app_setting`, `ops.integration_sync_run`, `mart.rebuild_log` | never touched |

`core.fact_invoice` (001, no `source` column, filled by neither loader) is left alone.

## Reloading after a new dump is restored

1. Restore the new dump into the `finance_reference` database (or point
   `FINANCE_REFERENCE_DATABASE_URL` at wherever it lives) and make sure the app role has SELECT on
   `core`, `mart`, `raw`, `app`.
2. If the job master export or the centroid file changed, refresh the copies in
   `services/api/app/sources/data/` (or set `FINANCE_REFERENCE_DATA_DIR`) and rebuild the API image.
3. `POST /integrations/finance-reference/load`; check `GET /integrations/finance-reference` (every
   table row `succeeded`) and the reconciliation queries below.

## What is loaded from where, and every derivation

Identities are namespaced by WinTeam database (`Crane` = the three Crane opcos, `Sarus`), because job,
invoice, customer and vendor numbers repeat across the two databases. The namespace comes from the
row's `company_name` when present, else the import batch's `company_name`.

Company labels: raw names -> `ops.app_setting.company_aliases` (seeded by migration 005) with built-in
defaults for the batch-level names (`Crane` -> Crane IFS, `Sarus` -> Sarus). Unknown names pass
through unchanged.

### core.dim_parent_account / core.dim_job / core.job_tier

| Column | Rule |
|---|---|
| jobs | union of reference `core.dim_job` (684), `core.fact_job_file_line` (681 numbers), the Crane job master CSV (429), and any job number seen in job cost / timekeeping / AR. One row per job number (the `winteam_id` is the job number). |
| `company_name_raw`, `company` | reference dim_job attributes -> job file -> job master -> the most frequent timekeeping company; aliased to the label. 3 jobs (731, 1001, 1002) have no company anywhere. |
| job master attributes | applied only to jobs in the Crane namespace: `branch_name` = Tier 1 (city), `region_name` = Tier 3 (else a state -> region fallback: Northeast / Midwest / Southeast / Southwest / West / Canada), `service_type` = Tier 4, `manager_name` = Tier 7, address / city / state / postal code, `country_code` (CA for provinces), `date_to_start`, `date_discontinued`, `is_active` = Active and not discontinued on or before today, `parent_job_number`, `type_id`; `job_tier` rows for tiers 1-7; the job type description is kept in `custom_fields`. |
| `latitude` / `longitude` | from `city_centroids.json` keyed `City|ST`, `geo_precision = 'city_center'` (approximate map placement only, never invented; null otherwise). |
| `delivery_model` | `app.job_account_overrides.is_self_perform_override` when set, else reference `dim_job.is_self_perform` (CFO-curated): `self_perform` / `subcontracted`, null when unknown. |
| `account_group` / parent account | `account_groups` rules in configured order: any `terms` entry in the job name, the job number in `job_numbers`, or any `customer_terms` entry in one of the job's AR customer / parent customer names (case-insensitive contains); `job_account_overrides.assigned_account_group` wins; the rule-less "Other" group never matches. Jobs without a group get the parent account named after `assigned_client_name`, else the most frequent AR parent customer name, else customer name, else `Other`. Parent-account `winteam_id`s are `fr:group:<name>` / `fr:customer:<name>`; the account vertical is the mode of its jobs. |
| `vertical` | first `platform_config.verticals` regex (`match`) hitting the job name or an AR customer name, else the service type. |
| `customer_number` / `customer_name` | the job's most frequent AR customer (register + aging, namespace-aware). |

### core.fact_job_cost_month (revenue and cost basis for closed months)

Straight copy of `mart.job_profitability_monthly` (period_id -> first of month): revenue, direct_labor,
payroll_taxes_insurance, materials, subcontractors, equipment_supplies, other_direct_costs,
total_direct_costs, gross_profit (= revenue - total_direct_costs, the finance-approved definition),
actual_hours, overtime_hours, confidence_score, exception_count, `data_quality_status`
(`passed` / `warning`, kept exactly as the reference marts report it), lineage. Budget columns are
stored as NULL when the export carries 0 (a zero budget means "no budget"). `budget_labor` is linked
from `fact_labor_budget_month`. `company` comes from `dim_job`.

### core.fact_labor_budget_month (basis column says which)

1. `daily_budget`: `core.fact_daily_budget` summed by job and month (2025-12 .. 2026-07, Crane only).
2. `hours_budget_comparison`: `core.fact_hours_budget_comparison_line` per (namespace, job, period).
   Rule verified on the dump: the job's monthly `bud_labor_dollars` is carried on ONE employee row per
   job (the others carry 0), never repeated per employee, so the job budget is the **max** over the
   rows. On 2026-01..07, sum == max for all 525 job-months that also have a daily budget and 376 match
   the daily budget to the dollar. Budget hours = max(`total_daily_budgeted_hours`), also verified
   against the daily budget. Groups that break the rule (two distinct non-zero values: `Sarus:300:202605`,
   `Sarus:301:202605`) are listed in `notes.labor_budget.hbc_inconsistent_groups`. Job numbers shared
   by both databases add up. HBC rows before 2026-05 have no job number and carry no budget.
3. `wage_by_job`: `total_budget_labor_dollars` per (namespace, job, period), one row carries the value
   (verified); non-zero only through 2025-12.

### core.fact_timekeeping

One row per `core.fact_timekeeping_detail_line` (271,462). `winteam_id` = `tk:<tk_hours_id>` when the
export carries it (rows from 2026-05 on), else `row:<reference row id>`. `hours` =
`total_hours` else `hours` (older exports only have `hours`), signed (4,931 negative adjustment rows,
-37k hours, are kept so corrections net out); `regular_hours` = `regular_hours` else hours - overtime
- double time; overtime / double time from the export (`overtime_basis = 'category'`), components
clipped at 0 for negative rows. `hours_type` = `hours_type_description` (PTO, holiday, training rows
are kept and labelled), `category_detail_id` = `hours_type_id`, in/out = work date + `HH:MM` (out
before in -> next day; unparseable -> null), lunch, `pay_week_start` = Sunday of the work date,
`company` = aliased row company.

**labor_cost = hours x trailing job rate** (`labor_cost_basis = 'trailing_job_rate'`, `rate` column =
the rate used): rate = sum(direct_labor) / sum(actual_hours) over the job's last 3 **closed**
job-cost months with hours > 0 and labor > 0 (closed = month end + `close_lag_days` before today);
else the company's pooled rate over its last 3 closed months; else the portfolio rate. The load
returns the company rates (`notes.trailing_rate`: Crane IFS 18.14, Crane Southwest 16.27, Crane West
20.49, Sarus 15.18 $/h; portfolio 18.21) and how many rows each fallback priced (271,460 by job
rate, 2 by company rate). The export's own `dollars` columns are NOT used (see caveats).

### core.fact_ar_invoice / core.dim_customer

One row per (namespace, invoice number), `winteam_id = ar:<ns>:<invoice>`. The register export
repeats an invoice once per distribution line (header line = totals, detail lines = `dist_amount`
with totals 0) and the same invoice can appear in two export batches, so `invoice_total`,
`revenue_total` and `tax` are the **max** over the rows, never the sum (`rules.aggregate_register_rows`).
Verified: the aggregated `invoice_total` equals the aging snapshot's `invoice_amount` for 1,036 of
the 1,040 invoices present in both. `job_number` = `service_location_job_number`,
`service_month` = month of `billing_period_from` else invoice date, `company` = aliased row company,
else the service-location job's company (same namespace), else the namespace default.

Open balance (`open_balance_basis`): invoices in the **latest** AR aging snapshot get
`amount_paid = invoice_total - amount_due` (`aging_snapshot`, 1,040 invoices) plus
`days_outstanding_snapshot` / `aging_bucket_snapshot`; every other invoice is assumed fully paid
(`assumed_paid`, 2,387). Invoices in the latest snapshot but missing from the register (150) are
inserted from the snapshot with `invoice_total = revenue_total = invoice_amount` (tax unknown).
`is_collectible` = no `ar_treatment_rules` entry with `include_collectible_ar = false` matches the
billed customer name (parent only when the customer name is blank).

`dim_customer`: one row per customer number (numbers are shared across companies, e.g. AMAZ01 is
billed by Crane and Sarus); name and `company` = most frequent; parent account = mode of its jobs'
accounts.

### core.fact_ar_aging_snapshot

Every AR aging snapshot date, every row (rows whose export has no snapshot date - 864 - are
skipped). Buckets are the WinTeam groups: `bucket_current` = group0 (not yet due), `bucket_1_30` =
group1, `bucket_31_60` = group2, `bucket_61_90` = group3, `bucket_90_plus` = group4 - verified on
every snapshot (group1 rows have days_out 0-29, group2 31-60, group3 61-90, group4 94+; group0 is
never populated for this tenant, `past_due_days` is always 0). `/ar/aging` reads the latest snapshot
directly when the reference source is primary (`as_of` = snapshot date, labels Current / 1-30 /
31-60 / 61-90 / 90+, `collectible_open`).

### core.dim_vendor / fact_ap_aging_snapshot / fact_ap_invoice / fact_ap_payment

- `dim_vendor`: one row per (namespace, vendor number), `winteam_id = fr:<ns>:<number>`, name from the
  latest snapshot row. Because vendor numbers collide across the two databases (1064 is "Michigan
  State Disbursement Unit" in Crane and "Ridley's Vacuum & Janitorial Supply" in Sarus) and the
  warehouse keys vendors by an integer `vendor_number`, **Sarus vendor numbers are offset by
  1,000,000** in `vendor_number` (the true number stays in `winteam_id`).
- `fact_ap_aging_snapshot`: every AP vendor aging snapshot row. AP groups are keyed on days past due
  (group1 = -57..30, group2 31-60, group3 61-90, group4 92+ in the dump): group1 goes to
  `bucket_current` when `days_past_due <= 0` and to `bucket_1_30` otherwise; the rest map directly.
- `fact_ap_invoice`: the latest snapshot's rows (`ap:<ns>:<vendor>:<invoice>`; `open_balance` =
  balance, `amount_paid`, `days_past_due`, `snapshot_date`, `due_date` = `standard_due_date` else the
  cash requirement export's `invoice_due_date`), plus the vendor activity export's invoices not already
  present (2024-05 .. 2026-05, aggregated per invoice: amount = sum of its check lines).
- `fact_ap_payment`: one row per vendor activity check line (`apactivity:<row id>`, `payment_date` =
  check date, 3,992 rows, 2025-07 .. 2026-05), plus aging rows with `amount_paid > 0` and a check date
  when activity has none for that invoice (`apaging:<ns>:<vendor>:<invoice>`; 0 in the current dump).
- `/ap/summary.kpis.open_estimate` = the latest snapshot's open balance (10,293,895 as of 2026-08-10);
  `by_vendor` rows carry `open_balance` and `past_due`; `due_next_30_days` is measured from the
  snapshot date when the reference source is primary.

### Marts (`marts.py`)

A (job, month) row exists for every job-cost row, timekeeping month, AR service month, schedule,
GL budget or labor budget. In a month covered by a job-cost import the job-cost P&L is the **only**
revenue and cost basis (`revenue_basis = labor_basis = 'job_cost'`), so `mart.portfolio_month`
reconciles to `mart.job_profitability_monthly` exactly; a job invoiced or worked in such a month
without a job-cost row keeps its `invoiced_total` / hours but carries 0 revenue and cost and the
quality note `no_job_cost_row` (40 rows). Hours, OT/DT, employee counts and last work date come from
timekeeping when the month has punches, else from the job-cost row. In months without a job-cost
import (2026-08) revenue = AR `revenue_total` by service month (`ar_invoice`) and labor = timekeeping
`labor_cost` (`trailing_job_rate`), no cost breakdown. `budget_labor` = `fact_labor_budget_month`
first. `gross_margin_pct` is null when revenue = 0. The job-cost `warning` status becomes the quality
note `job_cost_warning`.

## Verified numbers (local dump, load of 2026-09-02)

| Table | Rows |
|---|---|
| core.dim_job / dim_parent_account / dim_customer / dim_vendor / job_tier | 684 / 90 / 100 / 267 / 2,680 |
| core.fact_job_cost_month / fact_labor_budget_month | 3,138 / 1,264 (913 daily budget, 162 HBC, 189 wage by job) |
| core.fact_timekeeping | 271,462 (all priced, 2025-07-01 .. 2026-08-10) |
| core.fact_ar_invoice / fact_ar_aging_snapshot | 3,427 / 6,659 (9 snapshot dates) |
| core.fact_ap_invoice / fact_ap_aging_snapshot / fact_ap_payment | 5,750 / 11,437 / 3,992 |
| mart.job_month / portfolio_month | 3,422 / 22 |
| forecast run | validated, latest closed month 2026-07-01, 168 sites forecast |

`mart.portfolio_month` revenue / direct labor / hours (= the job-cost sums): 2025-07 2,680,803 /
1,533,447 / 77,551 h ... 2026-06 5,605,215 / 2,850,192 / 148,162 h ... 2026-07 5,758,735 / 3,736,786 /
199,805 h (gross profit -754,110, faithfully); 2026-08 (in progress, AR + trailing rate) 1,792,806 /
1,118,074 / 59,737 h. Subcontract cost 2026-07: 2,776,058. AR open 36,155,886 (collectible
35,906,670; ServiceMaster intercompany/settlement customers excluded); AP open 10,293,895
(4,121,714 past due). `/portfolio/summary` defaults to anchor 2026-07-01; `/labor/pace?month=2026-08-01`
shows labor to date 1,118,074 through 2026-08-10 with the trailing-rate basis note; `/jobs` returns
596 jobs with company / delivery_model / geo_precision (370 with approximate coordinates).

Reconciliation queries (app database):

```sql
SELECT month, revenue, labor_cost, hours FROM mart.portfolio_month ORDER BY month;          -- vs job cost sums
SELECT month, sum(revenue), sum(direct_labor), sum(actual_hours) FROM core.fact_job_cost_month GROUP BY 1 ORDER BY 1;
SELECT sum(amount_due), sum(amount_due) FILTER (WHERE is_collectible) FROM core.fact_ar_aging_snapshot
 WHERE snapshot_date = (SELECT max(snapshot_date) FROM core.fact_ar_aging_snapshot);       -- 36.2M / 35.9M
SELECT sum(balance) FROM core.fact_ap_aging_snapshot WHERE snapshot_date = (SELECT max(snapshot_date) FROM core.fact_ap_aging_snapshot); -- 10.29M
```

## Known data caveats

- **Timekeeping dollars are unreliable.** The timekeeping export's `dollars` / `ot_dollars` /
  `dt_dollars` sum to about $79 per hour and `pay_rate` is mostly 0, so they are ignored; labor cost
  is hours x the trailing job-cost rate (above). Payroll truth by job-month is the wage-by-job export
  (`total_actual_labor_dollars`, ~1.4M in 2025-07 .. 4.0M in 2026-07), which is not loaded as a fact
  yet; the job-cost `direct_labor` is used for closed months.
- **July 2026 job cost is anomalous.** 553 jobs, 390 rows flagged `warning`, large subcontractor
  amounts on zero-revenue project jobs; portfolio gross profit for the month is negative (-754k). It
  is loaded as the reference marts report it (quality note `job_cost_warning`); the AR register bills
  9.85M for July against 5.76M job-cost revenue. Treat July 2026 margins as provisional.
- **AR invoiced vs job-cost revenue differ by design** (company-level billing vs site-level job
  cost, timing): `invoiced_total` is the AR figure, `revenue` the job-cost figure in job-cost months.
- **Intercompany AR.** The 36.2M open AR includes ServiceMaster franchise / intercompany balances
  (about 249k under the treatment rule) that settle through AP offsets; use `collectible_open`.
  DSO on total AR is 179 days as of 2026-08-10.
- **AP paid by month is approximate.** Payments come from the vendor activity exports, which stop in
  2026-05; the aging snapshots carry almost no check dates (2 rows). AP invoiced for 2026-06 .. 08 is
  only what was still open on 2026-08-10.
- **Sarus jobs have no addresses or tiers.** The job master export in `sources/winteam_exports/` is
  a Crane export (`Sarus_job_master_report.csv` is a byte-for-byte duplicate of the Crane file), so
  the 19 Sarus jobs have no branch / region / service type / coordinates and their vertical is null.
- **Job numbers collide between the databases** (300, 301, 400-409, 401K, 6325, 99999, AR/AP,
  BalSheet, FA, Tax): e.g. 300 is "Amazon - BDL3/7" in Sarus and "FXE_AGCA Pittsburgh PA" in Crane.
  The reference marts already conflate them and the warehouse keeps one `dim_job` row per number
  (the reference `dim_job` choice, Sarus for 300/301/400-409); the load result lists them under
  `notes.job_number_collisions`. Crane job-master attributes are never applied to a Sarus job.
- **Reference rows without a snapshot date** (864 AR aging, 783 AP aging) are skipped.
- **Register distribution lines** do not always add up to the invoice total (313 invoices); the
  header total is used.
- **No schedules or GL budgets** come from the exports, so scheduled hours are 0 and
  `hours_variance` equals hours; subcontract / supplies budgets are null.
- The job-cost breakdown carries no payroll T&I, materials or equipment/supplies amounts in this
  dump (all 0), so `payroll_ti_cost` and `supplies_cost` are 0 and `direct_cost` = labor + subcontract.
- **The job-cost export has no revenue budget.** On every budgeted row `budget_revenue` equals
  `budget_direct_costs` and both equal the labor budget (e.g. 2026-01: 2,412,015 = the daily budget
  sum), so the marts do not treat them as revenue / direct-cost budgets (`budget_revenue` and
  `budget_direct_cost` stay null, the "Revenue" and "Gross profit" variance lines have no budget) -
  only the labor budget is real. `fact_job_cost_month` keeps the exported values.

## API additions (all additive, see docs/api-contract.md "Finance reference source")

`company` filter on every reporting endpoint; `source.primary_source` and `source.ar_as_of`;
`/dimensions.companies` / `delivery_models`; `/system/status.sources`; `/data/freshness.finance_reference`;
`GET /integrations/finance-reference`; `POST /integrations/finance-reference/load`; `JobRow`
gains `company`, `delivery_model`, `geo_precision`, `subcontract_cost`, `supplies_cost`,
`other_direct_cost`, `payroll_ti_cost`, `direct_cost`, `is_collectible_ar_only`;
`portfolio/summary` gains the cost breakdown in `kpis` and `monthly` plus `by_company`;
`/ar/aging` gains `as_of`, `basis`, `collectible_open`, `dso_days_collectible`, per-customer
`company` / `is_collectible`; `/ar/invoices` items gain `is_collectible`, `company`,
`open_balance_basis` and accept `collectible=`; `/ap/summary` gains `as_of`, `due_from`,
`kpis.open_balance` / `past_due` / `open_invoices` / `vendors_with_balance` and per-vendor
`open_balance` / `past_due`; `/budget/variance` lines "Subcontract" / "Supplies" carry actuals (the gross-profit budget uses
`budget_direct_cost` when present);
`/labor/summary.definitions.labor_cost` and `/labor/pace.method_notes.labor_cost_basis` state the
labor basis. Settings `account_groups`, `ar_treatment_rules`, `company_aliases`, `primary_source`
are validated on `PUT /settings/{key}`.

## Closed vs in-progress months (rule added 2026-09-02)

The job-cost P&L is the sole revenue/cost basis only for **closed** months (month end +
`close_lag_days` in the past). An in-progress month's job-cost import is partial (invoicing still
running: e.g. the Sep 1 August file carried $1.49M of revenue against $4.05M of timekeeping labor),
so for such months the marts use timekeeping labor at the trailing job rate, revenue =
greatest(AR invoices, partial job cost) labelled `job_cost_partial`, and gross profit is computed
from those components. The default reporting anchor stays on the latest closed month.

## Dump provenance caveat

Two Finance_Dashboard dumps exist: `local_backup_20260824.dump` (contains the
`Crane_job_cost_analysis_20260731_corrected.xlsx` July batch, imported Aug 21: July revenue $5.76M)
and `local_backup_20260902.dump` taken from the running Finance_Dashboard container (July batch is
the uncorrected `Crane_job_cost_analysis_20260731.xlsx`: $2.73M, Amazon/FedEx July invoicing
missing; adds August job cost, timekeeping through Sep 1, aging as of Aug 31). The corrected file
is at `FinanceDashboard/uploads/07357dfc-5e71-4eba-85c2-495851d5f886/`; importing it into the
running Finance_Dashboard and re-dumping is the clean fix.
