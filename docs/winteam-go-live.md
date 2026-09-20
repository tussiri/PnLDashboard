# Going live on the real WinTeam tenant

The stack ships in two modes. Both use the same connector, normalization, marts, forecast engine
and UI; only the gateway differs.

| Mode | Command | Data |
|---|---|---|
| Simulator | `docker compose -f compose.yaml -f compose.simulator.yaml up -d --build` | Synthetic, deterministic, contract-faithful (`services/winteam-sim`) |
| Tenant | `docker compose up -d --build` with WinTeam values in `.env` | Live TEAM / WinTeam `wtnextgen` API |

## 1. Inputs to obtain from TEAM Software / the tenant admin

| Input | Env / setting | Notes |
|---|---|---|
| Gateway base URL | `WINTEAM_BASE_URL` | Verified 2026-09-03: `https://apim.myteamsoftware.com` works. The `/wtnextgen` API prefix is appended automatically (`WINTEAM_API_PREFIX`, default `/wtnextgen`) when the base URL omits it; a bare gateway host otherwise answers 404 on every path. |
| Tenant GUID | `WINTEAM_TENANT_ID` | Sent as the `tenantId` header on every call. |
| Gateway subscription key | `WINTEAM_SUBSCRIPTION_KEY` (+ `WINTEAM_SUBSCRIPTION_KEY_HEADER` if not `Ocp-Apim-Subscription-Key`) | Azure API Management convention; not in the endpoint docs, confirm the header name. |
| Customer numbers | `WINTEAM_CUSTOMER_NUMBERS` | Receivables are only readable per `customerNumber`. Add display names through `PUT /api/v1/settings/customer_names`. |
| Job tier meaning | setting `job_tier_map` | Which `jobTiers[].tierID` is region / branch / service type / manager / vertical. |
| Overtime categories | setting `overtime_category_detail_ids` | Timekeeping `categoryDetailId` values that are overtime. Leave empty to derive overtime from hours over 40 per employee per Sunday-based week. |
| Fiscal year start | setting `fiscal_year_start_month` | Maps GL budget `period1..12` onto calendar months. |
| GL account classes | setting `gl_account_classes` | Which accounts are revenue / direct labor / subcontract / supplies. |
| Payroll burden rate | setting `payroll_burden_rate` | 0 reports labor margin; set the finance-approved burden fraction to report gross profit. |

## 2. Staged cutover

1. Put the values in the server `.env` (never a `VITE_` variable). Keep `WINTEAM_ENABLED=false`.
2. `docker compose up -d --build` and confirm `docker compose ps` shows `migrate` exited 0 and `api` healthy.
3. Set `WINTEAM_ENABLED=true`, `WINTEAM_RESOURCES=jobs`, `WINTEAM_SCHEDULE_JOBS_LIMIT=3`,
   `WINTEAM_BACKFILL_MONTHS=1`, then `docker compose up -d api worker`.
4. Probe: `curl -X POST -H "X-Admin-Token: $INGESTION_ADMIN_TOKEN" http://localhost:5173/api/v1/integrations/winteam/test`
   (returns `records_in_probe` and `total_count`; a 4xx from the gateway is shown verbatim).
5. Sync one resource at a time from the Administration page or
   `POST /api/v1/integrations/winteam/sync/{resource}` in this order: `jobs`, `vendors`,
   `timekeeping`, `gl_budgets`, `ar_invoices`, `ap_invoices`, `ap_payments`, `job_schedules`.
   After each, inspect `ops.integration_sync_run`, `raw.winteam_record` and the matching
   `core.*` table; keep redacted samples of each payload under `sources/` for contract tests.
6. Review the tier map, overtime rule, GL classes and fiscal start against WinTeam setup, then
   `POST /api/v1/marts/rebuild` and compare `mart.portfolio_month` to the WinTeam Job Cost Analysis,
   Hours Budget Comparison and AR invoice register for the same months.
7. Widen: `WINTEAM_RESOURCES` to all eight, `WINTEAM_SCHEDULE_JOBS_LIMIT=0`,
   `WINTEAM_BACKFILL_MONTHS` to cover at least the same span as the receivables history you
   will compare against (receivables are not date-filterable, so they arrive in full; months with
   invoices but no timekeeping backfill would otherwise read as abnormally high margin). Forecasting
   needs ≥ 4 closed months and gets meaningfully better at 12+. Then `docker compose up -d api worker`.
8. Let the worker poll (`WINTEAM_POLL_SECONDS`). Watch `GET /api/v1/data/freshness`; the Data
   dictionary page shows the same table.

## 3. What to reconcile before the numbers are called production

- Revenue on the dashboard = AR `revenueTotal` attributed to the billing-period month. Finance must
  approve equating invoices with revenue, or the label stays "invoiced".
- Labor cost = timekeeping `hours × rate` (straight time). Compare to the payroll register.
- Gross profit = revenue − labor − burden. Subcontractor and supplies actuals are not job-linked in
  the documented API; only their budgets appear per job.
- AR open = `invoiceTotal − amountPaid`; AP open cannot be derived (payments are not invoice-linked).
- Deletions in WinTeam are not visible through these endpoints; plan a periodic full re-pull.

## 4. Simulator details

See `services/winteam-sim/README.md`. Tenant GUID `11111111-1111-4111-8111-111111111111`, customer
numbers `1001`–`1010`, 48 sites, 24 months. `compose.simulator.yaml` sets every WinTeam variable for
the `api` and `worker` services; nothing in `.env` needs to change to run it.

## 5. Verified entitlements (2026-09-03, production tenant)

| Resource | Result |
|---|---|
| jobs, vendors, timekeeping, ap_invoices, ar_invoices | 200 with data (643 jobs, 279 vendors, ~8k punches/week, ~580 AP invoices/month) |
| job_schedules, ap_payments | **403** — the subscription is not entitled; the connector records the resource as `not_entitled` and skips it |
| gl_budgets | 400 "Invalid Job Number and Fiscal Year combination" for jobs without a budget — treated as no budget |

The API cannot supply the Job Cost Analysis P&L, so the WinTeam report exports (`finance_reference`) remain the
closed-month revenue/cost source; the API supplies live timekeeping, invoices, jobs and payables.
