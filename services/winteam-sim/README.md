# winteam-sim

A small, contract-faithful **simulator** of the WinTeam / TEAM Concourse
`wtnextgen` REST API (the endpoints documented in `WinTeamAPI.txt`). It exists
so the Northstar Facilities platform can be exercised end to end
(ingestion -> marts -> forecasts -> UI) before real tenant credentials exist.

**This is not WinTeam.** Every number it returns is synthetic, generated from a
seeded random generator at startup. Nothing here talks to TEAM Software, and the
data has no relationship to any real customer, employee, vendor or invoice.

## What it reproduces

Paths, required parameters, the `tenantId` header, the response envelopes and
the field names/formats from the API documentation:

| Endpoint | Notes |
| --- | --- |
| `GET /timekeeping/v2/api/timekeeping?dateFrom&dateTo` | paged; `orderBy`/`ascending` |
| `GET /jobs/v2/api/jobs` | paged; `locationId`, `searchFieldName`/`searchText`/`exactMatch`, `orderBy` |
| `GET /jobs/v2/api/jobs/{jobKey}/gl-budgets` | bare `data[]`; `jobKey` = jobNumber or jobId; 404 when unknown |
| `POST /jobs/v2/api/jobs/{jobKey}/budgets` | validates and echoes the body with 201 (per the doc sample) |
| `GET /jobs/v2/api/jobs/{jobKey}/schedules?dateFrom&dateTo` | paged; extends 6 weeks past today |
| `GET /accounts/v1/api/payables/invoices?dateFrom&dateTo` | paged |
| `GET /accounts/v1/api/receivables/invoices/?customerNumber=` | paged; with or without the trailing slash |
| `GET /accounts/v1/api/payables/payments?startDate&endDate` | paged |
| `GET /vendors/v1/api/vendors/` | paged; `vendorNumber`; with or without the trailing slash |

Behaviour shared by every endpoint:

* `tenantId` header required. Missing -> `400`, not a GUID -> `422`, both with
  the documented `errors[{attemptedValue, fieldName, errorMessage}]` envelope.
  A well-formed GUID that is not `SIM_TENANT_ID` -> `401`.
* Paged responses use `{"data": [{pageNumber, pageSize, totalPages, totalCount, results}], "success", "serverResponse"}`.
  `pageSize` defaults to 100 and is capped at 1000; a page with no rows is `204 No Content`.
* Date filters are inclusive on the date part and accept RFC3339 (`2026-08-01T00:00:00Z`) or bare dates.
* Dates are rendered the way WinTeam renders them: `2026-08-01T12:00:00Z`; punch times as `2026-08-01T17:00:00Z`.
* Unknown `orderBy` / `searchFieldName` values return `400` so connector bugs surface early.
* Query parameter names are case-insensitive (`pageSize` == `PageSize`), like the ASP.NET binding behind APIM.

Operator endpoints (no tenant header needed):

* `GET /__sim/health` - liveness.
* `GET /__sim/summary` - row counts, customer numbers, parent/child job numbers,
  the special jobs (high overtime, recently started, inactive) and a
  ready-to-copy `suggestedEnv` block for the api/worker.

## The synthetic portfolio

* 10 parent accounts, 48 site jobs at the default scale (an 8-site e-commerce
  logistics customer, a health system, a school district, office portfolios, a
  4-site Canadian portfolio, a manufacturer with subcontracted floor care, a
  retailer, a single-site bank, a community college and a slow-paying clinic
  group). Multi-site accounts have a parent job record (`1001P` ...) that
  carries no labor or revenue; sites point at it via `parentJobNumber`.
* Job tiers: 1 = region, 2 = branch/city, 3 = service type (Janitorial,
  Industrial Services, Healthcare EVS, Education), 4 = `Area N Manager`,
  6 = vertical; other tiers are `None`.
* 24 months of timekeeping through yesterday (~180k rows at defaults): realistic
  weekday/weekend shape, 4-10 h shifts, $15-28 rates, overtime rows
  (`categoryDetailId` 2) whenever an employee passes 40 h in a Sun-Sat week,
  four high-overtime jobs, two recently started jobs, two inactive jobs.
* Schedules per job post; actual hours drift 88-112 % from schedule per job.
* GL budgets per job per fiscal year (3010 Service Income, 4010 Direct Labor,
  4200 Supplies, 4400 Subcontractors for subcontracted jobs), within about
  +/-15 % of actuals.
* AR invoices per job per month (bi-weekly for the logistics account), revenue
  = hours x bill rate (1.45-1.75x pay), sales tax in TX/OH/Canada, account-level
  payment behaviour, one 90+ day slow payer, one credit memo with
  `invoiceBeingCredited`.
* 25 vendors, monthly AP invoices with due dates, payments 30-45 days later
  (utilities pay several invoices per cheque), a few unpaid recent invoices.

Customer numbers are fixed and simple: **1001 .. 1010** (one per parent
account, in the order above). Every site's AR invoices carry its account's
customer number, so `/receivables/invoices/?customerNumber=1001` returns all
eight logistics sites.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SIM_SEED` | `7` | RNG seed; same seed + same settings = identical data across restarts/instances |
| `SIM_JOBS` | `48` | number of site jobs (accounts scale proportionally) |
| `SIM_MONTHS` | `24` | months of history ending yesterday |
| `SIM_TENANT_ID` | `11111111-1111-4111-8111-111111111111` | the only tenant GUID accepted |
| `SIM_SUBSCRIPTION_KEY` | unset | when set, `Ocp-Apim-Subscription-Key` must match or the answer is `401` |
| `SIM_RATE_LIMIT_EVERY` | `0` | when N > 0, every Nth request gets `429` with `Retry-After: 1` |
| `SIM_TODAY` | today | freeze "today" (ISO date) for reproducible fixtures |

## Running with the stack

```sh
docker compose -f compose.yaml -f compose.simulator.yaml up -d --build
curl -s http://127.0.0.1:18081/__sim/summary | jq .suggestedEnv
```

The overlay adds the `winteam-sim` service on the `egress` and `backend`
networks and sets these on `api` and `worker`:

```
WINTEAM_ENABLED=true
WINTEAM_BASE_URL=http://winteam-sim:8081
WINTEAM_ALLOW_INSECURE_HTTP=true
WINTEAM_TENANT_ID=11111111-1111-4111-8111-111111111111      # or ${SIM_TENANT_ID}
WINTEAM_CUSTOMER_NUMBERS=1001,1002,1003,1004,1005,1006,1007,1008,1009,1010   # or ${SIM_CUSTOMER_NUMBERS}
WINTEAM_HEADERS_JSON={"tenantId": "11111111-1111-4111-8111-111111111111"}
```

Put `SIM_CUSTOMER_NUMBERS=...` in `.env` if you change the account mix; the
authoritative list is always `GET /__sim/summary` -> `customerNumbers`.

## Running standalone

```sh
docker build -t winteam-sim services/winteam-sim
docker run --rm -p 18081:8081 winteam-sim
curl -s -H 'tenantId: 11111111-1111-4111-8111-111111111111' \
  'http://127.0.0.1:18081/jobs/v2/api/jobs?pageSize=5' | jq .
curl -s -H 'tenantId: 11111111-1111-4111-8111-111111111111' \
  'http://127.0.0.1:18081/timekeeping/v2/api/timekeeping?dateFrom=2026-08-01&dateTo=2026-08-07&pageSize=3' | jq .
```

## Tests

```sh
docker run --rm -v "$PWD/services/winteam-sim:/work" -w /work python:3.12-slim \
  sh -c "pip install -q -r requirements.txt pytest && python -m pytest -q"
```

`tests/test_contract.py` asserts each endpoint's envelope and field names
against the documented samples, the 400/422 tenant errors, 204 on empty ranges,
paging math, the subscription-key and 429 chaos modes, and determinism across
two app instances built from the same seed.

## Deviations worth knowing

* Where the documentation's sample and schema disagree on a type, the schema
  wins: `employeeNumber`, `jobNumber`, `customerNumber`, `jobZip`, `phone` are
  strings; `invoiceNumber` (AR) and `vendorNumber` are integers.
* `workTicketNumber` is always `null`; `postingDate` equals `invoiceDate` for AR.
* The gl-budgets `financialStatement` / `jobCostAnalysis` flags act as
  include-filters over rows flagged for each view (supplies rows are
  financial-statement only).
* `POST .../budgets` is accepted and echoed but not persisted.
