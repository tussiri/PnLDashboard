# WinTeam live API as a second source

Last verified: 2026-09-03 against the production tenant (raw landing only; nothing was normalized on
the running stack).

The dashboard warehouse (`core`, `mart`) is filled by two server-side sources that now coexist in
the same tables:

| Source | What it is | Loader | Row marker |
|---|---|---|---|
| `finance_reference` | the real WinTeam **report exports** restored from the Finance_Dashboard dump (`docs/finance-reference-source.md`) | `services/api/app/sources/finance_reference.py` | `source = 'finance_reference'`, ids `row:`, `ar:`, `ap:`, `fr:` |
| `winteam_api` | the documented TEAM / WinTeam `wtnextgen` GET endpoints (`config/winteam-endpoints.md`) | `services/api/app/winteam.py` (raw landing) + `services/api/app/normalize.py` (promotion into core) | `source = 'winteam_api'`, ids `api:` |

Until 2026-09-03 the API path assumed it owned the warehouse (its normalizer keyed every table by
the API id and would have closed every reference job as "recycled"). It now lands next to the export
rows under the rules below, and since migration 011 the marts arbitrate between the two through
the `mart.v_*_effective` views (see "Precedence" at the end), so `WINTEAM_NORMALIZE=true` is safe.

## What the API adds over the exports

| Data | Exports (`finance_reference`) | Live API (`winteam_api`) |
|---|---|---|
| Timekeeping | detail lines through the last export (2026-08-10 in the current dump); dollar fields unreliable, so labor cost is a trailing job rate | live punches (`GET /timekeeping/v2`) with `rate` per punch: ~8,100 punches / week, 15,470 in the last 14 days on 2026-09-03; `labor_cost = hours x rate` when `rate > 0` (24% of punches carry rate 0 and get `labor_cost_basis = 'none'`) |
| AR | invoice register + aging snapshots (open balance as of the snapshot date) | `invoiceTotal` **and `amountPaid`** per invoice as of now (`open_balance_basis = 'api_amount_paid'`), per customer number |
| Jobs master | Crane job master CSV (addresses, tiers; city-centroid coordinates) and Sarus jobs without addresses | every job of the tenant (643) with `jobId` GUID, `companyNumber`, tiers, address and **`taxAddress.latitude/longitude` on all 643 jobs** (`geo_precision = 'exact'`) |
| Vendors | names from the AP aging / activity exports | 279 vendors with status, type, address, contacts |
| AP invoices | AP aging / activity exports | invoices by date window with `companyNumber` (316 in the last 14 days) |

## What the API cannot provide

* The **job-cost P&L** (revenue, direct labor, payroll taxes / insurance, materials, subcontractors,
  supplies, other direct costs per job and month). No documented endpoint carries it; closed months
  keep coming from the exports (`core.fact_job_cost_month`).
* **Schedules** (`GET /jobs/{jobKey}/schedules`) and **AP payments**
  (`GET /accounts/v1/api/payables/payments`): the subscription answers **HTTP 403** on both. The
  connector records the run as `failed` with `error_message = "not_entitled: HTTP 403"`,
  `GET /integrations/winteam` reports `entitled: false` for them, `sync_all` carries on with the
  other resources, and the worker warns once per resource (again only when it recovers).
* **GL budgets**: `GET /jobs/{jobKey}/gl-budgets` answers HTTP 400 `JobKey: Invalid Job Number and
  Fiscal Year combination.` for every job/year without a budget (and 404 for unknown jobs); both
  mean "no budget" and are not failures. The first five active jobs had no GL budget in 2025 or
  2026, and the same call without `fiscalYear` answers the same 400, so the labor budgets keep
  coming from the exports (`core.fact_labor_budget_month`).
* Customer names and the AR parent customer (the receivables endpoint returns numbers only).
* Deletions (no endpoint reports them).

## Coexistence rules (implemented in `normalize.py`)

1. **`core.dim_job` is keyed by `job_number`**: one current row per job number regardless of
   source (`dim_job_current_job_number_idx`). The API updates that row in place and sets
   `source = 'winteam_api'`, `winteam_id = jobId` GUID, `job_name`, tiers (`region_name`,
   `branch_name`, `service_type`, `manager_name`, `vertical` through `ops.app_setting.job_tier_map`),
   address, `latitude` / `longitude` from `taxAddress` (`geo_precision = 'exact'` when both are
   present), `company` from `companyNumber` through `ops.app_setting.company_numbers`, and
   `is_active`. Every other column keeps the reference value: `delivery_model`, `account_group`,
   `customer_number` / `customer_name`, the parent account, `date_discontinued`, and any field the
   API left NULL (`coalesce(excluded, existing)`). Reference-only jobs are never deleted and never
   deactivated; only API-supplied rows drop to inactive when they leave the feed.
2. **Namespace (Crane / Sarus)**: the reference loader stores one row per bare job number and marks
   the namespace on the row (`company_name_raw` containing "Sarus"). The jobs endpoint carries no
   company name, so the API namespace comes from the `company_numbers` label (a label containing
   "sarus" = Sarus, else Crane, exactly `sources/rules.namespace_for`). When both namespaces are
   known and differ the reference row is left untouched, the API record is skipped and the
   conflict is logged (`normalize jobs: N job number(s) belong to the other namespace ...`). When
   `company_numbers` does not map the number the namespace is unknown and the job falls back to a
   plain `job_number` match. Vendors: Sarus vendor numbers are offset by
   `rules.SARUS_VENDOR_OFFSET` (1,000,000) like the reference loader; the API tenant counts as Sarus
   only when every `company_numbers` label is a Sarus company.
3. **`core.fact_timekeeping`**: API punches are `winteam_id = 'api:{timekeepingId}'`,
   `source = 'winteam_api'`, `labor_cost_basis = 'hours_x_rate'` (or `'none'` when `rate` is 0 /
   NULL), `company` from the job row. Reference rows (`row:{uuid}`) are never touched; the
   regular / overtime derivation (`overtime_category_detail_ids`, else the weekly threshold) runs on
   API rows only.
4. **`core.fact_ar_invoice`**: `'api:{customerNumber}:{invoiceNumber}'`, `amount_paid` from the
   API, `open_balance_basis = 'api_amount_paid'`, `company` from the job (else the customer),
   `is_collectible` from `ar_treatment_rules` on the customer name. `core.dim_customer` numbers the
   API discovers get `source = 'winteam_api'`; existing customers keep their name and company.
5. **`core.fact_ap_invoice`**: `'api:{companyNumber}:{vendorNumber}:{invoiceNumber}'`, `company`
   from `company_numbers`, `vendor_number` namespaced as above, `vendor_name` from
   `core.dim_vendor`. **`core.dim_vendor`** is keyed by `vendor_number`: the API updates the row's
   name / status / contacts and sets `winteam_id = 'api:{vendorNumber}'`, `source = 'winteam_api'`.
6. **Guards**: every fact upsert is `ON CONFLICT (winteam_id) DO UPDATE ... WHERE <table>.source =
   'winteam_api'`; every `DELETE` is scoped to `source = 'winteam_api'` and to the records of the
   resource being re-normalized (`core.job_tier` of the jobs in the feed); nothing `TRUNCATE`s.
   `services/api/tests/test_source_coexistence.py` asserts these shapes on the emitted SQL.

Verified on a scratch copy of the warehouse (`facilities_scratch`, dropped afterwards) with the raw
rows landed on 2026-09-03 and `company_numbers = {"1": "Crane IFS", "2": "Crane West", "3": "Crane
Southwest"}`: 629 jobs updated in place (all with GUID ids and exact coordinates, `delivery_model`
kept on 623, `account_group` on 518, parent account on all), 14 namespace conflicts skipped (job
numbers 300, 400-409, 6325, 99999, BalSheet: Crane FedEx sites in the API vs Sarus Amazon / Whole
Foods jobs in the reference load), 63 reference-only jobs untouched, 0 rows closed; 279 vendors
(244 of them already known from the exports) re-keyed `api:`; 15,470 punches landed with 11,797
priced (`hours_x_rate`) and 3,673 unpriced; 285 AR invoices with `api_amount_paid`; 316 AP invoices
with company labels and vendor keys resolved.

## Namespace decision (verified facts)

* The production tenant is the **Crane WinTeam database**: `companyNumber` is 1 (453 jobs), 2 (47)
  or 3 (143), which is the reference job master's `CompanyNumber` for Crane IFS, Crane West and
  Crane Southwest. No Sarus company appears, so the tenant namespace is Crane.
* Job numbers are plain WinTeam job numbers (640 numeric from `1` to `99999`, plus `BalSheet`,
  `BalSheet2`, `BalSheet3`); 638 of the 643 match a current `core.dim_job` row by number.
* 14 of them collide with **Sarus** reference rows that are different physical jobs (API `300` =
  "FXE_AGCA Pittsburgh PA", reference `300` = "Amazon - BDL3/7"). The rule above keeps the
  reference rows; the Crane jobs behind those numbers are not represented until the mart layer
  supports a namespaced job identity. `ops.app_setting.company_numbers` therefore **must be filled**
  (`PUT /api/v1/settings/company_numbers` with `{"1": "Crane IFS", "2": "Crane West", "3": "Crane
  Southwest"}`) before normalization is enabled; with an empty map the namespace is unknown and
  those 14 Sarus rows would be overwritten by the Crane jobs.

## Operating it

| Setting | Meaning |
|---|---|
| `WINTEAM_NORMALIZE` (default `true`) | `false` = the worker and `sync_all` only land raw payloads; no core promotion, no mart rebuild. Passed through `compose.yaml`'s `x-api-environment` block since 2026-09-03. |
| `WINTEAM_GL_JOBS_LIMIT` (default 0 = all) | caps the per-job GL budget pull, like `WINTEAM_SCHEDULE_JOBS_LIMIT` for schedules. Also not in `compose.yaml` yet. |
| `ops.app_setting.company_numbers` | `{"companyNumber": "label"}`; seeded empty by migration 008. |
| `POST /integrations/winteam/sync/{resource}?normalize=false` | raw-only sync of one resource (409 with the run payload when the resource is not entitled). |
| `POST /integrations/winteam/sync?normalize=false&resources=jobs,vendors` | raw-only sync of a subset. |
| `GET /integrations/winteam` | per resource `entitled: true / false / null` (null = never synced) and `normalize_enabled`. |

Bounded validation pulls from Python (`winteam.sync(..., start_date=..., customer_numbers=[...],
jobs_limit=N)`) record their scope on the run row (`error_message` carries `bounded pull {...}`) and
never advance the watermark. Run them only in a one-off container:

```bash
WINTEAM_ENABLED=true docker compose run --rm --no-deps -T -e WINTEAM_NORMALIZE=false \
  -v "$PWD/services/api/app:/app/app" api python - <<'EOF'
from datetime import date, timedelta
from app.winteam import winteam
print(winteam.sync("timekeeping", normalize=False, start_date=date.today() - timedelta(days=14)))
EOF
```

Raw landing on 2026-09-03 (all `raw.winteam_record`, versions by payload hash): jobs 643, vendors
279, timekeeping 15,470 (2026-08-20 .. 2026-09-03, 1,305 employees, 258 jobs, every job known),
ap_invoices 316, ar_invoices 285 (customers AMAZ01, AIRG01, COST01), gl_budgets 0, job_schedules
and ap_payments `entitled: false`. Redacted contract samples: `sources/winteam_samples/*.json`.

Two live-contract facts the documentation does not show: receivables records do **not** echo
`customerNumber` (the connector writes the queried number into each record before landing, the id
stays `customerNumber:invoiceNumber`), and `jobTiers[].tierValue` arrives as a string.

## Open questions for the tenant

* Which `categoryDetailId` values are overtime. The live ids (`1`: 63% of punches, `104`: 32%,
  `136`, `87`, `58`, `107`, `4`, `109`, `152`, `6`) are a different id space from the exports'
  hours types (`15` Ops/Regular, `40` FedEx/Pallet, `6` Admin/Regular ...), and no export hours
  type is an overtime type, so the ids cannot be inferred from the dump. Until
  `overtime_category_detail_ids` is set, API rows use the weekly threshold.
* Why 24% of punches carry `rate = 0` (2,423 of them in category 1). Those rows keep
  `labor_cost = NULL`; the mart layer should price them with the trailing job rate the reference
  source already computes.
* A reference load (`finance_reference.load`) still starts with `TRUNCATE` of `raw.winteam_record`
  and `ops.source_watermark`, which wipes the API landing. It should become
  `DELETE ... WHERE source = 'finance_reference'` on the core tables and leave `raw` alone
  (`sources/finance_reference.py`, not changed here).

## Mart precedence (implemented 2026-09-03, migration 011 - see "Precedence" below)

Before 011 `marts.py` summed `core.fact_timekeeping` and `core.fact_ar_invoice` across sources, so
enabling normalization would have double counted the overlap (2026-08-20 .. 2026-09-01 for
timekeeping, Jul 2025 .. Jul 2026 for AR of the synced customers). The rule that was intended and is
now in place:

* per (job, day) for timekeeping and per (job, service month) for AR: **API rows win the days /
  months they cover**, export rows fill everything else;
* closed months keep the **job-cost P&L** from the exports as the only revenue / cost basis;
* the current month combines live punches (API) with the export budget, and prices unpriced punches
  with the trailing job rate;
* `mart.job_month.source` / `labor_basis` / `revenue_basis` say which rows fed each cell.

Then `WINTEAM_NORMALIZE` can be turned on, the worker poll widened from the 14-day validation window
to `WINTEAM_LOOKBACK_DAYS`, and `WINTEAM_CUSTOMER_NUMBERS` left empty (the union with
`core.dim_customer` already covers the 102 export customers).

## Precedence

Implemented by `database/migrations/011_source_precedence.sql`; every consumer (`marts.py` job_month
and portfolio AP, `weekly.py` job_week, `pace.py`, `routers/labor.py`, `routers/reporting.py`, and
the legacy `mart.v_timekeeping_daily` / `v_ar_open` / `v_ap_vendor_month`) reads these views instead
of the fact tables. Pure mirrors for tests: `marts.api_window` / `effective_rows` /
`effective_ar_rows` (`tests/test_source_precedence.py`).

| View | Grain | Rule |
|---|---|---|
| `mart.v_source_precedence` | one row | `timekeeping_from / to` = min / max `work_date` of the API punches; `ap_invoice_from / to` = min / max `coalesce(invoice_date, posting_date)` of the API AP invoices; `api_companies` = the labels of `ops.app_setting.company_numbers` (the companies the API tenant serves: Crane IFS, Crane West, Crane Southwest). `SELECT * FROM mart.v_source_precedence` shows the coverage boundaries. |
| `mart.v_timekeeping_effective` | day | API punches always count. An export punch counts unless its `work_date` is inside `[timekeeping_from, timekeeping_to]` **and** its `company` is one the API serves (or NULL). Export punches of companies outside the tenant (Sarus) keep counting on every day. **A day inside the window with no API punches is trusted as "no punches"**: the API is the system of record there, so the export line for that day is not used to fill the gap. With `company_numbers` empty the rule degrades to the plain date window (every export row inside it is superseded). |
| `mart.v_ar_invoice_effective` | invoice | an API invoice supersedes the export invoice with the same `(customer_number, invoice_number)`; otherwise the union of both sources. |
| `mart.v_ap_invoice_effective` | invoice date | same window rule as timekeeping over `coalesce(invoice_date, posting_date)`, same company scoping. |

Why the company scoping: on 2026-09-03 the export still carried 859 Sarus punches / 7,582 hours
inside the API window (2026-08-20 .. 2026-09-01); Sarus is a different WinTeam database the tenant
credentials do not reach, so a pure date window would have zeroed Sarus labor for those days.

What stays as it was:

* closed months keep the job-cost P&L from the exports as the only revenue / cost basis (`marts.py`
  `jc_months`); the effective timekeeping only supplies hours / employee counts there;
* `/ar/aging` with `primary_source = 'finance_reference'` still buckets the latest **AR aging
  snapshot** (`core.fact_ar_aging_snapshot`, reference only). `mart.v_ar_open` and `/ar/invoices`
  now read the effective invoices, so an API invoice's live `amount_paid` shows there;
* `/ap/summary` open balances still come from the AP aging snapshot; its invoiced / vendor / due
  figures read the effective AP invoices.

### Second database: Sarus (migration 026)

Sarus is its own WinTeam database, reached with its own tenant id and key (`WINTEAM_SARUS_*`).
Its job, vendor, employee and invoice numbers overlap Crane's, so `app/tenants.py` keeps it apart
at every layer:

| Layer | Primary (Crane) | Sarus |
|---|---|---|
| raw `resource_name` | `timekeeping` | `sarus/timekeeping` |
| core `source` | `winteam_api` | `winteam_sarus` |
| `winteam_id` | `api:<id>` | `api:sarus:<id>` |
| sync runs / watermarks | `integration_name = 'winteam'` | `'winteam_sarus'` |
| job resolution | `mart.v_api_job_map` | `mart.v_sarus_job_map` (bare row when it is a Sarus job, else `Sarus:<n>`) |
| company | `company_numbers` labels | always `Sarus` |
| vendors | as numbered | `+ rules.SARUS_VENDOR_OFFSET` |

Resources read from Sarus: jobs (raw only - the export owns the Sarus job dimension; the list drives
the per-job budget pull), vendors, timekeeping, job_budgets, ap_invoices, ap_invoice_details,
ar_invoices (customers: those on Sarus jobs and invoices).

Precedence is per database. `winteam_api` keeps its window and company scoping unchanged.
`winteam_sarus` has its own window (`sarus_timekeeping_from / to`, `sarus_ap_invoice_from / to` in
`mart.v_source_precedence`) and supersedes only export rows whose company is `Sarus`, so a Sarus
backfill never widens the Crane window. AR: an API invoice supersedes only the export invoice of its
own database with the same `(customer_number, invoice_number)`.

Sarus is synced on demand only, like the primary: the Administration page's Sync Sarus, or
`POST /api/v1/integrations/winteam/sarus/sync` (requires `WINTEAM_SARUS_ENABLED=true`).

### Pricing punches the API reports without a rate

24% of the live punches carry `rate = 0`. `normalize.normalize_timekeeping` now prices those with the
reference loader's rule (`sources/rules.trailing_rate`): the job's `sum(direct_labor) /
sum(actual_hours)` over its last 3 **closed** job-cost months (`core.fact_job_cost_month`, month end +
`close_lag_days` in the past, hours and labor > 0), else the company's pooled rate over its last 3
closed months, else the portfolio rate. Such rows carry `labor_cost_basis = 'trailing_job_rate'` and
`rate` = the imputed rate (so the overtime-premium estimate in `mart.job_week` uses it); punches with
a rate keep `hours x rate` (`hours_x_rate`); a punch no rule can price keeps `labor_cost` NULL and
basis `'none'`. Every re-normalization re-applies the upsert (API values) and then re-prices, so the
result is idempotent and follows a `close_lag_days` change on the next sync.

### `company_numbers`

011 fills `ops.app_setting.company_numbers` with `{"1": "Crane IFS", "2": "Crane West",
"3": "Crane Southwest"}` **only when the value is still `{}`** (008's empty seed). With it filled the
14 job numbers that are Sarus jobs in the reference load (300, 400-409, 6325, 99999, BalSheet) are
protected: the reference rows keep the bare numbers and the API's Crane jobs get their own rows
(next section).

### Job-number collisions (migration 012)

Job numbers are only unique within one WinTeam database. The rule, applied in **one** place,
`mart.v_api_job_map`, which the effective views and the normalizer's job lookups (`wt_job_map`,
staged from the view in every normalizer that links facts to jobs) all use:

* an API-sourced fact may only resolve to a current `dim_job` row whose `company` is one of the
  tenant's companies (`company_numbers` labels; a row without a company counts as the tenant's; an
  empty setting means every row) - never to the other namespace's row;
* when the bare-number row is a Sarus job, `normalize_jobs` inserts the API job as its own current
  row under the namespaced number `rules.namespaced_job_number` = `Crane:<number>` (the reference
  loader's convention for identities that are only unique within a database: `ar:Sarus:<invoice>`,
  `fr:Sarus:<vendor>`, the Sarus vendor offset), and the fact resolves to it (`job_number` in
  `mart.v_timekeeping_effective` / `v_ar_invoice_effective` and downstream marts reads
  `Crane:300`). Until that row exists the fact carries the namespaced number with a NULL
  `job_key` - visible, but never attributed to Sarus;
* reference facts keep the bare-number match; the Sarus jobs are untouched.

Before 012 the API's 2 invoices on 300 ("FXE_AGCA Pittsburgh PA") and 193 punches on 401 / 6325
joined the Sarus rows: BDL3/7's August weeks showed $660 of invoicing (`ar_invoice_prorated` from
the Crane invoice) instead of its ~$100K carry-forward. Pure mirror: `marts.resolve_api_job`.

### Enabling the scheduled sync

Once 011 is applied and a first normalization has run, the worker is turned on with
`WINTEAM_ENABLED=true WINTEAM_NORMALIZE=true docker compose up -d --build worker` (the tenant
credentials come from `.env`). Its loop is `winteam.sync_all(normalize=True)` -> per resource
`normalize.normalize_resource` (jobs with the seen ids, timekeeping with the pricing above) ->
`marts.rebuild_all` (job_month, portfolio_month, job_week, forecasts).

First-run sizing: a resource without a watermark backfills `WINTEAM_BACKFILL_MONTHS` (18 by
default), `WINTEAM_LOOKBACK_DAYS` only applies once a watermark exists. On 2026-09-03 `jobs`,
`vendors` and `timekeeping` carry a watermark of 2026-09-03 (the timekeeping one from the bounded
`sync_all(resources=['timekeeping'])` run below); `ap_invoices` / `ar_invoices` do not, so the
first scheduled poll backfills 18 months of both (AR across every `core.dim_customer` number unless
`WINTEAM_CUSTOMER_NUMBERS` bounds it), which widens the AP window accordingly. Set
`WINTEAM_BACKFILL_MONTHS` lower for the first start if that is not wanted.

### Verified on 2026-09-03 (first normalized live sync)

* `normalize_all` on the landed raw set: jobs 629 upserted (`geo_precision = 'exact'` on all 629),
  the 14 Sarus-collision numbers (300, 400-409, 6325, 99999, BalSheet) logged and skipped; vendors
  279; timekeeping 15,470 (3,673 priced at the trailing rate: 3,121 job rate, 552 company rate);
  ap_invoices 316; ar_invoices 285.
* Then `winteam.sync_all(resources=['timekeeping'], normalize=True)` with
  `WINTEAM_BACKFILL_MONTHS=1` (no watermark existed): fetched 33,863 punches (18,393 new raw
  versions), normalized, 4,335 priced at the trailing rate (3,627 job / 708 company), marts rebuilt
  in 14 s; 66 s end to end. `mart.v_source_precedence`: timekeeping 2026-08-01 .. 2026-09-03, AP
  2026-08-20 .. 2026-09-02, 285 API AR invoices, companies Crane IFS / Crane Southwest / Crane West.
* Every punch of 2026-09-01 .. 09-03 arrives with `rate = 0` (payroll not yet run), so September's
  labor basis is `trailing_job_rate` (about $19.5/h) until WinTeam assigns rates; August API punches
  carry rates (about $16.8/h) and re-price the month from the export's trailing rate.
* `mart.job_month` 2026-08: 217,926 h / $4,069,280 (export only) -> 219,222 h / $3,803,389 (API
  punches, `hours_x_rate` on 217 jobs); 2026-09: 7,382 h / $138,455 (export through 09-01) ->
  19,919 h / $379,245 (API through 09-03). `/labor/pace?month=2026-09-01`: labor to date
  $379,245 through 2026-09-03, projected $3.21M vs budget $3.06M.
* AR: the API's `amount_paid` matches the 2026-08-31 aging snapshot on all 211 AMAZ01 invoices
  open in both ($21,933,523.53 open either way): no Amazon invoice the snapshot shows unpaid has a
  payment applied in WinTeam as of the pull. Only invoice 162199 (Jul 2025, $20,806, absent from
  the snapshots and `assumed_paid` by the reference loader) differs: the API shows $13,325.12 paid
  on 2025-08-04 and $7,480.88 still open. `/ar/aging` (snapshot based) is unchanged.
* Sarus export punches inside the window (2,213 / 19,562 h in August) keep counting thanks to the
  company scoping. After 012 the 14 colliding API jobs have their own rows (`Crane:300` ..
  `Crane:BalSheet`, exact coordinates); the API punches on 401 / 6325 / 99999 and the invoices on
  300 / 400 / 6325 resolve to them, and BDL3/7 (Sarus 300) is back on its carry-forward invoicing
  ($111,880.81 / week in August; the Amazon Sarus card reads 58.4% labor for the week of
  2026-08-24). `/executive/labor-pl` lists business units in `bu_order` with `sort_order`.

