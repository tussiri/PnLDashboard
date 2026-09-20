# Production platform runbook

## What is implemented

This stack creates the operating boundary needed for live data without placing
WinTeam on the dashboard request path:

```text
verified WinTeam GET endpoints
        |
        v
scheduled worker --> immutable raw.winteam_record --> reviewed normalization
                                                       |
                                                       v
                                              core facts/dimensions
                                                       |
                                    +------------------+------------------+
                                    v                                     v
                              mart reporting views                 forecast v2 tables
                                    |                                     |
                                    +------------------+------------------+
                                                       v
                                             API / Metabase / UI
```

`raw.winteam_record` is append-only by payload version. Exact repeats are ignored
using `(resource_name, source_record_id, payload_hash)`. Each load has a run ID,
counts, timestamps, status, error details, and an independently tracked
watermark. The connector refuses redirects so authenticated headers are never
forwarded to another origin.

The initial migration also includes the v2 forecast storage contract:
`mart.forecast_run_meta`, `mart.forecast_output`, and
`mart.forecast_track_record`. This does not pretend that the browser demo is the
production model; it provides durable run, provenance, prediction-band, model
selection, input-period, exclusion, and backtest storage for the separate v2
engine.

## First start

1. Copy `.env.example` to `.env`.
2. Replace all `CHANGE_ME` values with generated secrets.
3. Leave `WINTEAM_ENABLED=false` for the first database and Metabase boot.
4. Run `docker compose up -d --build`.
5. Check `docker compose ps`; `postgres`, `api`, and `web` should become healthy,
   and `migrate` should exit successfully.
6. Open `http://localhost:5173/api/v1/system/status` and confirm the database is
   ready and WinTeam is disabled.
7. Complete Metabase setup at `http://localhost:3000` using the read-only
   analytics account from `.env`.

The Docker volume holds both the facilities warehouse and the Metabase
application database. Removing the volume removes both; do not use a volume
deletion command as a troubleshooting shortcut.

Database roles and databases are created only when the PostgreSQL volume is
initialized. Changing their names or passwords in `.env` later requires an
intentional SQL credential rotation; restarting containers does not rewrite an
existing database's roles.

## Configure verified WinTeam resources

Detailed TEAM Concourse paths, authentication headers, envelope fields, and
pagination conventions are tenant/API-version specific. Obtain them from your
authenticated TEAM API portal and capture a representative redacted response for
each resource. Do not guess them from names such as “jobs” or “invoices.”

For each endpoint, verify:

- exact base URL and relative GET path
- required authentication and tenant headers
- stable record identifier
- source-updated timestamp and its comparison semantics
- response path containing the record array
- cursor or page pagination parameters and termination rule
- rate limits, retry guidance, and whether deleted records are surfaced
- timezone, currency, service-period, approval, and status semantics

The eight documented GET endpoints (jobs, vendors, timekeeping, job schedules,
GL budgets, AP invoices, AR invoices, AP payments) are built into
`services/api/app/winteam.py`; `config/winteam-endpoints.md` records each path,
its parameters, how it is paged and windowed, and the tenant inputs that are
still required. Configure the tenant in the server environment:

- `WINTEAM_BASE_URL`: the gateway base (HTTPS)
- `WINTEAM_TENANT_ID`: the `tenantId` GUID header required by every endpoint
- `WINTEAM_SUBSCRIPTION_KEY` / `WINTEAM_SUBSCRIPTION_KEY_HEADER`: the Azure API
  Management gateway key (sent only when set)
- `WINTEAM_RESOURCES`: comma separated subset of the eight resource names
- `WINTEAM_CUSTOMER_NUMBERS`: receivables are only readable per customer number

Keep these values in the server `.env` or your production secret manager; never
add them to a `VITE_` variable, source file, browser storage, Metabase question,
or log message.

Set `WINTEAM_ENABLED=true`, rebuild/recreate `api` and `worker`, then perform a
bounded connection probe:

```bash
curl -X POST \
  -H "X-Admin-Token: <INGESTION_ADMIN_TOKEN>" \
  http://localhost:5173/api/v1/integrations/winteam/test
```

The probe requests only the first configured resource page and reports a record
count; it does not return or log payloads. Trigger one resource manually with:

```bash
curl -X POST \
  -H "X-Admin-Token: <INGESTION_ADMIN_TOKEN>" \
  http://localhost:5173/api/v1/integrations/winteam/sync/<configured-resource-name>
```

Review recent runs at
`http://localhost:5173/api/v1/integrations/winteam/runs` and freshness at
`http://localhost:5173/api/v1/data/freshness`.

## Normalize only reviewed fields

Raw ingestion is live-capable now. Dashboard replacement of seeded data should
happen endpoint by endpoint after representative payloads are available:

1. Store redacted samples as test fixtures outside `sources/`.
2. Create a new migration for a staging projection and core upsert.
3. Preserve the source ID, source-updated value, ingestion time, run ID, and hash.
4. Add data gates for null IDs, impossible dates/hours/amounts, duplicates,
   partial periods, stale closes, recycled job identity, currencies, and deletes.
5. Reconcile invoice, payroll/timekeeping, job, and finance totals to approved
   control reports.
6. Add mart views with explicit definitions; do not equate invoices with revenue
   unless Finance approves that definition.
7. Switch one UI repository method from seed to `/api/v1` only after its mart
   result passes reconciliation and empty/error/stale-state tests.

This staged cutover lets jobs, invoices, and timekeeping go live independently
without making the entire dashboard all-or-nothing.

## Metabase operating rules

- Use `mart` as the default reporting surface. Expose `core` only to analysts who
  need drill-through.
- Do not connect Metabase with the PostgreSQL superuser or application writer.
- Keep dashboard role filtering and row-level policies server-side; browser
  filters alone are not authorization.
- Back up the Metabase application database before changing its pinned image.
- Validate a new Metabase release in a non-production environment before
  promotion.
- Use signed embedding issued by the API if Metabase content is embedded later;
  never place a signing key in the React build.

## Production gates

Local Docker is the integration baseline, not the final hosting topology. Before
production, add:

- SSO/OIDC at the application and Metabase edges
- TLS, managed secrets, restricted egress, and IP/private-network controls
- separate managed PostgreSQL instances or lifecycle policies for warehouse and
  Metabase application data
- point-in-time recovery, encrypted backups, restore drills, and retention
- a queue/orchestrator for retries, exponential backoff, rate limiting, dead
  letters, and overlapping-run prevention
- structured logs, metrics, traces, freshness/SLA alerts, and schema-drift alerts
- warehouse transformations tested in CI and promoted through dev/test/prod
- row-level security and role-to-scope mappings
- WinTeam contract tests using approved, redacted fixtures
- finance and operations sign-off on semantic definitions and control totals
- the v2 forecasting service, scheduled backtests, promotion gates, drift
  monitoring, override audit, and reproducible feature snapshots

## Useful commands

```bash
docker compose ps
docker compose logs --tail=200 api worker migrate
docker compose exec postgres pg_isready -U postgres
docker compose run --rm migrate
docker compose pull metabase
docker compose up -d --build
```

Always back up before a database or Metabase upgrade. Keep image versions pinned
and change them intentionally through `.env`.
