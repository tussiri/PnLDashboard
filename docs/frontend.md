# Crane IFS — frontend architecture

React 18 + TypeScript + Vite. The browser talks only to the reporting API described in
`docs/api-contract.md` (`/api/v1`), never to WinTeam. Everything in `src/` is written once
against the contract types; a demo adapter fills the same shapes from seed data when the API
is unreachable or the marts are empty.

## Layout

```text
src/
  main.tsx                    bootstrap
  App.tsx                     hash routing, providers, shell (Sidebar / TopBar / FilterBar / banners / toasts)
  types.ts                    PageKey, GlobalFilters, seed JobSite (demo + scenario engine only)
  utils.ts                    formatters (money, percent, pts, number, fmtDate, relativeTime, csv-safe helpers)
  services/
    apiTypes.ts               typed contract (snake_case wire shapes)
    api.ts                    LiveApi: fetch client, ApiError, X-Admin-Token (memory only), AbortSignal, ratio→points normalizer
    demoApi.ts                DemoApi: synthesizes every contract response from src/data/seed.ts
    dataSource.ts             the seam: DashboardApi, decideMode / detectMode, apiFor(mode)
    queryClient.ts            in-memory cache, request de-duplication, ref-counted abort, invalidation
    period.ts                 MTD/QTD/YTD/T12M resolution, prior range, range labels (mirrors the server rule)
    csv.ts                    toCsv / downloadCsv
    aging.ts                  pure "collectible only" view of /ar/aging (finance reference source)
    forecastEngine.ts, eventSignalService.ts   browser-only scenario demo (never a governed forecast)
    adapters.ts, dataMart.ts, dataverse.ts, metabase.ts, winteam.ts, platformApi.ts   legacy boundaries kept for HANDOFF references
  hooks/useApiQuery.ts        loading / error / stale / fetching state over queryClient
  context/DashboardContext.tsx  mode, api, filters (persisted), dimensions, resolved range, navigation, toasts
  components/
    AppShell.tsx              Sidebar, TopBar (data-status pill), FilterBar (period tabs, month picker, dimensions)
    CardState.tsx             Skeleton, CardError (+retry), CardEmpty, StaleChip, QueryCard
    DataGrid.tsx              sortable, sticky-header, keyboard-accessible grid with CSV export and paging
    ChartKit.tsx              ChartTooltip, LegendToggles/useSeriesToggle, axis defaults, palette
    Charts.tsx                PerformanceTrend, GroupBars, MarginScatter, AgingBars, CostMix
    KpiCard.tsx, ChartCard.tsx
    OperationsMap.tsx         Leaflet map (clusters, heat modes, base layers, dynamic plugin loading) fed by JobRow
    ForecastingDashboard.tsx, LaborDashboard.tsx   scenario sandbox / legacy seed labor view
  views/                      one file per PageKey (+ JobDetail, shared helpers)
  data/seed.ts                seeded sites + deterministic 24-month demo dataset
  styles.css                  original block + appended, organized sections
```

## The data seam

`DashboardApi` (in `services/dataSource.ts`) has one method per contract route with the
signature `(params?, signal?) => Promise<ContractShape>`. Two implementations:

- `LiveApi` = `services/api.ts`. Base URL is `import.meta.env.VITE_API_BASE_URL || '/api/v1'`.
  Errors throw `ApiError { status, detail, path }` (`status === 0` = network/timeout). Admin
  calls send `X-Admin-Token` from an in-memory value set with `setAdminToken()`; it is never
  written to storage. Every call accepts an `AbortSignal`.
- `DemoApi` = `services/demoApi.ts`. Builds every response from `data/seed.ts`
  deterministically (24 closed months per site, a partial in-progress month, open invoices,
  AP ledger, employees, forecast run with bands and track record, pace rows). Every payload
  carries `source.mode = "empty"` and the views render a "Demo data" notice.

### Mode selection (startup)

`detectMode()` calls `GET /system/status` once:

| Result | Mode | Banner |
|---|---|---|
| ok and `marts.job_month_rows > 0` | live | none |
| ok but marts empty | demo | "No WinTeam data synced yet — showing labeled demo data" |
| request fails (no API) | demo | "API unreachable — demo data" |

The pure rule is `decideMode(status, error)` (unit tested). In live mode the status is
refreshed every 60 s for the TopBar pill, which names the source that filled the marts
(`source.primary_source` from the latest reporting payload, falling back to the single
enabled source with records in `/system/status.sources`):

| Primary source | Pill | Footer |
|---|---|---|
| `finance_reference` | `Live · WinTeam exports (Finance reference) · AR as of Aug 10, 2026` | same line + "reporting marts · no raw WinTeam payloads reach the browser" |
| `winteam_api` | `Live · WinTeam API · synced 12m ago` | `Live · WinTeam API · reporting marts · …` |
| not reported | `Live · synced 12m ago` | `Live · reporting marts · …` |

`Stale · …` replaces `Live` when `source.stale` is set or, for the WinTeam API source only, when
the sync is older than 24 h (a loaded reference snapshot is not a feed, so its age never makes
it stale). `Live · status unavailable` and `Demo data` are unchanged. The tooltip lists the
primary source, `as_of`, `latest_month`, `synced_at`, marts rebuilt and the forecast run.

When the API is reachable but the marts are empty (`marts_empty`), the views run on demo data
while Administration still calls the real API (`LiveApi`) so "Load real data" / "Sync all" can
fill the warehouse; a successful admin action re-runs detection (`redetectMode()`) and the app
switches to live without a reload.

Cache keys are prefixed with the mode (`live/…`, `demo/…`) and the cache is cleared on a mode
change, so a demo payload can never render inside a live card.

### Ratios vs percentage points

The live API returns ratio fields as fractions (`gross_margin_pct: 0.39`, `pct_over: -0.046`,
`variance_pct`, deltas, `target_labor_pct`) while the contract examples, the demo adapter and
every view use percentage points. `api.ts` converts the fields listed in `RATIO_FIELDS` once at
the boundary, by explicit name (never by magnitude). If the server ever switches to points, edit
that set. `accuracy.coverage` and `interval.*` stay fractions and are formatted where displayed.

## Querying

`useApiQuery(key, fetcher, deps)` returns `{ data, error, loading, stale, fetching, refetch }`.
Behaviour: concurrent callers with the same key share one request; unmounting detaches the
caller and the request is aborted only when the last subscriber leaves; cached data older than
60 s is served immediately and refreshed (`stale`); a failed refresh keeps the prior data and
exposes the error; `refetch()` invalidates the exact key. Views use `useReportQuery(route,
fetcher, params)` from `views/shared.tsx`, which namespaces the key by mode and reports the
response `range` / `source` back to the FilterBar and status pill.

Every card is a `QueryCard`: skeleton while loading, explicit error with Retry, empty state with a
one-line explanation, chart otherwise. Nothing shows a full-page spinner after boot.

## Filters and periods: scope-first (rewritten 2026-09-09)

The analysis views open on the **key accounts** and reach the long tail by drill-down. The old bar
showed seven equal-weight dropdowns and defaulted to every account; the key accounts hold most of
the revenue, so that was backwards.

### The filter model

`GlobalFilters` (`src/types.ts`):

| Field | Values | Default | Query param |
|---|---|---|---|
| `period` | `MTD \| QTD \| YTD \| T12M` | `YTD` | `period` |
| `month` | anchor month or `null` (= server default = latest closed month) | `null` | `month` |
| `scope` | `key \| all \| other` | **`key`** | `scope`, only when `account` is empty |
| `account` | one parent account, key or other ('' = use `scope`) | `''` | `account` |
| `subAccount` | second level under a key account | `''` | `sub_account`, only with an `account` |
| `delivery` | `all \| self_perform \| subcontracted` | `all` | `delivery`, omitted when `all` |
| `region` `branch` `serviceType` `vertical` `company` | exact-match dimensions, `''` = all | `''` | `region`, `branch`, `service_type`, `vertical`, `company` |

`filtersToQuery()` (`DashboardContext.tsx`) encodes the contract's precedence rules verbatim:
an `account` wins over `scope` (the API ignores `scope` then and echoes it as `account`),
`sub_account` is sent only alongside an `account` (the API answers 422 otherwise), and the default
`delivery: 'all'` is dropped. Options come from `GET /dimensions`
(`key_accounts[{name, label, sites, sub_accounts[]}]`, `other_accounts[{name, sites}]`, plus the
existing `accounts`, `regions`, … lists); the month picker labels in-progress / no-revenue months
from `dimensions.month_status`.

### The bar: one primary row, one collapsed secondary row

**Primary (always visible), fits one line at 1280px and wraps at 900px:**

1. period tabs + the resolved range ("Jan–Aug 2026 · 8 months") from the last response `range`,
   falling back to the client-side `resolveRange()` that mirrors the server rule;
2. **Scope** — one grouped `<select>` built by the pure helper `scopeOptions(dimensions)`:
   `Key accounts · N accounts` (the default, ungrouped and first), an optgroup **Key accounts** with
   each key account by `label` and site count, an optgroup **Everything** with `All accounts` and
   `Other accounts · N`, and an optgroup **Other accounts** listing the long tail by name. Option
   values are `scope:<mode>` or `account:<name>`; `selectedScopeValue()` picks the current one and
   `applyScopeValue()` applies it (choosing a scope clears the account, changing the account clears
   the sub-account). On an API build without `key_accounts` the helper falls back to
   `dimensions.accounts` so every account stays reachable;
3. **Month**;
4. **Sub-account** — rendered only when the selected account is a key account with **two or more**
   sub-accounts (`subAccountOptions()`); a stored sub-account the account no longer offers is cleared
   in `DashboardContext`;
5. **More filters** — the disclosure toggle, badged with `countSecondaryFilters()` so the number
   always matches what opening the row reveals.

**Secondary (`hidden` until the toggle opens it):** Delivery, Company (only when
`dimensions.companies` has two or more entries), Region, Branch, Service, Vertical, and **Reset**.
Reset returns to `defaultFilters` — scope `key`, not "all accounts". The toggle carries
`aria-expanded` / `aria-controls`, every select has an `aria-label`, and both rows are plain
form controls, so keyboard and screen-reader users get the same order they see.

`countActiveFilters()` is the total shown on Reset. The default scope `key` is the starting point of
every view and does **not** count; `scope: 'all' | 'other'` and an account drill-down do (once
between them, since they are mutually exclusive server-side), as do a sub-account, a non-`all`
delivery and each dimension.

### What each view states

`range.scope = {mode, label, accounts[], sites}` comes back on every reporting payload. Each filtered
view renders `<ScopeLine />` (`views/shared.tsx`) above its first card — "Key accounts · 5 accounts ·
14 sites" — reading the range the view reported to the shell, so it is silent on API builds that do
not send the block yet. `Financial.tsx` adds `<ScopeCoverageLine />`: when
`portfolio/summary.kpis.revenue_share_of_all` is present and below 0.99 it states one fact,
"Key accounts are 66.2% of all-account revenue for this range." (The `overview` route is the
executive Labor P&L replica, which has its own header and no global filter bar, so the coverage line
lives on the portfolio-summary view instead.)

`Customers.tsx` rows are accounts: clicking one sets the account drill-down and jumps to Sites, as
before. `Jobs.tsx` keeps its Delivery column filter but binds it to `filters.delivery` rather than
local state, so there is one delivery control state, not two.

### Storage and the v2 → v3 migration

Filters persist under `northstar-facilities-filters-v3`. `migrateStoredFilters(v3, v2)` reads v3 when
present; otherwise it migrates a stored v2 value once — its `account` becomes the account drill-down,
`scope` starts at the default `key` (v2 had no scope concept, and its "all accounts" default is
exactly what this change reverses), `subAccount`/`delivery` start at their defaults, and every other
field is carried across. `normalizeFilters()` rejects out-of-contract values and drops a sub-account
that has no account. Both helpers are pure and covered by `src/context/filters.test.ts`.

Filters are rendered only on views they truthfully affect (`portfolioFilterPages` in
`App.tsx`). Geography keeps its own local bar (period + account + local country/status).
Forecast, Reports, Data dictionary and Admin do not use them.

The demo adapter honours the same rules: `scope` defaults to `key` exactly as the server does (so a
demo call with no query is key-scoped), `sub_account` and `delivery` filter the seeded sites,
`/dimensions` publishes an invented but plausible key/other split (`DEMO_KEY_ACCOUNTS` in
`demoApi.ts`), and `/portfolio/summary` reports `revenue_share_of_all`. `/forecasts` is the one
exception: it has its own account selector and no scope control, so its portfolio row stays
all-accounts.

## Views → endpoints

| Route (`#/…`) | View | Endpoints |
|---|---|---|
| overview | Overview → ExecutivePL | executive/labor-pl, executive/accounts (see "Executive labor P&L" below) |
| financial | Financial | portfolio/summary, jobs |
| revenue | Revenue | portfolio/summary |
| expenses | Expenses (Cost analysis) | labor/summary, ap/summary, portfolio/summary (direct-cost breakdown), jobs |
| profitability | Profitability | portfolio/summary, jobs |
| labor | Labor | labor/summary, labor/pace |
| timekeeping | Timekeeping | timekeeping/summary |
| billing | Billing & receivables | ar/aging, ar/invoices (server paging, CSV export fetches all pages) |
| geography | Geography | jobs (OperationsMap on JobRow) |
| budget | Budget vs actual | budget/variance |
| jobs, jobs/{job_number} | Jobs grid, JobDetail | jobs, jobs/{n} |
| customers | Customers | accounts (row click sets the global account filter) |
| forecast | Forecast | forecasts (`metric`, `account`), forecasts/meta, forecasts/history, forecasts/track-record, forecasts/rebuild (admin) |
| alerts | Alerts | alerts |
| reports | Reports | (links to views) |
| data | DataDictionary | data/freshness (+ `sources`, falling back to system/status.sources), settings |
| admin | Admin | integrations/winteam, integrations/winteam/runs, integrations/finance-reference (+ POST …/load, 900 s timeout), settings, admin POST/PUT routes |

The Forecast view shows the governed run first (run badge, portfolio history + 3-month band,
site table with accuracy badges only when `n_backtests ≥ 3`, not-forecast list, track record,
assumptions, run metadata). The browser scenario engine lives below in a collapsed
`<details>` labeled "Scenario sandbox (browser demonstration, not a governed forecast)".

## Adding a view

1. Add the `PageKey` in `types.ts`, a nav entry in `components/AppShell.tsx` (`navGroups`,
   `pageMeta`) and the key in `validPages` / `portfolioFilterPages` in `App.tsx`.
2. Add any new route to `services/apiTypes.ts`, `services/api.ts` and `services/demoApi.ts`
   (the `DashboardApi` type is `typeof api`, so the compiler forces DemoApi to match).
3. Create `views/<Name>.tsx`: `const { query, params } = useReportingParams()` then
   `useReportQuery<Shape>('route', (api, signal) => api.route(query, signal), params)`, and
   render cards with `QueryCard`, `KpiCard`, `DataGrid` and the ChartKit primitives.
4. Register it in the `views` map in `App.tsx`.
5. Add a DemoNotice line so demo data stays labeled, and a test if you add pure logic.

## Running

- `pnpm dev` proxies `/api` to `http://127.0.0.1:15173` (override with `API_PROXY_TARGET`) so the
  browser runs in live mode against the local Docker stack. `NO_API_PROXY=1 pnpm dev` runs
  against the labeled demo dataset.
- `pnpm test` (vitest, no DOM needed) and `pnpm build` (`tsc -b` strict + Vite).

## Finance reference source (real WinTeam exports)

Everything the "Finance reference source" section of the contract adds is optional in
`apiTypes.ts` because the WinTeam API source omits it. Views branch on presence, never on
`primary_source`:

- **Cost breakdown** (`kpis` / `monthly` / `JobRow`: `payroll_ti_cost`, `subcontract_cost`,
  `supplies_cost`, `other_direct_cost`, `direct_cost`). `hasCostBreakdown(row)` (`Charts.tsx`,
  true when `direct_cost` is a number) switches Cost analysis to the direct-cost donut
  (`CostDonut`) plus the stacked monthly bars (`CostStack`), the Financial P&L to the itemized
  lines, and both views' notes to the P&L definition. `costLines` fixes the order and colours.
  Overview, Profitability and every margin use `gross_profit` exactly as delivered.
- **Company / delivery model / geo precision** (`JobRow.company`, `delivery_model`,
  `geo_precision`). Sites grid adds Company and Delivery columns plus a "Subcontracted" tag when
  any row carries them; JobDetail shows the facts and an "Approximate city-center placement"
  chip; `OperationsMap` labels city-center points in the tooltip, the aside and the corner
  summary. Geography counts sites without coordinates in the summary strip and lists them in a
  collapsible panel below the map instead of dropping them.
- **AR aging** (`as_of`, `collectible_open`, `by_customer.is_collectible` / `company`). Billing
  shows "Open receivables as of …", both totals, and a "Collectible only" toggle (default ON
  whenever `collectible_open` is present) implemented by `services/aging.ts`; the server-paged
  invoice list is not filtered by the toggle and says so.
- **AP** (`kpis.open_estimate` real, `by_vendor.open_balance` / `past_due`): shown as columns when
  present.
- **Budget** lines named `Subcontract` / `Supplies` render their actuals; the API source keeps
  the budget-only names.
- **Labor** shows `labor/pace.method_notes.labor_cost_basis` when present.
- **Admin** gains the "Finance reference (WinTeam exports)" card (`GET
  /integrations/finance-reference`: configured, host, coverage dates, last load with table row
  counts) and "Load real data" (admin token, confirm dialog stating it replaces every other
  source's data, 900 s timeout, toast with the loaded tables).
- **Data dictionary** lists the source runs for both sources and documents the revenue basis
  (job-cost P&L for closed months, AR invoices in progress) and labor basis (job-cost direct labor
  for closed months, hours × trailing job rate in progress).
- **Demo adapter**: derives company (three legal entities from region/country), delivery model
  (every seventh site subcontracted), geo precision (every fifth site `city_center`) and splits the
  seeded burden into the four non-labor lines so the identity `gross_profit = revenue − labor −
  burden` still holds; "Harbor Properties" is flagged non-collectible.

## Contract fields the UI needed but the contract text does not define

Derived client-side or typed from the live payloads; none were invented as server fields:

- `mart.v_ar_open` row columns (contract says "row"): typed from the live shape
  (`invoice_number, customer_number, customer_name, parent_account, job_number, job_name,
  invoice_date, terms, invoice_total, amount_paid, open_balance, collection_status,
  days_outstanding, aging_bucket`). No `due_date` exists; Terms is shown instead.
- `mart.job_month` row columns for `/jobs/{n}.history`: typed as the columns the contract uses
  elsewhere plus optional `data_quality_status` / `quality_notes` observed live.
- `AccuracyRow`: referenced but not defined; typed as `ForecastAccuracy` plus optional
  `metric`, `horizon_step`, `method`, `volatility_class`.
- `RunMeta.dataset / gates / coverage / disruption / portfolio` are `{}` in the contract; rendered
  generically. Live `coverage` is `{metric: {horizon: {n, coverage}}}` and is summarized per
  horizon.
- `GET /forecasts/meta` returns `{run, source}` live while the contract table shows a bare
  `RunMeta`; the client normalizes both to `{run}`.
- Percent field units (see "Ratios vs percentage points").
- `/forecasts?metric=` lists only `revenue|gross_profit`; the live server also serves
  `labor_cost` and `subcontract_cost`, which the metric switch offers. `/forecasts/history` rows
  carry `subcontract_cost` only when the source has the direct-cost breakdown; the chart shows an
  empty state for that metric otherwise (typed optional in `ForecastHistoryRow`).
- `/labor/pace` live adds `month_complete`, `method_notes`, `profile_weekdays`; shown when present.
- `/labor/summary` live adds `definitions`; shown when present.
- Gross-profit budget on the Financial view is derived client-side as budget revenue − budget
  labor − actual burden (the contract has no burden budget).
- `alerts[].metric_value` / `threshold` units vary by alert type; the `detail` string is shown.
- `/data/freshness` may carry `sources` (same shape as `/system/status.sources`); the Data
  dictionary uses it when present and otherwise the status payload. The finance reference
  `job_cost_months` pair and the snapshot dates are typed as nullable ISO strings.

## Forecast account aggregation, subcontract metric, AR cash application

Contract additions of 2026-09-02 (`docs/api-contract.md`, last section). All optional in
`apiTypes.ts` except the metric union.

- **Headline rows.** `/forecasts?account=X` omits the whole-portfolio `__ALL__` row and returns an
  `__ACCOUNT__` aggregate (job_name = the account, method `sum_of_site_forecasts`) first. The pure
  helper `headlineRow(rows, account)` in `views/forecastShared.tsx` picks the rows behind the point
  forecast cards: `__ACCOUNT__` when an account is selected, `__ALL__` for Portfolio, sorted by
  horizon. It never falls back to `__ALL__` under an account, so an older server that still returns
  the portfolio row yields "No account aggregate in this run" rather than the $7.0M portfolio point
  labeled as the account (the bug this fixes). `isAggregateRow()` keeps both aggregates out of the
  site table. Constants `PORTFOLIO_ROW` / `ACCOUNT_ROW` live in `apiTypes.ts`.
- **Account coverage card** (`account_summary`, `ForecastAccountSummary`): sites forecast / total,
  self-performed vs subcontracted counts, last closed revenue / subcontract cost / gross profit and
  `forecast_coverage_pct`. `coverageCaveat(pct)` returns the plain-language caveat when coverage is
  below `COVERAGE_CAVEAT_THRESHOLD` (80): sites gated out for short history are not in the total,
  so the aggregate understates the account by roughly the uncovered share. The card is rendered only
  when an account is selected.
- **Metric switch** gains "Subcontract cost" (`ForecastMetric` union; `metricLabel` drives the
  select and the JobDetail table). Series are gated server-side on subcontract cost > 0 in a closed
  month; self-performed sites appear in "Not forecast" with the reason.
- **Site table** shows a Delivery column (Self-performed / Subcontracted tag, from
  `ForecastRow.delivery_model`) whenever any row carries it, an Account column
  (`parent_account`) only when Portfolio is selected, and a Delivery filter in the grid toolbar.
  The not-forecast list appends the delivery model (`SeriesStatus.delivery_model`). The history
  chart and site-table titles name the account when filtered; `/forecasts/history?account=` returns
  the account's own history.
- **Billing & receivables** renders a "Cash application" section under the KPI row from
  `ar/aging.cash_application` (`ArCashApplication`): share of open invoices with any payment
  applied, open balance with nothing applied, of which over 90 days, oldest open invoice date and
  the server's `note` verbatim. `cashApplicationTone()` in `services/aging.ts` returns `warn` when
  `pct_with_payment_applied` is below `CASH_APPLICATION_WARN_BELOW` (25); the section then shows
  the amber warning "Aging likely overstates collectible AR if payments are not being applied in
  WinTeam." The receivables KPI subtitle starts with "As of {as_of}".
- **Overview** now also queries `ar/aging` (same dimension filters as Billing) so the Open AR KPI
  context reads "{DSO} days DSO · as of {date} · {pct}% with payments applied" when the payload
  carries them; each part is omitted when absent.
- **Demo adapter**: `forecasts({account})` builds the `__ACCOUNT__` row and `account_summary` from
  the seeded sites (coverage = last-closed revenue of forecast sites ÷ the account's revenue);
  `subcontract_cost` series come from the same burden split as the cost breakdown and are gated on
  delivery model; `forecastJob` returns only the metrics that pass the gate and lists the rest in
  `not_forecast`; `arAging` derives `cash_application` from the seeded invoices
  (`open_balance < invoice_total` = a payment was applied). `services/demoApi.test.ts` covers the
  shapes, `headlineRow`, `coverageCaveat` and `cashApplicationTone`.

## Executive labor P&L (the `overview` route), added 2026-09-03

`views/Overview.tsx` now renders `views/ExecutivePL.tsx`: a port of the executive team's standalone
"Amazon Labor P&L Dashboard" (`Finance_Reporting/Amazon_PL_Dashboard_v6_14_1.html`) for every
account. It is deliberately self-contained like the original - its own header, account + week
selects, tabs and footer - and does not read the global FilterBar. `EXECUTIVE_VIEW_KEYS` in
`views/shared.tsx` lists such views (`overview`) so the shell can subtract them from
`portfolioFilterPages` and stop rendering the FilterBar there (App.tsx change pending).

Endpoints (contract section "Executive labor P&L (weekly)"): `GET /executive/labor-pl?account=&weeks=18`
(`api.executiveLaborPl`) and `GET /executive/accounts` (`api.executiveAccounts`). The `week` query
parameter is not sent: the payload carries every week's rows, so the week select is client-side
and does not refetch. Business units, their colours and targets come from `business_units`; sites
per BU are derived from `rows`; nothing is hardcoded.

Files: `views/ExecutivePL.tsx` (header, tabs, states, footer), `components/executive/model.ts`
(pure port of the original's `buSum`, `fmt$`, `fmtH`, `pct`, `lpClass`, `lpLabel`, `wowSpan`,
`varBadge`, plus `WeekIndex` for O(1) week/BU lookups - unit tested in `model.test.ts`),
`components/executive/ExecChart.tsx` (Chart.js 4 via react-chartjs-2 - since 2026-09-04 the
shared chart system, see "Executive chart system"), `pieces.tsx` (badges, WoW arrows, KPI tiles),
`BuOverviewTab.tsx`, `BuSiteTab.tsx`, `OtAnalysisTab.tsx`, and `styles/executive.css` (the
original stylesheet scoped under `.exec-pl`; light palette by default, dark palette opt-in via
`.exec-pl--dark` or `.exec-pl--auto` because the shell has no dark theme).

What matches the original: layout (max-width 1180, 2-column BU cards, 1.6fr/1fr chart rows,
per-BU sparkline row, tables), typography (system font, 14px base, 11px uppercase card titles),
card borders/radii, badge and WoW arrow colours, chart options (tension 0.3, fills, larger point
for the selected week, labor % axis 40-90, `$k` ticks), the BU summary and site breakdown
columns, the OT Analysis tab, and the "~est" / "~" estimate markers.

What deliberately differs:

- **QA scores** are not in the warehouse (`qa` is always null): both QA cards render an honest
  "QA scores not connected" empty state at the original's height instead of a chart/table.
- **Elite** (a BU of the original) is absent because tabs and cards come from `business_units`.
- **Account selector** next to the week select ("All accounts" first, from `/executive/accounts`);
  the title reads "{Account} Labor P&L Dashboard" ("All Accounts …" for the portfolio).
- **OT hrs** = `ot_hours + dt_hours`; **OT cost** is the full OT pay (`otPayOf`, see "OT cost as full OT
  pay and all-in direct payroll" below), an informational line that is included in labor cost.
- The per-site trend card the original titled "Labor % of invoicing" actually plotted labor cost
  as a % of budget; it is titled "Labor cost vs budget — trend by site" here.
- The agency-sub dashed line / sub sparklines appear for any BU whose rows carry `sub_dollars`
  (the original hardcoded Crane West's LGB3/APC2/PSP3); estimated weeks are dashed and marked "~".
- **Partial weeks** (the in-progress week: its Monday + 6 days is past `as_of`, `isWeekInProgress`;
  a past week with fewer labor days is a complete week with fewer working days) stay selectable
  ("· partial" in the select) but are left out of every trend series so they never read as a cliff.
- **Footer** states the data source (`source` → "Demo data …" / the primary source label), the
  `as_of` date, the selected week's invoicing / labor-cost / budget bases with site counts, the
  number of sites with estimated agency sub, and the payload `notes` verbatim.
- Loading, error (+ Retry) and "no weekly labor rows" states exist; the original had none.

Demo adapter: `demoExecutiveLaborPl()` synthesizes 18 Monday-based weeks ending 2026-09-14 (the
in-progress week; `selected_week` = 2026-09-07) from the seeded month rows apportioned by calendar
days, grouped into Crane West (West region) / Crane IFS (other US) / Sarus (Canada) with the
seeded `bu_targets`; September rows carry `ar_invoice_prorated` / `trailing_job_rate` and
`sub_estimated`. `demoExecutiveAccounts()` lists the seeded accounts with site counts.

Business units are rendered in the array order the API returns (`visibleBusinessUnits()` in
`model.ts`; an optional `sort_order` on every entry is honoured when present) and limited to units
that have at least one row for the selected account and window, so an account never shows an empty
BU card or tab. Site pills on a BU card are capped at 12 with a dashed "+N more" pill (`capList`,
`PILL_CAP`); site tabs and tables are not capped. Rows that the live API marks
`invoicing_estimated` (basis `carry_forward`) get the "~" treatment on invoicing and a footer count.

Session gating: `DashboardContext` and `useReportQuery` read `useAuth().user`; without a session
neither `/system/status`, `/dimensions` nor any view query is issued (only `/auth/mode` and
`/auth/me`), and `ready` stays false.

Contract fields typed permissively: `ExecutiveAccount.sites` is `number | string[]` (the contract
says only `sites`); `ExecutiveLaborPl.qa` is `Record<string, unknown> | null`; live rows also carry
`invoicing_estimated`, `carry_forward_source`, `sub_basis` and the `carry_forward` invoicing basis
(typed optional). Demo BUs follow the seeded settings order Crane West, Crane IFS, Crane Southwest
(Southwest / Dallas branches), Sarus (Canada).

## Executive slicing: sub-accounts and delivery model (added 2026-09-04)

Contract section "Executive slicing: sub-accounts and delivery model". The executives asked for
three things: slicing to the second level under a key account (a school district, FedEx Express /
Ground), revenue and vendor cost per site (not only self-performed labor), and a self-performed vs
subcontracted view. Files touched: `views/ExecutivePL.tsx`, `components/executive/{model,BuOverviewTab,BuSiteTab}.tsx`,
`styles/executive.css`, `services/apiTypes.ts`, `services/demoApi.ts`; tests in `model.test.ts`.

Header controls, left to right: **Account** → **Sub-account** (rendered only when the selected
account has ≥ 2 `sub_accounts` on `/executive/accounts`; options "All {account}" plus each
sub-account with its site count) → **Delivery** (All delivery / Self-performed / Subcontracted) →
**Week**. `sub_account` and `delivery` go to `api.executiveLaborPl` as query params (`delivery` is
omitted when "all", `sub_account` is omitted without an account); the API does the filtering, so the
week select stays client-side. Changing the account resets the sub-account. The title reads
"{Account} · {Sub-account} Labor P&L Dashboard" when a sub-account is chosen; the footer scope line
adds "(subcontracted sites)" / "(self-performed sites)" when a delivery filter is on.

Types (`apiTypes.ts`): `ExecutiveDelivery = 'all' | DeliveryModel`; `ExecutiveLaborPlQuery` gains
`sub_account?` and `delivery?`; `ExecutiveAccount` gains `sub_accounts?: {name, sites, delivery?}[]`
and `delivery?: {self_perform, subcontracted}`; rows gain `sub_account?`; the payload echoes
`sub_account` / `delivery`. Everything is optional so the view still renders against the 2026-09-03 API.

Row semantics the UI now makes first-class (`model.ts`):

- `BuSum.labor` = direct (all-in payroll, OT premium inside) + **agency** sub on self-performed sites
  (`laborOf(row)`; 0 for a subcontracted site) - exactly the original "Labor cost incl. $X agency"
  figure. `BuSum.agency` = `sub_dollars` of self-performed rows (KM Group at LGB3 / APC2 / PSP3),
  `BuSum.vendor` = `sub_dollars` of subcontracted rows, `BuSum.sub` = both. `BuSum.dollars` = total
  cost = labor + vendor = `totalCostOf(row)` = `direct_dollars + sub_dollars` summed (computed
  client-side; the payload's `total_dollars` is not read, see "OT cost as full OT pay" below).
  `agencyEstimated` / `vendorEstimated` split the "~" flag. `selfSites` / `subSites` count sites by
  `delivery_model` (null = self-performed).
- **Labor %** = `laborPctOf` = labor ÷ `selfInvoicing` (the invoicing of the self-performed sites
  only), measured against the BU target with the original thresholds - the executives' original
  semantics for self-performed sites. Subcontracted sites are excluded from labor % entirely; Cost %
  and Margin cover them. A mixed BU's labor % is therefore never diluted by subcontracted billing.
- **Cost %** = `costPctOf` = total cost ÷ invoicing (null without invoicing, shown "—"), toned with the
  same BU bands. **Margin** = `marginOf` = invoicing − total cost (`marginPctOf` as % of invoicing;
  `marginTone`: negative bad, < 10 % watch). `fmtSignedMoney` keeps the sign ("−$1,235").
- `deliverySplit(rows)` → `{self, sub, total}` sums; `subAccountRollup(rows, prevRows)` groups by
  `sub_account` (rows without one fall under their account) with WoW total cost, ordered by invoicing.
- `WeekIndex.selfSites(bu)`, `subSites(bu)` (sites with vendor cost, unchanged) and `subAccounts()`.
- **Delivery is decided on evidence** (`normalizeDelivery`, applied once by `WeekIndex` with the payload's
  echoed `delivery` filter): a site that logged hours or direct dollars self-performs, whatever the
  job-level `delivery_model` says - the live marts label LGB3 / APC2 / PSP3 "subcontracted" because they
  buy agency labor, yet they log thousands of hours, and taking the label literally would drop them from
  Labor %. A site with no self-performed labor is subcontracted when the label says so, when it came
  through `delivery=subcontracted`, or when it carries vendor cost; otherwise self-performed. So under
  the Subcontracted filter a labelled site with hours (RCNC at FedEx) shows as self-performed with
  agency sub, and the Sites KPI still counts every row the API returned.

What the executives see:

- **BU cards**: with "All delivery" six KPIs (`.kpi6`, two rows of three) — Labor cost ("incl. $X
  agency ~est" as before, pp vs target), Invoicing (+ cost % of invoicing), Labor %, OT cost, **Vendor
  cost** (subcontracted sites' `sub_dollars`, "~est" when estimated, subcontracted-site count),
  **Margin** (signed, % of invoicing). With
  "Self-performed" the original four; with "Subcontracted" Sites + Vendor cost + Invoicing + Margin
  (no OT). The site-count tag adds "· N sub" when the BU has subcontracted sites.
- **Trend**: "Total labor % and cost % of invoicing — trend" plots Labor % (filled) and Cost % of
  invoicing (dashed purple) with a legend (Chart.js legend clicks toggle series); the labor line
  starts hidden under the Subcontracted filter. Per-BU sparklines add a Cost % line (hidden by default
  unless the BU has vendor cost) and label the right-axis vendor line "Vendor %". The OT trend shows an
  empty state under the Subcontracted filter.
- **BU summary table**: BU, Invoicing, Direct labor, OT cost, Agency sub, Labor $, Labor %, vs target,
  WoW pp, **Vendor cost, Total cost, Cost %, Margin**, WoW cost, Hours, OT hrs (labor columns hidden
  under the Subcontracted filter). Direct + Agency = Labor $; Labor $ + Vendor = Total cost. The OT
  cost column is the full OT pay and is already inside Direct labor (header tooltip says so), so it is
  not part of either sum.
- **Delivery mix — selected week**: one small table per BU (and "All business units" when there is
  more than one) with a Self-performed row (sites, hours, labor $, agency vendor cost if any,
  invoicing, cost %, margin), a Subcontracted row (sites, vendor cost, invoicing, cost %, margin) and a
  Total row; a note explains when a delivery filter narrows it.
- **By sub-account — selected week** (only when the account has ≥ 2 sub-accounts and none is
  selected): sub-account, sites (self / sub split), self-performed labor, vendor cost, total cost,
  invoicing, cost %, margin, WoW cost, plus a total row; sub-accounts with no rows this week are listed
  with their site count. Rows are buttons (click / Enter / Space) that select that sub-account.
- **Site tabs**: KPIs follow the delivery filter like the cards (six across with `.kpi-lg.kpi6` for
  "All delivery"); the site table gains Delivery (tag), Vendor cost, Total cost (was "Total labor"),
  Cost % and Margin, keeps Agency sub (a row's `sub_dollars` lands under Agency sub for a self-performed
  site and under Vendor cost for a subcontracted one), and shows "—" in Direct $, Labor %, Hours, WoW
  Hrs, OT Hrs, OT % and WoW OT for subcontracted sites. A toolbar above the table shows the self / sub site counts and a Delivery select
  bound to the same state as the header selector (changing it refetches). Sparkline cards: "Cost vs
  budget — trend by site" (was "Labor cost vs budget"), "Agency & vendor cost — trend by site" (was
  "Agency sub cost"; items are tagged agency vs subcontracted) and "OT cost — trend by site" (self-performed
  sites only).
- **Footer** explains the three ratios and counts sites with estimated vendor cost.

Demo adapter: `DEMO_SUB_ACCOUNT_RULES` mirrors the backend `sub_account_rules` — Summit Education →
"Front Range Unified School District" (DEN1) / "Gateway Public School District" (STL1); Apex Commerce
→ "Apex Fulfillment (APF)" (SEA1, PHX1) / "Apex Distribution (APD)" (CHI1), the FedEx Express /
Ground shape; Harbor Properties → "Harbor Office Fund I" (NYC1, DC1 — both subcontracted) / "Harbor
Office Fund II" (MSP1, TOR1). Other accounts have a single sub-account named after the account, so the
selector stays hidden. `demoDeliveryModelOf` (index % 7 === 3) marks NYC1, SF1 and DC1 subcontracted;
their weekly rows now carry zero hours / direct / OT and put the seeded labor line plus subcontract
share into `sub_dollars` (`sub_estimated` in the open month), with `budget_hours` 0. `demoExecutiveLaborPl`
honours `sub_account` (under an account only) and `delivery`, echoes both, and `notes[0]` states the
selected week's delivery split; `demoExecutiveAccounts` returns `sub_accounts` (sites desc) and
`delivery` counts. Demo checks: Summit Education → a district; Harbor Properties → Subcontracted.

## Executive chart system (curation of the Overview charts, added 2026-09-04)

Executive feedback on the first cut: the per-BU "Cost %" sparklines were tiny, the weekly x labels
("May 4, May 11, ...") overlapped in a rotated mess, the dual y-axes (Labor % left, agency/vendor %
right) confused, the July 2026 job-cost anomaly pushed Crane IFS to 200 % and flattened every other
BU, and subcontracted sites got labor sparklines that showed nothing. The charts were re-curated
around the dataviz rules (one axis per chart, fixed comparable domains, thin marks, recessive grid,
legend + table for every chart) without touching the shell, palette variables or typography.

Files: `components/executive/charts.ts` (pure helpers, tested in `charts.test.ts`), `ExecChart.tsx`
(the one Chart.js configuration + `CategoryBars`), `ChartCard.tsx` (card, expand dialog, weekly
table), `trends.tsx` (weekly series builder, delivery-aware `RatioTrendCard`, headline),
`BuOverviewTab.tsx` / `BuSiteTab.tsx` / `OtAnalysisTab.tsx` (rewired to the system), `styles/executive.css`
(appended "Chart system" block), `services/apiTypes.ts` (`vendor` block, optional), `services/demoApi.ts`
(demo vendor block + the July anomaly).

**`ExecChart`** (`ExecChart.tsx`), used by every trend:

- x axis: month names on the first week of each month only ("May", "Jun", "Jul", ...), never rotated
  (`monthTicks`; an empty tick label keeps the faint week gridline, the month boundary gets a slightly
  darker one; the first week is labelled unless the next month starts within 2 weeks - 3 on the narrow
  site cards; January carries its year; monthly series label every period).
- y axis: exactly one. Percent charts use a fixed **0-120 %** domain with ticks every 30 so every BU and
  site card is comparable (Crane IFS next to Sarus); values beyond it are drawn at the top with a small
  triangle in the series colour and the tooltip shows the real value "(above axis)" (`clampSeries`).
  Dollar charts get a nice-rounded 0-based axis (`niceDollarAxis`: 1/2/2.5/5 × 10ⁿ steps, 4-6 ticks,
  `$40k` / `$1.2M` ticks); a series with one runaway period is capped at 3× its median absolute value
  (`dollarClampMax`, symmetric for margins, ▲ / ▼ markers, "(below axis)").
- marks: lines 2 px, tension 0.25, no fill except a 10 % wash under the primary series; bars <= 24 px
  with 4 px rounded data ends square at the baseline; the selected week gets a vertical band and a 5 px
  point; the in-progress week is hollow on a dashed lead-in segment (hatched bar for a projected month);
  a target line is dashed grey and labelled at its right end ("Target 64.5%").
- tooltip: "Week of Aug 31 (· in progress)", every series' value with its WoW change (pp for ratios, %
  for dollars), extra lines (agency / vendor % of invoicing, margin, hours), "~est" when the week's
  invoicing or vendor cost is estimated, and the anomaly note.
- anomalies: a week whose Cost % exceeds 150 % gets a ring on the point and a tooltip line - "cost exceeds
  invoicing · July close carries flagged subcontract costs" for July 2026, "cost exceeds invoicing this
  week" otherwise (`anomalyNote`); the card footnote explains the ring and the clamp.
- decorations are an inline Chart.js plugin reading the latest props through a ref (react-chartjs-2
  updates charts in place, so plugin closures must not capture stale props); the surface / text / bad
  colours are read from the `.exec-pl` CSS variables at draw time so the dark palette works.
- series colours: BU colours come from the API; Cost % is `#6B4FBB`, OT `#E8593C`, AP / vendor `#B7791F`
  (the original `#F5A623` failed the palette validator's lightness and contrast checks), margin bars a
  muted `#8a94a6`. Every BU colour + Cost % pair passes the dataviz validator (`validate_palette.js`).

**`ChartCard`** (`ChartCard.tsx`): title (+ subtitle), HTML legend whose keys mirror the mark (line /
dashed / bar / hatched; shown for >= 2 series), the chart at >= 260 px (compact site cards 120 px, 168 px
for the two-panel cost + margin card), a note, and an **Expand** button (`aria-haspopup="dialog"`) that
opens a full-width `role="dialog"` / `aria-modal` overlay: the same chart at 480 px, the legend, the weekly
data table (sticky header, zebra rows, numeric columns right-aligned in tabular figures, percentages to
one decimal, currency without cents from $10k via `fmtCurrency`, "~est" flags, the anomaly note column)
and an **Export CSV** button (`weeklyCsv`: raw numbers, RFC-4180 via `services/csv.ts`). Escape or the
backdrop closes; Tab is trapped inside (`trapFocus`); focus lands on Close on open and returns to the
Expand button on close; body scroll is locked while open. The dialog renders inline under `.exec-pl`
(position fixed) so the executive CSS variables apply. `.chart-grid` is 2 columns from 1100 px, 1 below;
`.site-grid` is `auto-fill, minmax(220px, 1fr)`.

**Delivery-aware trend selection** (`trendKind`, `RatioTrendCard` in `trends.tsx`): a scope (BU, total or
site) with any self-performed hours gets the **labor** chart - Labor % of invoicing (BU colour, primary)
with the BU target and Cost % of invoicing (purple) on the same 0-120 % axis; agency % and vendor % live in
the tooltip and the expanded table, never on a second axis. A scope that is fully subcontracted (no hours
in any week) gets **"{scope} — Cost % and margin"**: two stacked single-axis panels, Cost % on top and
margin dollars as muted bars below (shared fixed y-axis width so the weeks align; the top panel hides its
x labels). Under the Subcontracted delivery filter every card takes the cost + margin form. The BU KPI
card also switches to the subcontracted KPI set (sites, vendor cost, invoicing, margin) when the BU has no
self-performed site in the week, instead of "Labor % 0.0 % on track".

**BU Overview cards**: "Labor % and Cost % of invoicing — all business units" (target = the average BU
target, labelled "Avg target"), "OT cost — trend" (dollars; empty state for scopes without hours), "Vendor
cost — actual vs projected" (full width; only when the payload carries `vendor`: bars for the closed
months' job-cost subcontract line, a hatched bar for the in-progress month's projection, a line for AP
subcontractor invoicing by month - labelled company-wide because WinTeam AP is not job-linked - plus the
text "AP invoiced this month to date $X through {date} · N invoices from M vendors (by vendor type) ·
company-wide. Projected {month} subcontract cost for this scope: $Y"; the runaway July bar is clamped with
a ▲), then one small multiple per BU ("{BU} — Labor %" or "{BU} — Cost % and margin"), all on the shared
0-120 % axis. The tables below the charts are unchanged.

**Site tabs**: "Weekly cost vs budget" is paired bars (budget in the BU colour at 44 alpha, actual in the BU
colour) with month ticks and a weekly table; "OT hours by site" uses `CategoryBars`. The per-site grids are
`ChartCard compact` cards (>= 220 px wide, 120 px chart) with a headline that carries the number even
without the chart - "61.2% labor · target ≤64.5% · +3.7 pp WoW · ~est" (`Headline`, `headlineValue`:
the selected week's value or the latest one, WoW vs the previous non-null week) - and a delivery tag:
"Labor % and cost % — trend by site" (self-performed sites: Labor % vs target; subcontracted: Cost % +
margin panels), "Cost vs budget — trend by site" (% of budget vs a 100 % "Budget" line), "Agency & vendor
cost — trend by site" (dollars), "OT cost — trend by site" (dollars). Each grid has a **Worst first / A–Z**
toggle (one sort state per tab; worst = highest headline value). The OT Analysis tab's stacked OT cost by
BU and per-site OT % cards (0-40 % domain, "Watch 8%" line) use the same system.

Removed: the rotated weekly tick labels, the dual-axis `yRight` vendor line, the 70 px `SparkItem`
sparklines (`pieces.tsx` no longer exports `SparkItem` / `SparkGrid`), and `idx.trend()`'s "leave the
in-progress week out" behaviour in charts (the week is drawn hollow instead; `WeekIndex.trend` still exists
for callers that want nulls). The footer sentence about in-progress weeks says so.

**Vendor block** (`ExecutiveLaborPl.vendor?: ExecutiveVendorBlock | null`, contract "Vendor cost: projection
and live AP look"): `month`, `month_status`, `as_of`, `projected_month_sub`, `projected_basis`,
`sites_projected`, `ap_live: {invoiced_to_date, invoices, vendors, through, by_vendor_type[]} | null`,
`history[]: {month, job_cost_sub, ap_subcontractor_invoiced, ap_all_invoiced}` (last 6 closed months).
Typed optional; the card renders only when present. Rows' `sub_basis` is now `'job_cost_month_prorated'` /
`'trailing_3mo_projection'` in the demo. The demo builds the block from the seeded job months and AP
ledger (`demoExecutiveVendor`; vendor types in `DEMO_VENDOR_TYPE`, two subcontractor-type vendors match
the default `subcontractor_vendor_types`; the in-progress month's AP is the August run rate × elapsed
days).

**Demo July anomaly**: `DEMO_ANOMALY_MONTH = '2026-07-01'`, `DEMO_ANOMALY_MULTIPLE = 10` - the Crane IFS
subcontracted sites (NYC1, DC1) carry a flagged duplicate subcontract posting in July 2026, so their Cost %
reaches ~400 % and Crane IFS ~185 %, which exercises the clamped axis, the ▲ markers, the anomaly rings
and the July note exactly as the real close did. `notes` says so. Checks: portfolio → BU Overview (Crane
IFS card rings in July, total clamped), Harbor Properties → Harbor Office Fund I (fully subcontracted:
cost + margin panels, OT empty state, subcontracted KPI set), Crane IFS tab (site grid with NYC1 / DC1 as
cost + margin cards, sorted worst first), any Expand button (dialog, table, CSV, Escape).

## Sign-in and roles (added 2026-09-03)

`src/auth/` owns authentication: `roles.ts` (role to visible routes, dev users, demo sign-in),
`authApi.ts` (`/auth/mode`, `/auth/me`, `/auth/login`, `/auth/logout`), `useAuth.tsx`
(`AuthProvider`, `useAuth`) and `LoginPage.tsx`. `App.tsx` renders the login page until a session
exists, then the shell; `Sidebar` shows only the routes of the signed-in role (`navGroupsFor`),
routes outside the role redirect to `overview`, executives get no FilterBar and a plain "As of" text
instead of the data-status pill. A `401` from any data route raises the `crane-ifs:unauthorized`
window event and returns to the login page. Without a reachable API the login page offers a
browser-only demo sign-in for the three development users. Server rules: `docs/auth-rbac.md`.

Copy rules (enforced by `src/copy.test.ts`): the product name is Crane IFS; no symbol glyphs in UI
copy (deltas and pagers use lucide icons); card subtitles carry only the range, units, basis and a
short definition; demo notices are one factual line. The executive view keeps its original copy.

## OT cost as full OT pay and all-in direct payroll (executive definitions, 2026-09-03)

Two corrections to the executive labor P&L, both verified against the executives' original
`Amazon_PL_Dashboard` file (v6_52): its "OT cost" is the **full overtime pay** (OT hours × rate × 1.5;
SBN1, week of Aug 24: 384.87 OT h → $9,944 ≈ $25.8/h), and its direct labor is **all-in payroll**.
The API rows carry `ot_dollars` = the OT **premium** only (OT hrs × rate × 0.5 + DT hrs × rate × 1.0)
and `direct_dollars` = payroll for every hour priced at the job's trailing payroll rate, which already
contains the overtime premium. Reading `ot_dollars` as "OT cost" showed ~62 % less than the
executives' file, and adding it to direct labor double counted the premium (~5 % of total cost). The
backend is changing `total_dollars` to `direct_dollars + sub_dollars`; the client no longer depends on
it.

Definitions in `components/executive/model.ts` (unit tested in `model.test.ts`):

- **`otPayOf(row)`** = `ot_dollars + (ot_hours + dt_hours) × (direct_dollars ÷ hours)` when `hours > 0`,
  else `ot_dollars` - the premium plus the OT hours at the site's own average payroll rate. SBN1's
  2,150.55 h / 384.87 OT h / $39,837.33 direct / $3,144 premium give ≈ $10,275 (the test asserts the
  formula and the $25-28/OT-hour band, not the exact dollar). `BuSum.otPay` sums it per scope;
  `WeeklySeries.otPay` carries it per week. `BuSum.otDollars` keeps the premium as sent (informational).
- **`totalCostOf(row)`** = `direct_dollars + sub_dollars`. `BuSum.dollars` sums it; the site table, cost
  vs budget cards, WoW cost and the OT tab's "OT % of labor" all use it instead of `total_dollars`, so a
  payload that still adds the premium into its total cannot double count.
- **`laborOf(row)`** = `direct_dollars + sub_dollars` on self-performed sites (0 when subcontracted): all-in
  direct payroll + agency sub. **Labor %** = labor ÷ self-performed invoicing, **Cost %** = total cost ÷
  all invoicing and **Margin** = invoicing − total cost follow from these; `ot_dollars` is never added.

What the executives see: every "OT cost" figure - BU card KPI (subtitle "full OT pay · included in labor
cost", tooltip with the 1.5× / 2× definition), BU summary table column "OT cost (full OT pay)" (header and
cell tooltips), "OT cost — trend" and "OT cost by BU — trend" (subtitle, tooltip line "Included in labor
cost", weekly table and CSV column "OT cost (full OT pay, included in labor cost)"), the OT Analysis KPIs
("Top OT site" reads "$X full OT pay"), the OT detail table (sorted by full OT pay; "OT % of labor" = full
OT pay ÷ total cost) and the per-site "OT cost — trend by site" cards - shows `otPayOf`. Labor cost,
total cost, Labor %, Cost % and Margin exclude the premium. The footer states both rules. The demo
adapter (`services/demoApi.ts`, untouched) still writes `total_dollars = direct + ot_dollars + sub` and a
straight-time `direct_dollars`; the UI ignores that total, so demo OT pay reads slightly under 1.5× and
demo labor cost excludes the premium - values follow the contract rules, not customer data.
