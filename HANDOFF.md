# Crane IFS dashboard — coding-agent handoff

Last verified: 2026-09-02

## Project purpose

Crane IFS (this repository) is a financial and operations dashboard for a national janitorial and
facilities-services business. It brings portfolio financials, labor, timekeeping, billing and
receivables, payables, site/account analysis, geographic operations, alerts, budget vs actual,
data governance, and governed forecasting into one React application backed by a PostgreSQL
warehouse that is fed from the WinTeam / TEAM Concourse `wtnextgen` API.

As of this handoff (2026-09-03) the platform runs end to end on real data from two sources that
share the same core/mart tables, combined by explicit precedence rules (`docs/winteam-live-source.md`):

- **winteam_api** (LIVE, production tenant, credentials in the server `.env` — never read or copy
  that file): jobs (643, exact coordinates), vendors, timekeeping (rolling window, ~8k punches a
  week), AP invoices and AR invoices with applied cash. Job schedules and AP payments answer 403
  (subscription not entitled) and are skipped; GL budgets answer 400/404 for jobs without a budget.
  Syncs run once a night (app/nightly.py, 02:30 America/Chicago, setting `nightly_sync`) and on
  demand (Administration page or the admin routes), then normalize and rebuild marts and forecasts. Inside the
  API's date window API rows are the truth for the companies the tenant serves (Crane IFS, Crane
  West, Crane Southwest); exports fill everything else (Sarus, and all history before the window).
- **relay** (integration_mapper, FedEx only): the read-only export of Relay, pulled nightly into `core.relay_*`
  (`app/relay.py`, migration 034). It carries FedEx subcontractor payables by WinTeam job and service month,
  FedEx AR with supersession applied, self-perform stations and contract amounts; the weekly mart prefers it
  for FedEx vendor cost and billing. Configure `RELAY_BASE_URL` and `RELAY_EXPORT_TOKEN` (one of Relay's
  `DASHBOARD_EXPORT_TOKENS`). The export itself is on Relay branch `feature/dashboard-export`.
- **finance_reference**: the WinTeam report exports restored from the Finance_Dashboard PostgreSQL
  dump (`finance_reference` database, read-only). It is the only source of the Job Cost Analysis
  P&L (revenue, direct labor, subcontract cost by site and month), daily labor budgets, and the AR/AP
  aging snapshots. Reload from the Administration page after restoring a newer dump.

Views (rebuilt 2026-09-23, plan in `docs/leadership-rebuild-plan.md`): a leadership labor P&L modeled
on the Plano ISD reference dashboard, dynamic by account.

- **Home**: portfolio strip across the featured accounts (Labor % with pp WoW, hours to cut per day, OT %,
  change vs prior week) and the reference Overview for the selected account.
- **Account**: one layout for every account, in its weekly report's words (`vocabulary`): Overview, Sites, Pallet (accounts with pallet jobs), Hours to cut / Over Target, Overtime, Income Statement (loaded or split accounts), Subcontracted Sites (accounts with subcontracted sites; AR vs AP), Map and the vendor invoice tab; a site row opens a drawer
  with the site's weekly P&L, a 13-week trend, subcontractor invoices and CompanyCam photos.
- **Analytics**: every account including Other, drilled account -> segment (Other: account group)
  -> site, with filters, sorting and CSV.
- **Admin** (admin role): accounts, segments and targets; job mapping (review queue, Other, role,
  CompanyCam project); export imports; sync runs and on-demand sync.

Account, week, target and open site live in the URL. Accounts are configuration, not code
(`ops.account`, `ops.account_segment`, `ops.account_job`; seed `config/accounts/seed.json`). Derived
metrics are computed in the browser by `src/leadership/metrics.ts`, pinned by tests to the reference
week (week ending 2026-09-20). Labor dollars come from the imported Pay Report when it covers the
week, else a labeled trailing-rate estimate (`docs/export-feeds.md`). Every role sees Home, Account
and Analytics; admins also see Admin.

The forecasting engine is the "trust layer" engine ported from the Finance_Reporting
(Crane IFS) codebase: closed-month gates, a one-sided anomaly tripwire, walk-forward selection
among naive / recent-median / damped Theil–Sen candidates, pooled empirical 80% intervals,
measured coverage, a materialized track record, and run-level assumptions stored as data. See
`docs/forecasting.md`.

## Permanent location

```text
/Users/tumainiussiri/NewDashboard
```

The reference implementation the models were ported from is
`/Users/tumainiussiri/Finance_Reporting/FinanceDashboard`; do not modify it.

## Technology and service layout

- Frontend: React 18, TypeScript, Vite, Chart.js (react-chartjs-2), Leaflet (+ MarkerCluster)
- Web runtime: nginx serving the Vite build and proxying `/api/` same-origin
- API: FastAPI + psycopg 3 (`services/api`)
- Ingestion: background Python worker calling the documented WinTeam endpoints
- Warehouse: PostgreSQL 16 (schemas `raw`, `core`, `mart`, `ops`, `staging`, `audit`)
- BI: Metabase `metabase/metabase:v0.63.13`
- Simulator: FastAPI app reproducing the WinTeam contract (`services/winteam-sim`)
- Packaging: Docker Compose (`compose.yaml`, overlay `compose.simulator.yaml`)

## Data architecture and non-negotiable rules

```text
documented WinTeam GET endpoints (WinTeamAPI.txt)
  -> worker (services/api/app/winteam.py)      immutable raw.winteam_record, versioned by payload hash
  -> normalize.py                              core.dim_job, job_tier, dim_customer, dim_vendor,
                                               fact_timekeeping, fact_schedule, fact_gl_budget(+_month),
                                               fact_ar_invoice, fact_ap_invoice, fact_ap_payment
  -> marts.py                                  mart.job_month, mart.portfolio_month, AR/AP/timekeeping views
  -> forecasting.py                            mart.forecast_run_meta / forecast_output / forecast_track_record /
                                               forecast_accuracy / forecast_series_status
  -> API (/api/v1, docs/api-contract.md)       -> React UI, Metabase (mart schema only)
```

1. Never call WinTeam from the browser or during a dashboard page request.
2. Only the endpoints, parameters, headers and fields in `WinTeamAPI.txt` are used. Do not
   invent others. Tenant-specific meanings (job tiers, overtime categories, fiscal year start,
   GL account classes, customer names, payroll burden) live in `ops.app_setting`, editable from
   the Administration page, and are disclosed on the Data dictionary page.
3. Raw payloads are preserved; exact replays are idempotent; changed payloads create a new
   version. Watermarks advance only after a complete successful resource run.
4. The UI and Metabase read `mart` only. Nothing in `raw` or `ops` reaches the browser.
5. Revenue basis: for months with a job-cost import (finance_reference source) revenue, direct
   labor, subcontract and other direct costs come from the WinTeam Job Cost Analysis P&L and gross
   profit = revenue − total direct costs (the finance-approved definition). For in-progress months
   (and for the WinTeam API source) revenue is AR `revenueTotal` attributed to the billing-period
   month and labor is timekeeping hours × the job's trailing closed-month rate (API source: hours ×
   rate). Every mart row carries `revenue_basis` / `labor_basis`, and neither is recognized revenue
   until Finance approves that definition.
6. Credentials stay server-side. Nothing secret may use a `VITE_` prefix. The admin token is
   held only in browser memory.
7. Observed actuals, budgets, the browser scenario sandbox, and governed model forecasts are
   labeled distinctly and never mixed.
8. Reporting periods are resolved server-side; the default anchor is the latest **closed** month
   (invoiced and past `close_lag_days`). In-progress months are selectable and labeled.
9. Demo data (seed) appears only when the API is unreachable or the marts are empty, and is
   always labeled as demo.

## Important files

- `WinTeamAPI.txt`: the authenticated endpoint documentation (source of truth)
- `config/winteam-endpoints.md`: how each endpoint is pulled, and the tenant inputs still required
- `docs/api-contract.md`: every API route and response shape
- `docs/forecasting.md`: the engine, gates, intervals, pace model, and what is not modeled
- `docs/frontend.md`: data seam, live/demo modes, views → endpoints, how to add a view
- `docs/winteam-go-live.md`: tenant configuration and verified entitlements
- `docs/winteam-live-source.md`: live API source, coexistence and precedence rules
- `docs/executive-pl.md`: the weekly executive labor P&L definitions and estimates
- `docs/auth-rbac.md`: roles, sessions, dev users, production variables
- `docs/reporting-scope.md`: the key-account scope model and what stays company-wide
- `docs/production-platform.md`: runbook, Metabase, backups, production gates
- `services/api/app/config.py`: environment validation (all `WINTEAM_*` variables)
- `services/api/app/winteam.py`: connector (paging, date windows, retries, raw landing)
- `services/api/app/normalize.py`: raw → core promotion (overtime derivation, tiers, GL classes)
- `services/api/app/marts.py`: mart rebuild + forecast trigger
- `services/api/app/forecasting.py`, `pace.py`: engine v2 port and month-end labor pace
- `services/api/app/routers/{platform,reporting,labor,forecast}.py`: API routes
- `services/api/app/common.py`: period resolution, filters, settings, source disclosure
- `database/migrations/001..018`: schema (never edit an applied migration)
- `services/api/app/sources/finance_reference.py`, `docs/finance-reference-source.md`: real export loader
- `sources/geo/city_centroids.json`: approximate city centroids used for map placement
- `services/winteam-sim/`: simulator (README lists the tenant GUID and customer numbers)
- `src/services/{apiTypes,api,demoApi,dataSource,queryClient}.ts`: frontend data seam
- `src/leadership/`: the app (metrics, routes, state, Shell, Overview, charts, ui, pages/*)
- `src/leadership/pages/SiteMap.tsx`: Leaflet map (cluster plugin loaded after the global `L`)
- `services/api/app/{accounts,imports,leadership,nightly}.py`, `routers/leadership.py`: account
  configuration, export imports, the weekly leadership mart, the nightly schedule, the routes

## Company view and allocations

- **Company** (everyone who sees every account): revenue, gross profit and labor % year to date from
  closed job cost months, the month trend, business units and every account this week. Suspect months
  (a subcontractor or labor share far above the rest) are flagged.
- **Corporate allocations** (`app/allocations.py`, Admin > Allocations): management wages (GL 40200),
  payroll burden and G&A overhead, from the Job Cost Analysis and the company Trend Income Statement,
  with manual monthly overrides. They show as margin after allocations, never inside labor %.
- **Analytics > Business units** (admin): the old Executive Overview on the weekly data.

## Report exports by email

The worker reads records@smcraneifs.com through Microsoft Graph (read-only) and loads the dashboard's
report exports; other mail is ignored. Setup and scoping: `docs/mail-inbox.md`.

## Hosted deployment

`render.yaml` is the Render blueprint (web, private API, worker, PostgreSQL; deploys `main`). The
runbook, including the one-time restore of the local data, is `docs/deploy-render.md`.

## Local startup

Frontend only (demo mode unless the stack is running; `pnpm dev` proxies `/api` to port 15173):

```bash
pnpm install
pnpm dev
```

Full platform on the real reference data (what is verified and running):

```bash
docker compose up -d --build
docker compose ps
# reload after restoring a newer Finance_Dashboard dump into finance_reference:
curl -X POST -H "X-Admin-Token: $INGESTION_ADMIN_TOKEN" http://127.0.0.1:15173/api/v1/integrations/finance-reference/load
```

Full platform with the WinTeam simulator (synthetic; replaces the warehouse contents on sync):

```bash
docker compose -f compose.yaml -f compose.simulator.yaml up -d --build
```

Full platform against the real tenant: fill the `WINTEAM_*` values in `.env`, then
`docker compose up -d --build` (see `docs/winteam-go-live.md`).

Local ports (the defaults were occupied on this machine; `.env` pins these):

- Dashboard: `http://127.0.0.1:15173` (API docs at `/api/docs`)
- Metabase: `http://127.0.0.1:13001`
- PostgreSQL: `127.0.0.1:15433` (db `facilities`, app user `facilities_app`)
- Simulator: `http://127.0.0.1:18081` (`/__sim/summary`)

The Compose project name `facilities-command-center` and the named volumes must not change;
database roles are created only on first volume initialization.

## Verification

```bash
pnpm test && pnpm build
docker run --rm -v "$PWD/services/api:/work" -w /work python:3.12-slim \
  sh -c "pip install -q -r requirements-dev.txt && python -m pytest -q"
docker run --rm -v "$PWD/services/winteam-sim:/work" -w /work python:3.12-slim \
  sh -c "pip install -q -r requirements.txt pytest && python -m pytest -q"
docker compose -f compose.yaml -f compose.simulator.yaml config --quiet
```

At the last verification (2026-09-03):

- frontend: `pnpm test` 235 tests, strict `tsc -b` + Vite build passed
- API: 200 tests passed (connector, config, period math, forecasting engine, pace, reference loader
  rules, weekly P&L helpers incl. sub-accounts and vendor projection, source precedence, job-number
  collision map, auth)
- simulator: 33 contract tests passed
- Docker: postgres, migrate (001–018 current), api, worker (live WinTeam sync enabled), web, metabase healthy
- reference load: 684 jobs, 3,248 job-cost months, 295,864 export punches, 21,011 daily budget rows,
  15 portfolio months (Jul 2025–Sep 2026); July 2026 revenue 5,758,735 from the corrected close
- live WinTeam: 629 jobs updated with exact coordinates, timekeeping window 2026-08-01 onward,
  285 AR invoices with applied cash matching the 08-31 aging snapshot on all 211 open Amazon invoices
- executive weekly mart: 16,191 job-week rows; Amazon week of 2026-08-24 reconciles to the
  day-share apportionment of July job-cost revenue; current weeks carry forward the latest closed
  month's invoicing and are flagged as estimates
- known data caveats carried through faithfully: July 2026 job cost has 390 warning rows with large
  subcontract costs on zero-revenue project jobs; the job-cost export carries only labor and subcontract
  costs; Sarus jobs have no addresses; 14 Sarus job numbers collide with Crane numbers and are protected
  by the `company_numbers` setting; September API punches arrive with rate 0 until payroll runs and are
  priced at the job's trailing rate; the portfolio timeline starts at the first month with labor
  coverage (Jul 2025) so stray early invoices from the API backfill cannot distort year-over-year deltas

Local Python is 3.14 without the API dependencies, hence the containerized test commands.

## Operating the integration

Administration page (needs the admin token from `INGESTION_ADMIN_TOKEN`): test connection, sync
all or one resource, rebuild marts, rebuild forecasts, edit `ops.app_setting` values, view sync
runs. Equivalent routes: `POST /api/v1/integrations/winteam/{test,sync,sync/{resource}}`,
`POST /api/v1/marts/rebuild`, `POST /api/v1/forecasts/rebuild` with header `X-Admin-Token`.
The worker runs one sync a night (`app/nightly.py`): import inbox (`IMPORT_INBOX_DIR`, mounted from
`./imports`), WinTeam primary and Sarus incrementally, one mart rebuild. It runs only inside
`window_hours` after the configured time, so a missed night is skipped. A normal sync re-reads 3 days before the last one (`WINTEAM_LOOKBACK_DAYS`);
`deep=true` re-reads 35 (`WINTEAM_DEEP_LOOKBACK_DAYS`); jobs, vendors, budgets and AR are re-read at
most once per 20 hours unless `force=true`; AP invoices WinTeam cannot serve are not asked for again for
7 days (`ops.winteam_unretrievable`). Sarus: `POST /api/v1/integrations/winteam/sarus/sync`.

## Known limitations

- Tenant credentials are not yet available; the verified instance uses the simulator.
- Unknown from the documentation and to be confirmed with TEAM: the gateway key header
  (assumed `Ocp-Apim-Subscription-Key`), the HTTPS host, customer numbers and names, job tier
  meanings, overtime category ids, fiscal year start, GL account classes.
- AP open balances cannot be derived (payments are not invoice-linked); AR invoices carry no
  customer name; deletions in WinTeam are not visible.
- Seasonality is not modeled (needs ≥ 24 closed months); subcontractor cost is not forecast by
  site.
- SSO/OIDC, row-level security, signed Metabase embedding, managed secrets, retries/dead
  letters at the orchestration level, monitoring, backups and restore drills remain production
  deployment work.
- The local instance still uses fallback credentials; rotate before loading real data.

## UI guidance

- Product name: **Crane IFS**. "Northstar Facilities" was a placeholder; do not reintroduce it or "Command Center".
- No emoji or symbol glyphs in UI copy; no explanatory or narrative prose on views (labels, values, units, dates, definitions only).
- One unique route and one active navigation state per nav item.
- Global filters only on views they truthfully affect; local controls beside their charts.
- Keep the map's dynamic width, U.S./Canada coverage, account filters, clusters and heat modes;
  Leaflet plugins stay dynamically loaded after global Leaflet initialization.
- Every card has skeleton, error (with retry), and empty states; nothing renders demo numbers
  inside a live card.
- Direct labels, visible values, tabular numbers, restrained color, progressive disclosure.

## Source-control and file safety

- Treat `sources/` as read-only reference material.
- Do not commit `.env`, credentials, raw customer payloads, database dumps, or PII.
- Preserve unrelated user changes; avoid destructive Git or Docker-volume commands.
- Use versioned migrations; never edit an already-applied migration.
