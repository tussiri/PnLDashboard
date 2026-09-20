# Forecasting engine v2 and the labor pace model

Last updated: 2026-09-02. Engine version `v2.0-northstar`.

Two separate features, deliberately kept apart (HANDOFF rule 8):

| Feature | Module | Writes | Reads through |
|---|---|---|---|
| Governed site/portfolio forecast | `services/api/app/forecasting.py` | `mart.forecast_run_meta`, `forecast_output`, `forecast_track_record`, `forecast_accuracy`, `forecast_series_status` | `GET /api/v1/forecasts*` |
| Month-end labor pace projection | `services/api/app/pace.py` | nothing (computed per request) | `GET /api/v1/labor/pace` |

The engine is a port of the Finance_Reporting v2 "trust layer" (`apps/api/app/forecasting.py`).
The pure computation (`compute_forecasts` and its helpers) is unchanged in method; only the
IO boundary changed. Nothing in the browser computes a forecast.

## 1. Governed forecast

### Inputs

- `mart.job_month`: one row per job and service month with `revenue` (AR `revenueTotal`
  attributed to the service month), `gross_profit` (revenue - labor - burden), `labor_cost`
  (timekeeping hours x rate), `subcontract_cost` (job-cost P&L subcontractor line; finance
  reference source only), `delivery_model`, `parent_account`, `job_name`,
  `data_quality_status`. `delivery_model` and `parent_account` are copied onto every output
  row's `quality_meta` so the API serves them without a join.
- `mart.portfolio_month`: monthly totals; used only by the closure gate.
- `core.dim_job` (current rows, `valid_to IS NULL`) to attach `job_key` to output rows. Jobs
  in the mart without a current dimension row are still forecast; their `job_key` is NULL.
- `ops.app_setting.close_lag_days` (default 5).

Periods are `YYYYMM` integers inside the engine and `date` (first of month) in the database;
`shape_run` / `load_site_rows` convert at the boundary.

### Metrics

`revenue`, `gross_profit` (as the original), `labor_cost` and `subcontract_cost` (added
here with the same machinery). A month is a valid point for revenue and gross profit when
`revenue > 0`, for labor cost when `labor_cost > 0` and for subcontract cost when
`subcontract_cost > 0`; zeros are treated as data gaps, not real zeros, and are listed in
each row's `excluded_months` with the reason `zero_<field>_assumed_gap`.

**Subcontract cost.** The series exists only where the job-cost P&L carries a subcontractor
line for the site, i.e. the `finance_reference` source (migration 005). For the WinTeam API
source AP invoices are not job-linked, `subcontract_cost` is zero everywhere, every site is
gated out as `insufficient_history` for that metric and no portfolio row is published for it.
The metric is stored under the same `mart.forecast_output.metric` column (migration 006
widens the CHECK constraint). A self-perform site has no subcontract series (status, not a
zero forecast); a subcontracted site usually has both a subcontract and a labor series when
some labor is still self-performed. Bounds are clamped at zero like revenue and labor.

### Gates (before anything is fitted)

1. **Closed month.** A month is closed when `month_end + close_lag_days < today` AND the
   portfolio carried revenue in that month. Open months are excluded with reason `not_closed`.
   (The original inferred closure from job-cost import batches; there is no such signal in
   the WinTeam API, so the lag rule replaces it. It is recorded in `run_meta.gates`.)
2. **Tripwire.** Among closed months, portfolio revenue or reporting-site count falling more
   than 40% below the trailing median of accepted months marks the month `suspect` (the
   partial-import signature). Upward moves are never flagged. Suspect months are excluded
   from fitting and listed in `run_meta.dataset.suspect_periods`.
3. **Latest closed month** = the newest closed, non-suspect month. Every published row shares
   this `basis_month`, so the portfolio row is always the sum of same-month site rows.
4. **Identity.** When a job number's name changes to something with token-set similarity
   below 0.30 (a recycled job number), only the segment after the last break is fitted and the
   row's `identity` block records `break_month` and `prior_name`.
5. **Series status instead of a forecast** (`mart.forecast_series_status`):
   `insufficient_history` (< 4 valid closed months), `stale_data` (1-2 months behind the
   latest close; contributes its last value to the portfolio total) or `inactive` (> 2 months
   behind; contributes nothing).

### Candidates and selection

- `naive` - last closed month; `recent3` - median of the last three; `damped_trend` -
  Theil-Sen robust slope with fixed damping 0.9; `contract_flat` - when the recent tail is
  the same figure every month (within 0.5%).
- Selection is a one-step walk-forward backtest over the series' own history. The simpler
  candidate wins unless a more complex one beats it by more than 10% MAE. Fewer than six
  points, or fewer than two one-step tests, forces `recent3` (a trend cannot be validated).
  The scores are stored per row in `method_selection`.

### Intervals

- Nominal 80% band (10th-90th percentile) from **measured** walk-forward errors, scaled by
  each series' median size, collected **per horizon** (1-3 months) and pooled per metric and
  volatility class (`flat` / `stable` (CV < 15%) / `volatile`). A class pool with fewer than
  20 errors falls back to all sites. A series with at least 6 own errors can only widen its
  band. Bands are forced to widen weakly with horizon.
- Flat series additionally carry measured **disruption** statistics (how often historically
  flat sites changed and by how much) so a fixed-fee site never shows a bare +/-$0 claim.
- `revenue`, `labor_cost` and `subcontract_cost` bounds are clamped at zero; `gross_profit`
  may be negative.
- Portfolio = sum of active site forecasts + last value of stale/short-history sites. Its band
  comes from portfolio-level backtest errors (full observed range below 10 errors, quantiles
  from 10). A damped-trend challenger on the total is recorded in `run_meta.portfolio` for
  reconciliation; it is never published as the forecast.

### Coverage and track record

Every historical walk-forward call is written to `mart.forecast_track_record` with its final
band and the actual, and `interval_hit` says whether the band contained it. Run-level
coverage per metric and horizon is in `run_meta.coverage`. Per-series accuracy
(`mart.forecast_accuracy`: median APE, MASE vs naive, coverage) is published only with
three or more backtests; the portfolio claims no self-coverage because its band is built from
the same errors.

### Provenance and run history

- `mart.forecast_run_meta`: `engine_version`, `target_name = site_monthly`,
  `horizon_months = 3`, `latest_closed_month`, `status` (`running` -> `validated`),
  `initiated_by`, `assumptions` (jsonb `{"items": [...]}`), `dataset`, `gates`, `coverage`,
  `disruption`, `portfolio`, `metrics`.
- `mart.forecast_output` per row: `input_periods` (ISO months), `excluded_periods`
  (`[{month, reason}]`), `model_scores`, `interval_source`, `feature_snapshot` (interval
  meta), `disruption`, `identity_meta`, `quality_meta`, `engine_version`.
- A build is one transaction: meta inserted as `running`, all rows inserted, then the run is
  marked `validated`. Failure rolls the whole run back. Older validated runs remain as history;
  runs beyond the newest 10 are pruned. Source data in `core`/`mart` is never modified.
- The API serves only `mart.v_forecast_latest_run` (newest validated run).

### Triggers

`POST /api/v1/forecasts/rebuild` (admin token) and the mart rebuild path
(`POST /marts/rebuild`, full sync) call `forecasting.build_forecasts()`. A request never
computes a forecast.

### Account aggregation (`GET /forecasts?account=X`)

The engine publishes site rows and one portfolio row (`__ALL__`). It does not publish account
rows: an account total is derived at read time by `forecasting.aggregate_account` (pure; unit
tested) from the account's site rows in the latest run.

- With `account` set the `__ALL__` row is **omitted**. Before 2026-09-02 it was returned first
  and flagged `portfolio_unfiltered`, and the account page headlined the whole portfolio
  ($6.98M) as the account's number. Instead an `__ACCOUNT__` row (job_name = the account) leads,
  one per horizon: `point` / `lo` / `hi` are the sums of that account's forecast site rows for
  the horizon, method `sum_of_site_forecasts`, bands forced to widen weakly with horizon and
  clamped at zero for the non-negative metrics. The band is the sum of the site bands, which
  assumes site errors move together; it is a conservative (wide) range, not a measured
  account-level backtest. No `accuracy` is claimed for it.
- `account_summary` describes what the sum covers: `sites_total` (the account's jobs in
  `mart.job_month` in the run's last closed month), `sites_forecast`, `sites_not_forecast`
  (jobs with a series status for the metric and no forecast), `self_perform_sites` /
  `subcontracted_sites` (by `delivery_model` in that month), `last_closed_month`,
  `last_closed_actual` (`revenue`, `labor_cost`, `subcontract_cost`, `gross_profit` summed
  from `mart.job_month` for the account and month) and `forecast_coverage_pct`.
- `forecast_coverage_pct` = (last-closed value of the metric's gate field over the sites that
  have a forecast) / (the account's last-closed value of that field) x 100. The gate field is
  `revenue` for `revenue` and `gross_profit`, `labor_cost` for `labor_cost`,
  `subcontract_cost` for `subcontract_cost` (`coverage_basis` names it). `null` when the
  account had nothing in that field in the last closed month.

**Coverage caveat.** Sites that are gated out (`insufficient_history`, `stale_data`,
`inactive`) contribute **nothing** to the `__ACCOUNT__` row, whereas the portfolio row carries
stale and short-history sites at their last value. An account whose sites are mostly gated
out therefore has a low `forecast_coverage_pct` and its aggregate **understates the account**
by roughly the uncovered share. Example on the reference data: FedEx has 316 jobs in the
2026-07 close and 48 forecast revenue sites summing to about $980K at horizon 1 against
$992K of last-closed revenue; the row's `explanation` states the site count and the coverage
share so the page can say so next to the number. A low coverage is a data-history problem
(new or intermittently billed sites), not a model choice; do not scale the aggregate up.

`GET /forecasts/history?account=X` returns the account's own monthly history (sum of its
`mart.job_month` rows, `subcontract_cost` included); the `closed` / `suspect` flags are still
the portfolio-level gates the engine applied, so the account chart shows the same excluded
months the site forecasts excluded.

## 2. Month-end labor pace (`/labor/pace`)

Simpler arithmetic, separate from the engine, one row per scope (portfolio, optional parent
account, optional job):

- `as_of` = min(today, last work date with data in the month, month end);
  `days_elapsed` = its day of month.
- **Primary** `day_of_week_weighted`: `projected = labor_to_date x W_total / W_elapsed`,
  where W is the scope's own average daily labor per ISO weekday over the 90 days strictly
  before the month (no leakage). Labor is day-shaped; calendar proration silently assumes the
  remaining days look average.
- **Fallback** `calendar_proration` when the scope has no trailing profile;
  `projected_calendar` is always reported so both gauges are visible.
- `budget` = sum of `mart.job_month.budget_labor` for the month in scope;
  `budget_to_date = budget x days_elapsed / days_in_month`; `jobs_with_budget` vs
  `jobs_with_labor` shows budget coverage.
- **Measured range**: the scope's own prior complete months (up to 12, data reaching the
  last week of the month) replayed through the calendar gauge at day 7/14/21/28; readings
  within +/-0.15 of today's elapsed fraction give `final / projected - 1`. `range_lo` /
  `range_hi` are the 10th/90th percentile applied to the projection (never below labor
  already spent) when at least 5 readings exist, otherwise null with `range_n` reported.
- Once `as_of >= month_end` the month is complete: projection = actual,
  `projection_method = none`, `month_complete = true`.

## 3. Deliberately not modelled

- **Seasonality.** Twelve months is a single cycle; revisit at 24+ months of closed history.
- **Contract wins, losses, pipeline.** The roster is assumed unchanged.
- **Subcontractor cost by job for the WinTeam API source.** WinTeam AP invoices
  (`/accounts/v1/api/payables/invoices`) are not job-linked in the documented API, so with
  that source the `subcontract_cost` metric is empty (see Metrics); portfolio AP totals are
  reported in `/ap/summary` as observed actuals only. With the finance reference source the
  job-cost P&L provides the site series and it is forecast.
- **Account-level backtests.** The `__ACCOUNT__` band is the sum of site bands, not a
  measured account error distribution.
- **External events / news signals.** Would need provenance, effective dates, review status
  and an incremental backtest against a no-news baseline before touching production.
- **Overtime premium.** `/labor/summary.kpis.overtime_cost_estimate` is
  `overtime_hours x average rate x 0.5`; the timekeeping feed does not carry the paid premium.

## 4. How the browser must label it

- Every forecast number is a **governed model forecast anchored on `basis_month`** (the last
  closed month), not a budget, not a browser scenario, not an actual. Show `basis_month`,
  `engine_version` and the run's `generated_at` next to the numbers.
- Lead with horizon step 1; show the 80% band as a measured range ("from N backtest errors",
  the row's `interval.n_errors` and `interval.source`), never as a confidence guarantee.
- Show `not_forecast` series with their status and reason instead of hiding them.
- For flat sites, surface the disruption sentence in `explanation`.
- With an `account` filter there is no portfolio row. Headline the `__ACCOUNT__` row and
  show `account_summary.forecast_coverage_pct` with `sites_forecast` / `sites_total` next to
  it; when coverage is low say the aggregate understates the account rather than presenting
  it as the account's forecast. `delivery_model` on each row and on `not_forecast` entries
  lets the page separate self-performed from subcontracted sites.
- `metric=subcontract_cost` returns rows only when the reference source is primary; with an
  empty result say the metric is not available for the WinTeam API source.
- `source.mode = "empty"` or `run = null` means no run exists: show the labeled demo data and
  say so (HANDOFF rule 9).
- The pace panel is a projection of the current month's labor at the measured pace; label the
  method (`projection_method`) and show `range_n` with the range.
