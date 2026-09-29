# Crane IFS API contract (v1)

All routes are served under `/api/v1` by the FastAPI service and proxied same-origin by nginx.
All responses are JSON with snake_case keys and numbers as numbers. Empty data returns `200` with
empty arrays / nulls, never `404`, except for a lookup of an unknown job (`404`).

Money is USD. Months are ISO dates on the first of the month (`"2026-08-01"`). `as_of` is the
date the marts were last rebuilt. Every payload that carries business data includes a
`source` block:

```json
"source": { "mode": "live" | "empty", "as_of": "2026-09-01T03:10:00Z", "latest_month": "2026-08-01", "stale": false }
```

`mode = "empty"` means no mart rows exist yet (WinTeam not synced). The browser then shows its
labeled demo data and says so.

## Period resolution

Reporting endpoints accept `period=MTD|QTD|YTD|T12M` (default `YTD`) plus optional
`month=YYYY-MM-01` (default = the latest CLOSED month: invoiced and past `close_lag_days`; in-progress
months are selectable and flagged by `/dimensions.month_status`). The server
resolves the inclusive month range and returns it in `range: {from, to, months}`:

- MTD = the anchor month only
- QTD = months in the anchor month's calendar quarter up to the anchor month
- YTD = January of the anchor year through the anchor month
- T12M = 12 months ending at the anchor month

Optional filters on every reporting endpoint: `account` (parent account name), `region`,
`branch`, `service_type`, `vertical`, `job_number`. Filters are exact-match against
`mart.job_month` columns.

## Platform

| Route | Response |
|---|---|
| `GET /system/status` | `{database, winteam: IntegrationStatus, marts: {latest_month, rebuilt_at, job_month_rows}, forecast: {run_id, engine_version, latest_closed_month, generated_at} \| null}` |
| `GET /integrations/winteam` | `IntegrationStatus = {enabled, configured, base_url_host, normalize_enabled, resources: [{name, enabled, entitled: true|false|null, kind, last_status, last_completed_at, records_fetched, watermark}], poll_seconds, sync: 'scheduled' \| 'on_demand'}` — `entitled=false` after the gateway answered 403 for that resource. `sync: 'scheduled'` with `poll_seconds` = WINTEAM_SYNC_INTERVAL_MINUTES × 60 while the worker's light timekeeping sync is on for a database enabled and configured for ingestion; `'on_demand'` with `poll_seconds: null` otherwise (the nightly sync runs either way). |
| `POST /integrations/winteam/test` (admin) | `{ok, resource, records_in_probe, total_count}` |
| `POST /integrations/winteam/sync/{resource}?deep=` (admin) | `{run_id, resource, status, fetched, inserted, normalized, message?}` — always runs (the daily skip does not apply to a named resource); 409 while another WinTeam sync runs |
| `POST /integrations/winteam/watermark/{resource}/reset` (admin) | `{resource, watermark_removed, next_sync}` — the next sync of that resource backfills `WINTEAM_BACKFILL_MONTHS` (raw records are kept; replays are idempotent) |
| `POST /integrations/winteam/sync?normalize=&resources=&force=&deep=` (admin) | `{runs: [...as above], marts: RebuildResult \| null, normalized, not_entitled}` — on-demand sync, normalize, rebuild marts and forecasts; 409 while another WinTeam sync (the worker's nightly or interval run, or another Admin sync) holds the sync lock. Timekeeping and AP re-read 3 days before the last sync, 35 with `deep=true`. Jobs, vendors, budgets and AR synced within 20 hours come back `status: 'skipped'` unless `force=true`; `marts` is null when every resource was skipped. |
| `POST /marts/rebuild` (admin) | `RebuildResult = {job_month_rows, portfolio_month_rows, forecast: ForecastBuildResult \| null, seconds}` |
| `POST /forecasts/rebuild` (admin) | `ForecastBuildResult = {run_id, forecast_rows, accuracy_rows, track_rows, status_rows, sites_forecast}` |
| `GET /integrations/winteam/runs?limit=25` | `{runs: [{id, resource_name, status, started_at, completed_at, records_fetched, records_inserted, error_message}]}` |
| `GET /integrations/winteam/sarus` | `{configured, enabled, base_url_host, has_subscription_key, ingestion, resources: [{name, enabled, kind, last_status, last_completed_at, records_fetched, watermark, entitled}], precedence: {sarus_timekeeping_from, sarus_timekeeping_to, sarus_ap_invoice_from, sarus_ap_invoice_to, sarus_ar_invoices_api}}` — the second WinTeam database (Sarus). Never returns the tenant id or key. `ingestion` is true when `WINTEAM_SARUS_ENABLED` and the tenant is configured; the worker then syncs it nightly and on the light timekeeping interval, after the primary. Sarus rows carry source `winteam_sarus` and supersede only Sarus export rows inside their own window (migration 026). |
| `POST /integrations/winteam/sarus/sync?normalize=&resources=&force=&deep=` (admin) | Same shape as `POST /integrations/winteam/sync`: `{runs, marts, normalized, not_entitled}`. GET-only against WinTeam; 409 unless `WINTEAM_SARUS_ENABLED`, and while another WinTeam sync runs. Resources: jobs (raw only), vendors, timekeeping, job_budgets, ap_invoices, ap_invoice_details, ar_invoices. |
| `POST /integrations/winteam/sarus/test` (admin) | `{ok, jobs_total, company_numbers, matches_known_sarus_jobs, matches_known_crane_jobs, sample_jobs, configured, enabled, base_url_host, has_subscription_key, ingestion}` — one read-only GET of the Sarus jobs list; works before `WINTEAM_SARUS_ENABLED`, lands nothing. Company numbers are per database (Sarus and Crane both have company 1), so identity is judged by job: `matches_known_crane_jobs` above zero means the id points back at the Crane tenant. |
| `GET /integrations/companycam` | `{configured, base_url, match_rule, note}` — whether site photos are wired. The token is server-side only and is never returned. |
| `GET /integrations/companycam/probe?limit=5` (admin) | `{configured, projects_returned, fields_present, sample, next_step}` — read-only look at real CompanyCam projects so a project-to-job match rule can be chosen from evidence rather than guessed. |
| `GET /data/reconciliation?months=6` | `{ar_chain: [{month, raw_invoices, core_invoices, raw_revenue, core_revenue, variance, exact}], ingestion_exact, suppressed_ar: [...], suppressed_ar_total, uncosted_revenue: [...], uncosted_revenue_total, healthy, note}`. Proves published figures trace to WinTeam payloads. `raw -> core` must reconcile to the cent - a variance is an ingestion defect. `suppressed_ar` is invoiced AR published as zero revenue (margin too low); `uncosted_revenue` is revenue published with no labor basis (margin too high). A month is reportable only when both are zero. |
| `GET /data/freshness` | `{resources: [{resource_name, last_status, last_completed_at, records_fetched, records_inserted, last_error, watermark_value, seconds_since_last_completion, overdue: null, overdue_after_seconds: null, not_entitled}], ingestion: {healthy, overdue_resources: [], overdue_after_seconds: null, poll_seconds, sync: 'scheduled' \| 'on_demand', reference_stale, reference_stale_after_seconds}, marts: {...}}`. `sync` and `poll_seconds` as in `GET /integrations/winteam`. A failed sync is recorded as failed, so no resource is judged overdue; `seconds_since_last_completion` is the age of its last sync. Resources the tenant is not entitled to (HTTP 403) carry `not_entitled`. `reference_stale` covers the hand-loaded finance_reference export (the primary job-cost P&L source; stale after 7 days, at which point the newest months carry labor without revenue). `healthy` is false when it is stale. |
| `GET /settings` | `{settings: [{key, value, description, updated_at}]}` |
| `PUT /settings/{key}` (admin) body `{value}` | updated setting |
| `GET /dimensions` | `{months: [ISO], month_status: [{month, status: "closed" \| "in_progress" \| "no_revenue"}], latest_month, latest_closed_month, default_month, accounts: [], regions: [], branches: [], service_types: [], verticals: [], customers: [{customer_number, customer_name}]}` |

Admin routes require header `X-Admin-Token` equal to `INGESTION_ADMIN_TOKEN`.

## Reporting

### `GET /portfolio/summary?period=&month=&filters`

```json
{
  "source": {...}, "range": {"from": "2026-01-01", "to": "2026-08-01", "months": 8},
  "kpis": {
    "revenue": 0, "revenue_prior": 0, "gross_profit": 0, "gross_margin_pct": 0.0,
    "labor_cost": 0, "labor_pct_revenue": 0.0, "hours": 0, "overtime_hours": 0, "overtime_pct": 0.0,
    "scheduled_hours": 0, "hours_variance": 0, "budget_revenue": null, "budget_labor": null,
    "ar_open": 0, "dso_days": null, "active_jobs": 0, "jobs_below_margin_target": 0,
    "ap_invoiced": 0, "ap_paid": 0
  },
  "deltas": { "revenue_pct": null, "gross_margin_pts": null, "labor_pct_pts": null, "overtime_pct_pts": null, "hours_pct": null },
  "monthly": [ { "month": "2025-09-01", "revenue": 0, "invoiced_total": 0, "collected_total": 0, "budget_revenue": null,
                 "labor_cost": 0, "budget_labor": null, "gross_profit": 0, "hours": 0, "overtime_hours": 0,
                 "scheduled_hours": 0, "jobs_reporting": 0, "ap_invoiced": 0, "ap_paid": 0 } ],
  "by_region": [{"name": "", "revenue": 0, "gross_profit": 0, "labor_cost": 0, "hours": 0, "jobs": 0}],
  "by_service_type": [ same shape ],
  "by_account": [ same shape + "customer_numbers": [] ]
}
```

`monthly` always returns the trailing 12 months ending at the anchor month (independent of
`period`), so trend charts stay stable. `deltas` compare the selected range against the
equivalent prior range (prior month / prior quarter-to-date / prior year-to-date / prior 12).
`dso_days = ar_open / (trailing-3-month revenue / 91)`; null when revenue is 0.

### `GET /jobs?period=&month=&filters`

```json
{ "source": {...}, "range": {...}, "jobs": [ {
  "job_key": 1, "job_number": "10002z", "job_name": "", "parent_account": "", "customer_number": null,
  "region": "", "branch": "", "service_type": "", "vertical": "", "manager_name": "",
  "city": "", "state_province": "", "country_code": "US", "latitude": null, "longitude": null,
  "is_active": true, "date_to_start": null,
  "revenue": 0, "invoiced_total": 0, "collected_total": 0, "gross_profit": 0, "gross_margin_pct": null,
  "labor_cost": 0, "burden_cost": 0, "hours": 0, "regular_hours": 0, "overtime_hours": 0, "scheduled_hours": 0,
  "budget_revenue": null, "budget_labor": null, "labor_variance": null, "hours_variance": 0,
  "employee_count": 0, "ar_open": 0, "days_outstanding_weighted": null, "last_invoice_date": null, "last_work_date": null,
  "months_reporting": 0, "status": "Healthy" | "Watch" | "Critical", "status_reasons": [] } ] }
```

Status rule (server-side, disclosed in `/settings`): Critical when gross margin < target − 7 pts,
or labor over budget by > 13%, or OT > 15% of hours, or weighted AR days > 65; Watch at margin
< target, labor over budget > 7%, OT > 10%, AR days > 45; else Healthy.

### `GET /jobs/{job_number}/subcontractors?months=12`

`{job_number, range, total_cost, vendors: [{vendor_name, vendor_number, invoices, amount, share, last_invoice_date, gl_accounts}], basis}`

Who is paid to work a site, from `core.fact_ap_distribution` — WinTeam's own coding of a payable to
a job, so these are booked costs with their GL accounts rather than an apportionment or a
trailing-average projection. Ordered by amount. `share` is null when the site's total is zero.

### `GET /jobs/{job_number}?months=24`

`{ source, job: JobRow (as above, T12M basis), history: [ mart.job_month rows ], schedule_vs_actual: [{week_start, scheduled_hours, actual_hours, overtime_hours}] (last 13 weeks), invoices: [ open AR rows ], forecast: { rows: [...], accuracy: [...] } | null }`

### `GET /accounts?period=&month=`

`{ source, range, accounts: [{ parent_account, customer_numbers: [], jobs: 0, revenue, gross_profit, gross_margin_pct, labor_cost, hours, overtime_hours, ar_open, days_outstanding_weighted, status }] }`

### `GET /ar/aging?filters` and `GET /ar/invoices?bucket=&customer=&account=&limit=100&offset=0`

```json
{ "source": {...}, "as_of": "2026-09-01", "total_open": 0,
  "buckets": [{"bucket": "current", "label": "0-30", "amount": 0, "invoices": 0}, ... d30, d60, d90, d90_plus],
  "by_customer": [{"customer_number": "", "customer_name": "", "parent_account": "", "current": 0, "d30": 0, "d60": 0, "d90": 0, "d90_plus": 0, "total": 0, "invoices": 0}],
  "dso_days": null }
```
```json
{ "items": [ mart.v_ar_open row ], "total": 0, "limit": 100, "offset": 0 }
```

### `GET /ap/summary?period=&month=`

`{ source, range, kpis: {invoiced, paid, invoices, vendors, open_estimate: null}, by_vendor: [{vendor_number, vendor_name, invoiced, paid, invoices}], monthly: [{month, invoiced, paid}], due_next_30_days: [{due_week_start, amount, invoices}] }`

### `GET /labor/summary?period=&month=&filters`

`{ source, range, kpis: {labor_cost, revenue, labor_pct_revenue, target_labor_pct, hours, overtime_hours, overtime_pct, overtime_cost_estimate, budget_labor, labor_variance, scheduled_hours, hours_variance, revenue_per_hour, gross_profit_per_hour}, monthly: [{month, labor_cost, budget_labor, revenue, labor_pct_revenue, hours, overtime_hours, scheduled_hours}], by_account: [{parent_account, labor_cost, budget_labor, revenue, hours, overtime_hours, labor_pct_revenue}], by_job: [{job_number, job_name, parent_account, labor_cost, budget_labor, labor_variance, hours, overtime_hours, overtime_pct, scheduled_hours}], overtime_employees: [{employee_source_id, hours, overtime_hours, jobs: 0}] }`

### `GET /labor/pace?month=&account=&job_number=`

Month-end labor projection (ported pace model). One row per scope (portfolio or account or job):

```json
{ "source": {...}, "month": "2026-09-01", "as_of": "2026-09-14", "days_elapsed": 14, "days_in_month": 30,
  "rows": [{ "scope": "portfolio" | "account" | "job", "name": "", "labor_to_date": 0, "hours_to_date": 0,
             "projected_labor": 0, "projected_hours": 0, "projection_method": "day_of_week_weighted" | "calendar_proration" | "none",
             "projected_calendar": 0, "budget": null, "budget_to_date": null, "projected_variance": null, "pct_over": null,
             "prior_month_labor": 0, "range_lo": null, "range_hi": null, "range_n": 0, "jobs_with_labor": 0, "jobs_with_budget": 0 }] }
```

### `GET /timekeeping/summary?period=&month=&filters`

`{ source, range, kpis: {hours, regular_hours, overtime_hours, overtime_pct, scheduled_hours, hours_variance, employees, punches, revenue_per_hour}, daily: [{work_date, hours, overtime_hours, scheduled_hours, employees}] (last 8 weeks), by_weekday: [{isodow, label, avg_hours}], by_job: [{job_number, job_name, parent_account, scheduled_hours, hours, overtime_hours, variance, employees}], by_branch: [{branch, scheduled_hours, hours, overtime_hours}] }`

### `GET /budget/variance?period=&month=&filters`

`{ source, range, lines: [{name: "Revenue" | "Labor" | "Subcontract budget" | "Supplies budget" | "Gross profit", actual, budget, variance, variance_pct, favorable}], monthly: [{month, revenue, budget_revenue, labor_cost, budget_labor}], by_account: [{parent_account, revenue, budget_revenue, labor_cost, budget_labor}], by_job: [{job_number, job_name, revenue, budget_revenue, labor_cost, budget_labor, labor_variance_pct}], coverage: {jobs_with_budget, jobs_total} }`

### `GET /alerts?period=&month=&filters`

`{ source, range, alerts: [{id, severity: "critical" | "watch", type, job_number, job_name, parent_account, branch, detail, metric_value, threshold}] }`

## Forecasting (engine v2, server-side)

| Route | Response |
|---|---|
| `GET /forecasts?metric=revenue\|gross_profit&account=` | `{ source, metric, run: RunMeta \| null, rows: [ForecastRow], not_forecast: [SeriesStatus] }` — rows ordered portfolio (`__ALL__`) first, then by point desc |
| `GET /forecasts/meta` | `RunMeta = {run_id, engine_version, generated_at, latest_closed_month, horizon_months, dataset, gates, coverage, disruption, portfolio, assumptions: []}` |
| `GET /forecasts/history?metric=&account=` | `{ rows: [{month, revenue, gross_profit, labor_cost, hours, closed: bool, suspect: reason\|null}] }` |
| `GET /forecasts/track-record?metric=&job_number=__ALL__` | `{ metric, job_number, rows: [{origin_month, forecast_month, horizon, method, point, lo, hi, actual, scaled_error, in_band}] }` |
| `GET /forecasts/{job_number}` | `{ job_number, job_name, rows: [ForecastRow for both metrics], accuracy: [AccuracyRow], history: [...] }` |

```
ForecastRow = { job_number, job_name, metric, basis_month, forecast_month, horizon_step, point, lo, hi, method,
                explanation, n_history, status, volatility_class, input_months: [], excluded_months: [{month, reason}],
                method_selection: {}, interval: {}, disruption: {} | null, identity: {} | null, quality: {},
                engine_version, accuracy: {n_backtests, median_ape, mase, coverage} | null }
SeriesStatus = { job_number, job_name, metric, status, reason, last_valid_month, n_valid }
```

Portfolio history endpoint (`/forecasts/history`) is the same series the engine fitted, so the
UI can draw actual + forecast bands on one axis.

## Finance reference source (real WinTeam exports, added 2026-09-02)

A second server-side source loads the real historical WinTeam report exports from the restored
Finance_Dashboard database (`finance_reference`, read-only) into the same core/mart tables. It
coexists with the WinTeam API source; `source.primary_source` tells the browser which one filled
the marts.

Contract additions (all additive):

- Every reporting endpoint accepts filter `company` (exact match on `mart.job_month.company`).
- `source` block gains `primary_source: "winteam_api" | "finance_reference" | "none"` and
  `ar_as_of: ISO date | null` (the AR/AP aging snapshot date when the reference source is primary).
- `GET /dimensions` gains `companies: []` and `delivery_models: []`.
- `GET /system/status` gains `sources: [{name, configured, enabled, last_status, last_completed_at, records}]`.
- `GET /integrations/finance-reference` → `{configured, database_host, reference: {job_cost_months: [from, to], timekeeping_max_date, ar_snapshot_date, ap_snapshot_date} | null, last_load: {run_id, status, started_at, completed_at, tables: [{name, rows}]} | null}`
- `POST /integrations/finance-reference/load` (admin) → `{run_id, tables: [{name, rows}], marts: RebuildResult, seconds}`. Loading first clears any data from other sources (the synthetic simulator data included) so the warehouse holds one coherent source; settings are kept.
- `POST /integrations/finance-reference/watermark/reset` is not needed: every load is a full replace.
- `JobRow` gains `company`, `delivery_model: "self_perform" | "subcontracted" | null`, `geo_precision: "exact" | "city_center" | null`, `subcontract_cost`, `supplies_cost`, `other_direct_cost`, `payroll_ti_cost`, `is_collectible_ar_only: bool`.
- `portfolio/summary.kpis` and each `monthly` row gain `subcontract_cost`, `supplies_cost`, `other_direct_cost`, `payroll_ti_cost`, `direct_cost`; `by_company` (same shape as `by_region`) is added.
- `budget/variance.lines` "Subcontract" and "Supplies" carry real actuals when the reference source is primary.
- `ar/aging` gains `as_of` (snapshot date) and `collectible_open` (total excluding intercompany/settlement customers per the `ar_treatment_rules` setting); `by_customer` rows gain `is_collectible` and `company`; buckets follow the WinTeam aging groups (current, 1-30, 31-60, 61-90, 90+).
- `ap/summary.kpis.open_estimate` becomes the real open AP balance from the latest vendor aging snapshot; `by_vendor` rows gain `open_balance` and `past_due`.
- `labor/pace`: when the reference source is primary, daily labor cost = hours × the job's trailing closed-month average rate (`direct_labor / actual_hours` from the job-cost P&L); `method_notes.labor_cost_basis` says so.

## Forecast account aggregation, subcontract metric, AR cash application (added 2026-09-02)

- `GET /forecasts?metric=&account=X`: when `account` is set the `__ALL__` portfolio row is OMITTED and an
  aggregate row `job_number = "__ACCOUNT__"` (job_name = the account) is returned first: point/lo/hi are
  the sums of that account's forecast site rows per horizon (method `sum_of_site_forecasts`,
  explanation states how many of the account's sites are forecast and the share of last-closed revenue
  they cover). The response also carries
  `account_summary: {account, sites_total, sites_forecast, sites_not_forecast, self_perform_sites, subcontracted_sites,
  last_closed_month, last_closed_actual: {revenue, labor_cost, subcontract_cost, gross_profit}, forecast_coverage_pct}`.
- Metrics: `revenue | gross_profit | labor_cost | subcontract_cost` (subcontract_cost series are gated on
  subcontract_cost > 0 in a closed month, sourced from mart.job_month.subcontract_cost).
- `ForecastRow` gains `delivery_model` and `parent_account`; `SeriesStatus` gains `delivery_model`.
- `GET /forecasts/history?metric=&account=` returns the account's own history when `account` is set.
- `GET /ar/aging` gains `cash_application: {invoices_open, invoices_with_payment_applied, pct_with_payment_applied,
  open_nothing_applied, open_nothing_applied_over_90, oldest_open_invoice_date, note}` computed from the latest aging
  snapshot (`amount_due < invoice_amount` = a payment was applied) so the page can disclose that the aging is only
  as accurate as cash application in WinTeam.

## Executive labor P&L (weekly), added 2026-09-03

Replica of the executive "Labor P&L Dashboard" (weekly labor cost, hours and OT by site and business
unit, labor % of invoicing vs BU target) for every account. Weeks are Monday-based ("Week of Jan 5").

`GET /executive/labor-pl?account=All|<parent_account>&weeks=18&week=YYYY-MM-DD`
```json
{ "source": {...}, "as_of": "2026-09-01", "account": "Amazon",
  "weeks": ["2026-05-04", ...],                       // ordered, ending at the latest week with labor
  "selected_week": "2026-08-24",                      // default: latest week with a full 7 days of labor
  "business_units": [{"key": "crane_west", "name": "Crane West", "color": "#378ADD", "target_pct": 59.5, "high_pct": 65.0}],
  "rows": [ { "week": "2026-08-24", "bu": "Crane West", "site": "LGB3", "job_number": "500", "site_name": "Amazon - LGB3",
              "account": "Amazon", "delivery_model": "subcontracted",
              "invoicing": 0, "invoicing_basis": "job_cost_month_prorated" | "contract" | "ar_invoice_prorated" | "carry_forward" | "none",
              "invoicing_estimated": false,                   // true only on the carry_forward basis (added 2026-09-03, migration 009)
              "carry_forward_source": null,                   // "job_cost" | "ar_invoice" when carried forward, else null (migration 010)
              "hours": 0, "ot_hours": 0, "dt_hours": 0, "budget_hours": 0, "budget_dollars": 0, "budget_basis": "daily_budget" | "hbc" | "none",
              "direct_dollars": 0, "ot_dollars": 0, "sub_dollars": 0, "sub_estimated": false, "total_dollars": 0,
              "labor_cost_basis": "trailing_job_rate" | "job_cost" , "days_with_labor": 7,
              "requested_headcount": 2, "pending_requested_headcount": 1 } ],  // added 2026-09-29, null before the PhotoValidation feed loads
  "qa": null,                                          // QA scores are not in the warehouse; always null for now
  "notes": ["Invoicing = closed-month job-cost revenue apportioned to weeks by calendar days ...", ...] }
```
Rules: `hours` = timekeeping total hours; `ot_hours`/`dt_hours` from timekeeping; `direct_dollars` = straight-time
labor (hours × job rate); `ot_dollars` = ot_hours × rate × 0.5 premium + dt_hours × rate × 1.0 (estimate, labelled);
`sub_dollars` = the site's monthly subcontract cost apportioned by calendar days (sub_estimated = true when the month
is not closed and the latest closed month's rate is carried forward); `invoicing` = closed-month job-cost revenue
apportioned by calendar days, else contract billing x 12/53 x day-share, else AR invoices for the service month
apportioned, else the job's most recent month within the last 3 closed months with job-cost or AR service-month revenue,
carrying GREATEST(job-cost revenue, AR revenue) forward apportioned the same way with `invoicing_estimated: true` and
`carry_forward_source` = the winner (basis `carry_forward`), else 0 (basis says which);
`budget_dollars`/`budget_hours` = daily budget summed over the week when present, else the monthly labor budget
apportioned by days. `total_dollars = direct + sub` (direct is all-in payroll priced at the trailing payroll rate, which already carries the OT premium; `ot_dollars` is informational). BU = company. Targets from setting `bu_targets`
(seeded {Crane West: 59.5/65, Crane IFS: 64.5/70, Crane Southwest: 64.5/70, Sarus: 64.5/70}).
`GET /executive/accounts` → `{accounts: [{name, sites, business_units: []}]}` for the account selector.

## Executive slicing: sub-accounts and delivery model (added 2026-09-04)

- `mart.job_week` gains `sub_account` (the second level under a key account: for School districts the
  district, e.g. "Plano Independent School District"; for FedEx "FedEx Express (FXE)" / "FedEx Ground (FXG)" /
  "FedEx" by job-name prefix; for other accounts the AR customer name when it differs from the account, else
  the account). Rules live in setting `sub_account_rules` (see backend docs); defaults cover the key accounts.
- `GET /executive/accounts` → each account gains `sub_accounts: [{name, sites, delivery: {self_perform, subcontracted}}]`
  (ordered by sites desc) and `delivery: {self_perform, subcontracted}` site counts.
- `GET /executive/labor-pl` accepts `sub_account=<name>` and `delivery=all|self_perform|subcontracted`
  (default all) in addition to `account`; the response echoes `sub_account` and `delivery`, rows carry
  `sub_account` and `delivery_model`, and `notes` states the delivery split of the selected week.
- Row semantics, unchanged but now first-class in the UI: `hours`/`ot_hours`/`direct_dollars`/`ot_dollars` are
  self-performed labor (0 for subcontracted sites); `sub_dollars` is vendor (subcontractor) cost apportioned
  from the job-cost P&L (flag `sub_estimated` when carried forward); `total_dollars = direct + sub` (OT premium informational, not added);
  `margin = invoicing − total_dollars` is computed client-side. Vendor identity is not job-linked in WinTeam
  except the configured agency rule, so vendor cost is a per-site amount, not a per-vendor breakdown.

## Vendor cost: projection and live AP look (added 2026-09-04)

- `mart.job_week.sub_dollars` for weeks in a NOT-closed month is now a **projection**: the site's average weekly
  subcontract cost over its last 3 closed job-cost months (`sub_basis = 'trailing_3mo_projection'`,
  `sub_estimated = true`); closed months keep the day-share apportionment of the actual job-cost line
  (`sub_basis = 'job_cost_month_prorated'`). The agency rule (`agency_ap`) still overrides for its sites.
- `GET /executive/labor-pl` gains `vendor: { month, month_status: "closed"|"in_progress", as_of,
  projected_month_sub, projected_basis, sites_projected, ap_live: { invoiced_to_date, invoices, vendors,
  through, by_vendor_type: [{vendor_type, invoiced, invoices}] } | null,
  history: [{month, job_cost_sub, ap_subcontractor_invoiced, ap_all_invoiced}] (last 6 closed months) }`.
  `ap_live` sums AP invoices (any source) dated in the month for vendors whose type matches the setting
  `subcontractor_vendor_types` (defaults ["subcontract","sub contract","janitorial","labor","staffing","agency"],
  case-insensitive contains on vendor_type / vendor name); it is company-wide, not per account, because WinTeam
  AP is not job-linked — the response says so in `notes`. `history` lets the UI show how AP subcontractor
  invoicing tracks the job-cost subcontract line month by month.
- Rows gain `sub_basis` (already present in the mart) so the UI can label projected vs actual vendor cost.
- Scope split (added 2026-09-04, evening): `projected_month_sub` and `history[].job_cost_sub` follow the request scope
  (account / sub_account / delivery); `projected_month_sub_all` and `history[].job_cost_sub_all` are the same figures
  company-wide (every job: Σ `mart.job_month.subcontract_cost` on the job-cost basis, or the projected month over every
  site) so the UI can chart AP - which is always company-wide - against job cost on the same scope. `vendor.scope_note`
  is the sentence to show next to the chart. `by_vendor_type[].vendor_type` is the invoice's `vendor_type` when the feed
  carries one, else the label of its `vendor_type_id` from setting `vendor_type_labels` (migration 016, seeded
  {"6": "Subcontractor"}; the WinTeam vendors endpoint returns ids only), else `"type N"` / the matching term. Extra
  fields beyond the original block: `sites`, `sites_by_basis`, `ap_live.all_invoiced`, `by_vendor_type[].vendors`.

## Reporting scope: key accounts first (added 2026-09-09)

The analysis views default to the key accounts and reach the long tail by drill-down. Every reporting
endpoint (`/portfolio/summary`, `/jobs`, `/jobs/{n}`, `/accounts`, `/ar/*`, `/ap/summary`,
`/labor/*`, `/timekeeping/summary`, `/budget/variance`, `/alerts`, `/forecasts*`) accepts:

- `scope=key|all|other` (default **`key`**): `key` = the accounts in setting `key_accounts` combined,
  `other` = every account not in that setting, `all` = everything. Ignored when `account` is set.
- `account=<parent_account>` — one account, key or other (the drill-down). With it, `scope` is echoed
  as `account`.
- `sub_account=<name>` — second level under a key account (school district, FedEx Express/Ground);
  requires `account`, 422 otherwise.
- `delivery=all|self_perform|subcontracted` (default `all`) — same rule as the executive view
  (`delivery_model`, NULL treated as self-perform when the row has hours, else subcontracted).

`region`, `branch`, `service_type`, `vertical`, `company`, `job_number` keep working unchanged.

Every response's `range` block gains `scope: {mode: "key"|"all"|"other"|"account", label, accounts: [],
sites: int}` so a view can state what it is showing. `notes`-bearing endpoints add one line naming the
scope. Coverage: `/portfolio/summary.kpis` gains `revenue_share_of_all` (the scope's revenue ÷ every
account's revenue for the same range) so a key-account view can disclose what it leaves out.

`GET /dimensions` gains:
`key_accounts: [{name, label, sites, sub_accounts: [{name, sites}]}]`,
`other_accounts: [{name, sites}]` (ordered by revenue desc for the latest closed month),
`delivery_models: []`, and keeps `accounts` (all names) for backward compatibility.

Implemented 2026-09-09 (backend detail in `docs/reporting-scope.md`). Additions beyond the block
above, all additive:

- `/portfolio/summary.kpis` also carries `revenue_all_accounts` (the denominator of
  `revenue_share_of_all`), and the response carries `scope_note` - the sentence naming the scope and
  stating that `ap_invoiced` / `ap_paid` stay company-wide.
- `/ar/aging` and `/ar/invoices` have no month range, so their scope block is top-level `scope`
  (not `range.scope`); both also return `filters` (the echoed narrowing filters) and `/ar/aging`
  a `scope_note`. `/ar/invoices` now takes `account` through the shared filter set, so it also
  accepts `scope`, `sub_account`, `delivery` and the other dimension filters.
- `/ap/summary` echoes `range.scope` and returns `scope_note`; every AP figure stays company-wide
  (WinTeam AP is not job-linked). `/labor/summary` returns `scope_note`; `/labor/pace` returns a
  top-level `scope` echoing only its own `account` / `job_number`.
- `/jobs/{job_number}` is never scoped away: it reports `range.scope.mode = "all"` for the one job.
- `/forecasts` returns `scope` and `filters`; `account_summary` gains `scope` (the mode) and
  `aggregate_row` (`__SCOPE__` | `__ACCOUNT__`).
- `/dimensions.other_accounts` rows carry `latest_month_revenue` (the ordering key), and the
  response gains `scopes: ["key","all","other"]`. `delivery_models` was already present.
- `mart.job_month` gained `sub_account` (migration 018), written by the same
  `app.weekly.apply_sub_accounts` pass that labels `mart.job_week`, so the sub-account drill-down
  works on the monthly mart. A mart rebuild is required after applying the migration.

## Leadership labor P&L (added 2026-09-23)

WinTeam sync cadence changed the same day: the worker runs one incremental sync a night
(`app/nightly.py`, setting `nightly_sync`), recorded in `ops.integration_sync_run` as integration
`nightly` (reported by `GET /leadership/config` `status.syncs`). Since 2026-09-29 it also runs a light
timekeeping sync every `WINTEAM_SYNC_INTERVAL_MINUTES` (see "Staffing requests and the sync schedule").

The leadership views (Home, Account, Analytics) read `mart.leadership_week` (migration 030, rules
in `services/api/app/leadership.py`) joined at read time with the account configuration
(`ops.account`, `ops.account_segment`, `ops.account_job`, migration 028), so configuration edits
apply without a rebuild. **Ratios in these payloads are fractions** (`target_labor_pct: 0.645`); the
browser client does not convert them. Every derived metric (weekly invoice, labor %, base rate, $ and
hours over target, OT premium, prior-month labor % including subcontractor cost, status) is computed
in the browser by `src/leadership/metrics.ts`, pinned by tests to the Plano reference week. Weeks
are Monday-based; the views label them by the week-ending Sunday. Any date in a week selects it.

| Route | Response |
|---|---|
| `GET /leadership/config` | `{source, accounts: [LeadershipAccount], weeks: [{week_start, week_end, days_with_labor, pay_report_share, revenue_month, in_progress}], default_week, status: {rebuilt_at, leadership_rebuilt_at, syncs: [{integration_name, status, completed_at, started_at}], imports: {pay_report?, job_cost?: {file_name, period_from, period_to, rows_loaded, loaded_at}}, pay_report_through: [{company, through}]}}`. `default_week` = the latest complete week. A `syncs` entry is `failed` when the latest run of any of that integration's resources failed, except a resource the tenant is not entitled to (HTTP 403, error `not_entitled`). |
| `GET /leadership/rows?week=&weeks=1&account=featured` | `{source, week, weeks: [ISO], account, rows: [LeadershipRow]}` for `weeks` (1–26) weeks ending at `week`. `account` = a slug, `featured`, `other` (unmapped or non-featured) or `all`. 404 for an unknown slug. |
| `GET /leadership/sites/{company}/{job_number}?weeks=13&week=` | `{source, site: {company, job_number, site_name, address_line_1, city, state_province, postal_code, latitude, longitude, parent_job_number, delivery_model, parent_account, account_slug, segment, role, companycam_project_id}, weeks: [LeadershipRow], invoices: {since, vendor_type_ids, total, lines: [{invoice_number, invoice_date, gl_account_number, amount, vendor_number, vendor_name, vendor_type_id}]}, photos: {configured, project_id, items: [{id, captured_at, thumbnail, web, creator_name}] \| null, error}}`. Invoices are AP GL distribution lines coded to the job from subcontractor vendors (setting `subcontractor_vendor_type_ids`, default `[6]`) over the last 6 months. Photos are fetched server-side from CompanyCam when a token and the job's `companycam_project_id` exist. 404 for an unknown job. |
| `GET /leadership/vendors?account=&months=6` | `{account, since, vendor_type_ids, total, by_vendor: [{vendor_number, vendor_name, amount, invoices}], by_site: [{company, job_number, site_name, amount, invoices}], by_month: [{month, amount, invoices}], lines: [invoice line + {company, job_number, site_name}]}`: subcontractor AP distribution lines coded to the account's sites since the first of the month `months - 1` back. 404 for an unknown slug. |
| `PUT /leadership/accounts/{slug}` (admin) body: any of `name, featured, sort, target_labor_pct, watch_band, revenue_method, revenue_divisor, budget_reliability_ratio, source_parent_accounts, segment_source, fallback_segment` | the updated `LeadershipAccount` |
| `PUT /leadership/accounts/{slug}/segments` (admin) body `[{name, target_labor_pct}]` | the account plus `jobs_moved_to_fallback`; the fallback segment must stay in the list |
| `GET /leadership/account-jobs?account=&needs_review=&unmapped=` (admin) | `{jobs: [{company, job_number, account_slug, segment, role, companycam_project_id, assigned_by, needs_review, job_name, parent_account, is_active}]}`; `unmapped=true` lists current jobs in Other |
| `PUT /leadership/account-jobs/{company}/{job_number}` (admin) body `{account_slug \| null, segment, role, companycam_project_id}` | the mapping row (`assigned_by: 'admin'`, `needs_review: false`); `account_slug: null` unmaps the job (Other) |
| `POST /leadership/accounts/seed` (admin) | `{added: {accounts, segments, jobs}}`: adds what `config/accounts/seed.json` has and the database lacks; never overwrites |
| `GET /leadership/imports?limit=25` (admin) | `{files: [LeadershipImportFile]}` |
| `POST /leadership/imports` (admin, multipart `file`, optional `kind` = `pay_report` \| `job_cost`, `rebuild` = true) | `{file: LeadershipImportFile, marts: RebuildResult \| null}`; formats in `docs/export-feeds.md`. A file already loaded comes back `status: 'duplicate'`. |

```
LeadershipAccount = { slug, name, featured, sort, target_labor_pct, watch_band, revenue_method: 'monthly_div'|'weekly_billing'|'per_visit',
  revenue_divisor, budget_reliability_ratio, source_parent_accounts: [], segment_source: 'explicit'|'sub_account'|'company'|'fallback',
  fallback_segment, revenue_allocation: 'none'|'budget_hours', cost_basis: 'labor'|'labor_plus_vendor',
  segments: [{name, sort, target_labor_pct|null}], sites, needs_review, updated_at, updated_by }
LeadershipRow = { week_start, week_end, company, job_number, site_name, parent_account, account_slug|null (Other), segment, role: 'site'|'catch_all'|'non_billed',
  needs_review, hours, ot_hours, labor, labor_basis: 'pay_report'|'trailing_rate_estimate', ot_dollars (full 1.5x pay), budget_hours, budget_dollars,
  employees, days_with_labor, revenue_month, revenue_month_amount, revenue_allocated, revenue_month_basis, invoice_week, prior_revenue, prior_labor,
  prior_labor_basis: 'pay_report'|'job_cost', prior_sub, prior_sub_basis: 'job_cost'|'ap_distribution', delivery_model, sub_week, sub_week_basis,
  consumables_cost|null, consumables_basis|null, latitude, longitude, city, state_province }
LeadershipImportFile = { import_file_id, kind, file_name, origin: 'upload'|'inbox', status: 'loaded'|'failed'|'duplicate', rows_read, rows_loaded,
  companies: [], period_from, period_to, errors: [], uploaded_by, loaded_at }
```

Row rules (`mart.leadership_week`): labor, hours, OT hours and OT dollars come from the imported Pay
Report when it covers every passed day of the company's week, else from `mart.job_week` (trailing-rate
labor; OT dollars estimated at 1.5x the straight-time rate). `revenue_month` = the latest month with
job-cost revenue before the month the week ends in; `revenue_month_amount` its revenue for the job.
`prior_labor` = the Pay Report total when it covers the whole month, else job-cost labor;
`prior_sub` = the greater of the job-cost subcontract line and AP distributions in the subcontract GL
range. A job with revenue in the revenue month has a row even without labor that week. `sub_week` is
vendor cost (a site without timekeeping takes the revenue month's subcontract cost apportioned by
days, basis `prior_month_prorated`). Accounts with `cost_basis = 'labor_plus_vendor'` are measured by
cost % = (labor + sub_week) / invoice (status and $ over target follow it; hours over target stay
labor-based); others by labor %, with vendor cost shown beside it. With `revenue_allocation =
'budget_hours'`, when the account's catch-all jobs carry revenue-month revenue and none of its sites
do (White Settlement ISD on job 112, Crowley ISD on job 910), that revenue is spread over the sites
present in the week by revenue-month budget hours, else revenue-month actual hours (migration 033,
computed at read time): `revenue_month_amount` and `prior_revenue` include it and
`revenue_allocated` shows the amount moved onto (+) or off (-) the row, `allocation_weight` the weight used
(`budget_hours` | `actual_hours` | `week_hours`, null when nothing moved). `PUT /leadership/accounts/{slug}` also accepts `revenue_allocation` and `cost_basis`.

## Relay (FedEx) feeds, added 2026-09-24

The dashboard pulls Relay's (integration_mapper) read-only export (`GET /export/dashboard/{ap,ar,sites,work-orders}`,
bearer token; Relay `docs/DASHBOARD_EXPORT.md`) into `core.relay_*` snapshots (migration 034, `app/relay.py`), nightly
and on demand. Settings `RELAY_BASE_URL`, `RELAY_EXPORT_TOKEN` (server-side only).

| Route | Response |
|---|---|
| `GET /integrations/relay` | `{configured, base_url_host, feeds: [{feed: 'ap'\|'ar'\|'sites'\|'work_orders', rows, status?, completed_at?, error_message?}]}`. Never returns the token. |
| `POST /integrations/relay/sync?rebuild=true` (admin) | `{runs: [{feed, status, fetched, loaded, error?}], failed: [feed], marts: RebuildResult \| null}`. GET-only against Relay. 409 when not configured. A feed that returns no rows never empties a snapshot that has rows (that feed fails instead). |

Effects on `mart.leadership_week` for the WinTeam jobs Relay covers (never Sarus):
- `sub_week` = the week's service month (the month holding the week's Thursday) of Relay payables, excluding
  self-perform legs, spread by days: actual when at least 90% of the site contract is invoiced or there is no
  contract (`sub_week_basis` `relay_ap`), else the contract amount (`relay_contract`); Crane's own sites carry
  none (`relay_self_perform`).
- `prior_sub` = the greater of job cost, WinTeam AP distributions and Relay payables (`prior_sub_basis` `relay_ap`).
- `revenue_month_amount` / `prior_revenue` come from Relay AR when job cost does not cover the month
  (`revenue_month_basis` `relay_ar`).
- `delivery_model` falls back to Relay's self-perform flag.

`GET /leadership/sites/{company}/{job}` and `GET /leadership/vendors` invoice lines gain `source`
(`winteam` | `relay`), and for Relay lines `service_month`, `status`, `in_winteam`, `payment_status`; a Relay payable
already among the WinTeam lines (same vendor and invoice number) is not repeated.

## Sign-in users, added 2026-09-28

Sign-in itself (`/auth/login`, `/auth/logout`, `/auth/me`, `/auth/mode`) is described in
`docs/auth-rbac.md`. Users created in the dashboard live in `ops.app_user` (migration 035).

| Route | Response |
|---|---|
| `GET /auth/setup` | `{needed}`: true while `APP_SETUP_TOKEN` is set and no database or `APP_USERS_JSON` user exists. Public. |
| `POST /auth/setup` | Body `{token, username, password}`. Creates the first administrator and sets the session cookie; `201 {user: {username, role}}`. `404` without a setup token, `409` once any user exists, `401` for a wrong code, `422` for an invalid username or a password under 10 characters. Public. |
| `GET /users` | Admin. `{users: [{username, role, active, source, created_at, created_by, last_login_at}]}`; `source` is `database`, `environment` (`APP_USERS_JSON`, read-only) or `development` (dev mode). Never returns hashes. |
| `POST /users` | Admin. Body `{username, role, password}`; `201 {user}`. `409` when the name exists (any case) or is an environment user. |
| `PATCH /users/{username}` | Admin. Body any of `{role, active, password}`; `{user}`. `409` for an environment user or when the change would leave no active administrator; `404` for an unknown user. A password reset refuses every session issued before it (the administrator resetting their own password gets a fresh cookie). |

## Staffing requests and the sync schedule, added 2026-09-29

**PhotoValidation feed.** The worker pulls PhotoValidation's staffing request lines (Contract B,
`GET {PHOTOVALIDATION_API_URL}/api/v1/staffing-requests?updatedSince=&page=&limit=500`, bearer
`PHOTOVALIDATION_API_TOKEN`) every `PV_SYNC_INTERVAL_MINUTES` (default 15, 0 = off) into
`core.fact_staffing_request` (migration 041, `app/sources/photovalidation.py`), upserted by `line_id`.
`updatedSince` is the largest `updated_at` held; within a pull the cursor moves to each full page's last
`updatedAt`. Lines resolve to a job through the WinTeam job number and database: `Crane` through
`mart.v_api_job_map` (never a Sarus row; the namespaced `Crane:<n>` row on a collision), `Sarus` through
`mart.v_sarus_job_map`; unmapped lines are kept with no job. Nothing runs without both variables.

**Weekly demand.** `mart.job_week` gains `requested_headcount` (sum of `headcount_needed` over lines
approved or posted) and `pending_requested_headcount` (lines submitted and undecided), each read at the
end of the week (Monday 00:00 UTC after it) or now for the week in progress, from the line timestamps: a
line is pending from `submitted_at` until `decided_at` (or `closed_at` when withdrawn undecided), and
active from its approval (`decided_at`, else `posted_at`) until `filled_at` or `closed_at`. The week in
progress therefore equals the current state; past weeks keep the demand that was open then. Both are
null until the feed first loads. Refreshed after every pull and at every mart rebuild.

**WinTeam interval.** Every `WINTEAM_SYNC_INTERVAL_MINUTES` (default 30, 0 = off) the worker runs
`sync_all(resources=[jobs, timekeeping])` for the primary database and, when enabled, Sarus: never
forced, so timekeeping re-reads 3 days before its last sync and jobs are re-read at most once per 20
hours; everything else waits for the nightly run. A database is due when its last timekeeping sync
(from any trigger) started an interval ago. One mart rebuild follows when anything was normalized.
Every WinTeam sync (nightly, interval, Admin) holds one Postgres advisory lock; the Admin routes answer
409 while it is held and the worker skips to its next tick.

| Route | Response |
|---|---|
| `GET /staffing/jobs/{company}/{job_number}?week=` (analyst, admin) | `{source, configured, as_of, week, requested_headcount, pending_requested_headcount, lines: [StaffingRequestLine]}`. `company` and `job_number` as in `GET /leadership/sites/...`; `week` = any date in the week (default this week); the headcounts follow the `mart.job_week` rule for that week (null before the feed loads). Lines: open first, then newest submission; at most 200. `as_of` = the last successful pull. 404 for an unknown job. |
| `GET /integrations/photovalidation` | `{configured, base_url_host, interval_minutes, watermark, lines, mapped_lines, open_lines, last_run: {status, started_at, completed_at, records_fetched, records_inserted, error_message} \| null}`. Never returns the token. |
| `POST /integrations/photovalidation/sync` (admin) | `{run_id, status: 'succeeded' \| 'failed', since, fetched, loaded, rejected, job_keys_changed, job_week_rows_changed, error?}`. One incremental pull, then the job resolution and `mart.job_week` demand refresh (no mart rebuild). GET-only against PhotoValidation; 409 when not configured or while another pull runs. |

```
StaffingRequestLine = { line_id, request_id, request_code, site_name, role, shift: 'day'|'swing'|'night'|'weekend'|'other',
  shift_start, shift_end, headcount_needed, current_filled, reason, employment_type, hours_per_week, pay_rate (USD per hour),
  needed_by, status: 'submitted'|'approved'|'posted'|'filled'|'rejected'|'cancelled', hire_job_id, reported_headcount,
  submitted_at, decided_at, posted_at, filled_at, closed_at, updated_at, days_open (submission to fill or close; to now while open) }
```

Pulls are recorded in `ops.integration_sync_run` as integration `photovalidation`, so `GET /leadership/config`
`status.syncs` reports them.

