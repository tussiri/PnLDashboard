# WinTeam endpoints used by Northstar Facilities

Source of truth: the authenticated TEAM/WinTeam API documentation (`WinTeamAPI.txt`). The connector
(`services/api/app/winteam.py`) only calls the GET endpoints listed here; the documented
`POST /jobs/{jobKey}/budgets` is never called.

## Gateway

| Item | Value |
|---|---|
| Base URL | `WINTEAM_BASE_URL` (documentation shows `http://apim.myteamsoftware.com/wtnextgen`; HATEOAS links use `https://api.myteamsoftware.com/wtnextgen`). HTTPS is required unless `WINTEAM_ALLOW_INSECURE_HTTP=true` for a local simulator. |
| Required header | `tenantId: <GUID>` from `WINTEAM_TENANT_ID` (every documented endpoint lists it). |
| Gateway key | The gateway is Azure API Management, which conventionally needs `Ocp-Apim-Subscription-Key`. The header name is `WINTEAM_SUBSCRIPTION_KEY_HEADER` and it is only sent when `WINTEAM_SUBSCRIPTION_KEY` is set. **The documentation does not mention this header; confirm with TEAM.** |
| Extra headers | `WINTEAM_HEADERS_JSON` (JSON object) is merged into every request. |
| Retries | 429, 5xx, timeouts and connection errors are retried up to `WINTEAM_MAX_RETRIES` times with exponential backoff; `Retry-After` is honoured. |
| Errors | 400/422 bodies `{"errors":[{fieldName,errorMessage,attemptedValue}],success:false,serverResponse}` are surfaced in the sync run's `error_message`. 204 means "no records". |
| Entitlements | HTTP 403 on a resource = the subscription does not include that endpoint (verified 2026-09-03: `job_schedules`, `ap_payments`). The run is `failed` with `error_message = "not_entitled: HTTP 403"`, `GET /integrations/winteam` reports `entitled: false`, `sync_all` continues with the other resources and the worker warns once per resource. |
| Raw only | `WINTEAM_NORMALIZE=false` (or `?normalize=false` on the sync endpoints) lands payloads in `raw.winteam_record` without promoting them to `core`; see `docs/winteam-live-source.md` for how API rows coexist with the `finance_reference` export rows. |

## Envelope and paging

Paged endpoints return

```json
{"data":[{"pageNumber":1,"pageSize":100,"totalPages":7,"totalCount":650,"results":[...]}],"success":true,"serverResponse":"OK."}
```

The connector sends `pageSize=WINTEAM_PAGE_SIZE` and walks `pageNumber` 1..`totalPages`, stopping
early on an empty `results` array. One listing may not exceed `WINTEAM_MAX_PAGES_PER_SYNC` pages.

Date-windowed endpoints are pulled in `WINTEAM_WINDOW_DAYS` chunks. The first run starts
`WINTEAM_BACKFILL_MONTHS` months ago; later runs start `WINTEAM_LOOKBACK_DAYS` before the stored
watermark (the ISO date of the last fully synced window end, advanced only when the whole run
succeeds) so edited punches are recaptured. Dates are sent as RFC3339 UTC:
`dateFrom=2026-08-01T00:00:00Z&dateTo=2026-08-16T23:59:59Z`.

## Resources (dependency order)

| Resource | Method and path | Required params | How we pull it | Record id |
|---|---|---|---|---|
| `jobs` | `GET /jobs/v2/api/jobs` | none (`locationId` optional via `WINTEAM_LOCATION_IDS`) | paged list; one listing per configured location | `jobId` (GUID), else `jobNumber` |
| `vendors` | `GET /vendors/v1/api/vendors/` | none | paged list | `vendorNumber` |
| `timekeeping` | `GET /timekeeping/v2/api/timekeeping` | `dateFrom`, `dateTo` | date windows, paged | `timekeepingId` |
| `job_schedules` | `GET /jobs/v2/api/jobs/{jobKey}/schedules` | `jobKey`, `dateFrom`, `dateTo` | for each active job in `core.dim_job` (limit `WINTEAM_SCHEDULE_JOBS_LIMIT`, 0 = all) x each date window, paged. This is jobs x windows calls; progress is logged every 25 jobs. | `id` |
| `gl_budgets` | `GET /jobs/v2/api/jobs/{jobKey}/gl-budgets` | `jobKey` (`fiscalYear` optional) | for each active job (limit `WINTEAM_GL_JOBS_LIMIT`, 0 = all) x `WINTEAM_GL_FISCAL_YEARS` calendar years (current and previous). Not paged: `{"data":[{jobNumber,fiscalYear,glBudgetId,glBudgetDetails:[...]}]}`; every `glBudgetDetails` element becomes one raw record carrying the header fields. 404, and the live tenant's 400 `JobKey: Invalid Job Number and Fiscal Year combination.`, both mean "no budget for that job/year" (not a failure). | `jobNumber:fiscalYear:id` |
| `ap_invoices` | `GET /accounts/v1/api/payables/invoices` | `dateFrom`, `dateTo` | date windows, paged | `companyNumber:vendorNumber:invoiceNumber` |
| `ar_invoices` | `GET /accounts/v1/api/receivables/invoices/` | `customerNumber` | for each customer number in `WINTEAM_CUSTOMER_NUMBERS` union every number already in `core.dim_customer` (any source; strings such as `AMAZ01` pass through unchanged), paged. Not date-filterable, so every run re-reads all invoices of each customer (unchanged payloads are ignored). With no customer numbers the run succeeds with 0 records and says why. The live response omits `customerNumber` inside each record (the documented sample has it); the connector fills in the queried number. | `customerNumber:invoiceNumber` |
| `ap_payments` | `GET /accounts/v1/api/payables/payments` | `startDate`, `endDate` | date windows, paged (`checkDate`, else `paymentDateAdded`) | `paymentId` |

Response fields are stored verbatim in `raw.winteam_record.payload` and promoted to `core.*` by
`services/api/app/normalize.py` (field mapping documented in `database/migrations/003_winteam_contract.sql`).

## Tenant inputs still required

| Input | Where | Why |
|---|---|---|
| Tenant GUID | `WINTEAM_TENANT_ID` | Required `tenantId` header on every endpoint. |
| Gateway subscription key (and header name if different) | `WINTEAM_SUBSCRIPTION_KEY`, `WINTEAM_SUBSCRIPTION_KEY_HEADER` | Azure APIM gateway authentication; not described in the endpoint docs. |
| Base URL | `WINTEAM_BASE_URL` | Documentation and HATEOAS links disagree on the host. |
| Customer numbers | `WINTEAM_CUSTOMER_NUMBERS` | Receivables can only be read per `customerNumber`; there is no customer listing endpoint. Names are not returned either: put them in `ops.app_setting.customer_names`. The 102 customer numbers of the finance_reference load are already used. |
| Company numbers | `ops.app_setting.company_numbers` (`PUT /api/v1/settings/company_numbers`) | `companyNumber` -> dashboard company label. The production tenant returns 1, 2 and 3 = Crane IFS, Crane West, Crane Southwest (the Crane job master's `CompanyNumber`). Needed to place API jobs in the Crane / Sarus namespace of the reference load. |
| Job tier map | `ops.app_setting.job_tier_map` (`PUT /api/v1/settings/job_tier_map`) | Which `jobTiers[].tierID` holds region, branch, service type, manager and vertical is tenant configuration. |
| Overtime category ids | `ops.app_setting.overtime_category_detail_ids` | Which `categoryDetailId` values are overtime. Empty = derive overtime from hours over `overtime_weekly_threshold_hours` per employee per Sunday-based week. |
| Fiscal year start month | `ops.app_setting.fiscal_year_start_month` | Maps GL budget `period1..period12` onto calendar months; the connector also assumes `fiscalYear` names the calendar year in which period1 falls. |
| GL account classes | `ops.app_setting.gl_account_classes` | Account ranges/keywords that make a budget line revenue, direct labor, subcontract or supplies. |
| Payroll burden rate | `ops.app_setting.payroll_burden_rate` | Fraction of labor cost added as burden in gross profit. |
| Location ids (optional) | `WINTEAM_LOCATION_IDS` | Restrict the job list; jobs outside these locations are marked inactive. |

## Verified against the production tenant (2026-09-03)

* jobs 643 (all with `taxAddress.latitude/longitude`), vendors 279, timekeeping ~8,100 punches per week, ap_invoices ~580 per month, ar_invoices per customer number (AMAZ01 255 invoices, COST01 27, AIRG01 3).
* `job_schedules` and `ap_payments`: HTTP 403 (not entitled). `gl_budgets`: no budget found on the first five active jobs (400 as above, also without `fiscalYear`).
* `jobTiers[].tierValue` arrives as a string; `companyNumber` as a number.
* Redacted samples per resource: `sources/winteam_samples/<resource>.json`.

## Known limitations of the documented API

* Payments are not linked to invoices, so AP open balances cannot be derived (`open_estimate` is null).
* Receivables are not date-filterable and expose `invoiceTotal`/`amountPaid` only; AR open balance = invoiceTotal - amountPaid.
* No endpoint reports deletions; records removed in WinTeam stay in the warehouse until a reviewed tombstone process exists.
* Invoices are attributed to `billingPeriodFrom` month (else invoice month) and are **not** recognized revenue until Finance approves that definition.
