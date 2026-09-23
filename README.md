# Crane IFS dashboard

Financial and operations dashboard for a national janitorial and facilities-services operator,
fed from the WinTeam / TEAM Concourse `wtnextgen` API into a PostgreSQL warehouse, with a
governed site-level forecasting engine and a React front end.

```text
WinTeam GET endpoints -> worker -> raw.winteam_record -> core facts/dims -> mart tables
                                                       -> forecast engine v2 -> mart.forecast_*
                                                       -> FastAPI /api/v1 -> React UI, Metabase
```

## Run the front end alone

```bash
pnpm install
pnpm dev        # proxies /api to http://127.0.0.1:15173; demo mode if the stack is down
pnpm test
pnpm build
```

## Run the full platform

With the contract-faithful WinTeam simulator (no tenant credentials needed):

```bash
docker compose -f compose.yaml -f compose.simulator.yaml up -d --build
docker compose -f compose.yaml -f compose.simulator.yaml ps
```

Against the real tenant: fill the `WINTEAM_*` values in `.env` (copy `.env.example`), then

```bash
docker compose up -d --build
```

`docs/winteam-go-live.md` is the cutover checklist. Local ports on this machine are pinned in
`.env`: dashboard `http://127.0.0.1:15173` (API docs at `/api/docs`), Metabase
`http://127.0.0.1:13001`, PostgreSQL `127.0.0.1:15433`, simulator `http://127.0.0.1:18081`.

WinTeam is synced on demand only - nothing polls it, and the worker never calls it. A sync
normalizes, rebuilds the marts and reruns the forecast engine. The Administration page (admin token = `INGESTION_ADMIN_TOKEN`) can test the
connection, sync, reset a watermark for a full re-pull, rebuild marts or forecasts, and edit
tenant settings (job tier map, overtime rule, GL account classes, fiscal year start, payroll
burden, customer names).

On Metabase's first-run screen, add the reporting database with host `postgres`, port `5432`,
database `APP_DB_NAME`, user `ANALYTICS_DB_USER` / `ANALYTICS_DB_PASSWORD`, schema `mart`.
The analytics role cannot read `raw` or `ops`.

## What the data means

- Revenue = AR `revenueTotal` attributed to the billing-period month (else invoice month). Not
  recognized revenue until Finance approves that definition.
- Labor cost = timekeeping `hours × rate`; overtime is either the tenant's overtime
  `categoryDetailId` list or hours over 40 per employee per Sunday-based week.
- Gross profit = revenue − labor cost − burden (`payroll_burden_rate`; 0 means labor margin).
- Budgets come from job GL budgets classified by `gl_account_classes`.
- AR open = `invoiceTotal − amountPaid`. AP open is not derivable (payments are not invoice-linked).
- Site status: Critical / Watch / Healthy by margin vs target, labor vs budget, overtime share and
  weighted AR days (rule disclosed in the Data dictionary).
- Default reporting anchor: the latest closed month (invoiced and past `close_lag_days`).
  In-progress months are selectable and labeled.

## Forecasting

Engine v2 (`services/api/app/forecasting.py`, documented in `docs/forecasting.md`): closed months
only, one-sided anomaly tripwire, per-series walk-forward selection among naive / recent median /
damped Theil–Sen trend, pooled empirical 80% intervals that widen with horizon by measurement,
measured coverage, materialized track record, per-row provenance and run-level assumptions.
Portfolio = sum of site forecasts. The month-end labor pace (`pace.py`) is a separate,
day-of-week-weighted projection for the month in progress. The browser scenario sandbox on the
Forecast page is a demonstration, never a governed forecast.

## Documentation

- `HANDOFF.md` — rules, layout, verification, limitations
- `docs/api-contract.md` — every API route and response shape
- `config/winteam-endpoints.md` — how each documented endpoint is pulled; tenant inputs required
- `docs/forecasting.md`, `docs/frontend.md`, `docs/production-platform.md`, `docs/winteam-go-live.md`
- `services/winteam-sim/README.md` — the simulator (tenant GUID, customer numbers, dataset)

## Verification

```bash
pnpm test && pnpm build
docker run --rm -v "$PWD/services/api:/work" -w /work python:3.12-slim \
  sh -c "pip install -q -r requirements-dev.txt && python -m pytest -q"
docker run --rm -v "$PWD/services/winteam-sim:/work" -w /work python:3.12-slim \
  sh -c "pip install -q -r requirements.txt pytest && python -m pytest -q"
```
