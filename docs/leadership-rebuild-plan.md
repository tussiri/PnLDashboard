# Leadership P&L rebuild: Phase 0 audit and plan

Status: approved 2026-09-23. Decisions: nightly incremental WinTeam sync plus on demand; prior-month
labor % includes subcontractor cost; retired views are deleted. Export feeds: `docs/export-feeds.md`.
Reference: `PlanoISD_Labor_PL_Dashboard_WE_Sep20.html` (86 Plano jobs, week ending Sun 2026-09-20,
August 2026 revenue ÷ 4.33, target 64.5%).

## 1. What exists today

The repo already has most of the plumbing. This is a restructure, not a greenfield build.

| Area | Today | Decision |
|---|---|---|
| Warehouse | PostgreSQL 16, schemas raw/core/mart/ops, migrations 001–027 | Keep; add 028+ |
| Weekly fact | `mart.job_week` (Monday weeks; hours, OT, budget hrs/$, invoicing, direct/OT/sub $, employees) | Keep and extend (section 4) |
| Monthly fact | `mart.job_month`, `core.fact_job_cost_month` | Keep; fix the job 800 double count (section 2) |
| Sync runs | `ops.integration_sync_run`, watermarks, `/data/freshness` | Keep; surface in the shell |
| WinTeam connector | Documented endpoints only, on demand, raw landing + normalize | Keep |
| Export source | `finance_reference`: a restored Postgres dump only; no file upload | Add a CSV/XLSX import adapter |
| Account model | `key_accounts`, `account_groups` and `sub_account_rules` settings (name rules) | Replace for featured accounts with explicit job mapping tables |
| Executive view | `ExecutivePL.tsx` + `components/executive/*`: Chart.js 4, 1180px shell, 14px, tabs BU Overview / per-BU / OT Analysis; state not in the URL; target read-only from `bu_targets` | Base of the rebuild: keep `model.ts`, `ExecChart`, `ChartCard`, `OtAnalysisTab`; replace the tab set |
| Legacy views | 16 routes on Recharts and the global filter bar (Financial, Revenue, Cost, Margin, Billing, Budget, Forecast, Labor, Timekeeping, Sites, Accounts, Geography, Alerts, Reports, Data dictionary) | Retire (section 3) |
| Map | `OperationsMap` (Leaflet, clusters, heat), colored by `/jobs` status | Keep; color by labor % status |
| Site page | `JobDetail.tsx` full page with AR invoices, subcontractors table, CompanyCam placeholder | Replace with a drawer |
| CompanyCam | `companycam.py`: status, admin probe, `photos_for_project`; not configured locally; match rule unset | Add explicit job-to-project mapping and a photo route |
| Tables | `DataGrid` (keyboard sort, `aria-sort`, CSV); executive tabs use their own plain table | Use `DataGrid` everywhere |
| Theme | `styles.css` (80KB, mostly legacy pages), light only, no dark tokens | Rebuild on the reference tokens with light/dark |
| Routing | Hand-rolled hash router; global filters in localStorage | Keep the router; move account/week/target into the URL |
| Tests | Vitest 17 files (~119 tests, logic only); API pytest 17 files | Keep; add fixture tests |
| Dead code | `LaborDashboard.tsx`, `adapters.ts`, `dataMart.ts`, `dataverse.ts`, `metabase.ts`, `winteam.ts`, `platformApi.ts` | Delete |

## 2. WinTeam data access and the reproduction check

Documented endpoints (`WinTeamAPI.txt`): timekeeping, jobs, job budgets, job GL budgets, job
schedules (403), AP invoices (list and per invoice), AR invoices, AP payments (403), vendors.

| Need | Source | Status |
|---|---|---|
| Customer/job hierarchy | `jobs`: jobNumber, parentJobNumber, companyNumber, supervisorId, tiers, lat/long | Partial. No customerNumber on jobs (inferred from AR invoices); no customer list or names |
| Hours | `timekeeping`: hours, `categoryDetailId`, rate | Yes |
| Regular vs OT | Punches carry many `categoryDetailId` values (1, 104, 136, 87, ...) but their meanings are unknown (the lookup is in the 403 Schedules service); OT is derived from a 40-hour weekly threshold | **Partial.** Mapping the ids needs TEAM or a WinTeam admin |
| Labor $ | No pay amount; 65% of that week's punches have rate 0 until payroll runs | **Gap.** Estimated at the job's trailing rate |
| Budget hours / $ | `GET jobs/{job}/budgets` (documented in the Jobs v2 OpenAPI, works) and the daily budget export; GL budgets return 400 for 2,772 of 2,808 job-years | Yes |
| Monthly revenue | Job Cost Analysis export; AR invoices by billing period (per customer number) | Yes |
| Subcontractor invoices by site | `GET payables/invoices/{n}` (published Accounts v1 OpenAPI) carries GL distributions with jobNumber; ~1,000 invoices return 404; the last run failed after 25 consecutive errors. Vendor type: `vendorTypeId` 6 = Subcontractor | Yes, after fixing the detail sync |
| Employee pay rates, OT methods, supervisors, shift hour types | Employees v1 and Schedules v1 | **HTTP 403** on every GET (probed 2026-09-23); not in the subscription |

Warehouse against the reference, week of 2026-09-14 (week ending 09-20), Plano jobs 800–896:

| Field | Reference | Warehouse | |
|---|---|---|---|
| Job list | 86 | 86 | exact |
| Employees | 299 | 299 | exact |
| Hours, jobs 800 / 801 / 896 | 842.55 / 140.43 / 585.95 | same | exact |
| OT hours, 801 | 12.26 | 12.26 | exact |
| OT hours, 800 / 896 | 272.73 / 417.76 | 268.68 / 309.41 | 40-hour rule vs payroll |
| Budget, 801 | 45.8 hrs, $701.65 | 45.8, $701.66 | exact |
| Weekly labor $ | 234,258.30 | 213,166.81 | −9%, trailing-rate estimate |
| OT $, 801 | 306.42 (full 1.5× pay) | 105.01 (premium only) | different definition |
| August revenue | 1,026,956 | 1,026,955.53 in job cost | exact |
| August sub, 800 | 12,112 | 12,111.57 on GL 44000 | exact; warehouse also adds GL 44002 |
| August labor, 800 / 801 | 145,805 / 8,791 | 71,077 / 3,468 | **no source matches** |
| Weekly invoice | 237,172 (÷ 4.33) | 481,407 | method difference plus the defect below |

Defect found: `mart.job_month` puts the district's whole AR invoice (1,026,955.55) on job 800 on
top of the per-school job-cost revenue, so Plano's August revenue doubles to 2,053,911.

Conclusion: hours, headcount, budget, revenue and sub reproduce exactly. Weekly labor $, OT $ and
OT hours reproduce exactly only from the Pay Report Timekeeping export. The API does not carry pay
amounts or an OT category. The import adapter is on the critical path, not a fallback. The
reference's August labor figures come from a source we do not hold.

## 3. Information architecture

Top nav, 1180px shell. The account, week and target are in the URL:
`#/account/plano-isd/sites?week=2026-09-20&target=64.5`

1. **Home**: portfolio strip across the 8 featured accounts (labor %, $ over target, OT %,
   change vs prior week), then the reference Overview for the selected account.
2. **Account**: tabs Overview, Sites, Over Target, Overtime, Map, Vendors. A site row opens a
   drawer with the weekly labor P&L, a 13-week trend, CompanyCam photos and subcontractor
   invoices.
3. **Analytics**: every account including Other; drill account → segment → site; filters, sort,
   CSV.
4. **Admin** (admin role): accounts and job mappings, imports, sync runs and freshness, settings.

The header shows "Data as of" and sync status. The notes panel generalizes the reference notes:

- catch-all job
- non-billed job
- billed with no labor
- budget hours below a reliability ratio
- labor $ estimated (no pay report for the week)
- stale import

Roles: executive and analyst see Home, Account and Analytics; admin also sees Admin.

## 4. Data model (migration 028+)

- `ops.account`: slug, name, featured, sort, target_labor_pct, revenue_method
  (`monthly_div` | `weekly_billing` | `per_visit`), revenue_divisor (4.33),
  budget_reliability_ratio.
- `ops.account_job`: account, company, job_number, segment, role (`site` | `catch_all` |
  `non_billed`), companycam_project_id. Explicit mapping; unmapped jobs roll into Other.
- `ops.account_segment`: account, segment, sort, is_fallback.
- `ops.import_file`: kind (`pay_report` | `job_cost` | `daily_budget`), file hash, period, rows,
  status, errors, uploaded_by. Replays by hash are idempotent.
- `mart.job_week` gains:
  - `labor_gross` and `ot_gross` (full pay)
  - `labor_basis` (`pay_report` | `payroll_rate` | `trailing_rate_estimate`)
  - `invoice_week` and `revenue_month` per the account's method
  - nullable `consumables_cost` and `consumables_basis`
- Unchanged: `core.dim_job` (sites), `mart.job_month` (monthly revenue), budget facts,
  `core.fact_ap_invoice` / `fact_ap_distribution` (vendor invoices), `ops.integration_sync_run`.

Seed: the 8 featured accounts. Plano is Crane Southwest, 93 jobs under parent job 800. Its segments
come from a one-time mapping file, not name regex:

- the five school types
- 800 as catch-all
- 896 as non-billed

Today Plano, White Settlement (14 sites) and Henderson ISD are sub-accounts of "Education" (label
"School districts") under name rules. Each becomes its own featured account. Henderson shares the
job range 900–948 with Crowley. Apple/Retail has no rule or account anywhere and needs a job list.

## 5. Derived metrics

One TypeScript module computes every metric from week rows and the target, as the reference does,
so a target change recalculates instantly:

- invoice = monthly revenue ÷ divisor (or the account's method)
- labor % = labor ÷ invoice; null when the invoice is 0
- base rate = labor ÷ (hours + 0.5 × OT hours)
- $ over = max(0, labor − invoice × target)
- hours over = $ over ÷ base rate
- OT premium hours = 0.5 × OT hours, capped at hours over
- OT premium $ = OT $ ÷ 3
- status: On target at or below target, Watch up to target + 10 pts, Over above that
- account labor % = (sites + catch-all) ÷ invoice; non-billed jobs are excluded
- the catch-all counts in full as hours over, at its own base rate
- prior-month labor % comes from `mart.job_month`

Tests use the reference's 86 rows and August block as fixtures. They assert the reference outputs:

| Output | Expected |
|---|---|
| Weekly invoice | 237,172.29 |
| Account labor % | 93.28% |
| Sites labor % | 84.76% |
| Sites over target | 72 |
| Hours over target | 3,523.1 sites + 978.9 catch-all |
| $ over target | 55,593.54 |
| Billed with no labor | jobs 882, 883 |
| Budget hours ratio | 49.5% |

## 6. Sync design

- Adapter interface `LaborSource` with two implementations that write the same staging records:
  - the WinTeam API (existing connector)
  - export import (CSV/XLSX upload in Admin)
- Labor $ precedence per job-week, labeled by `labor_basis`:
  1. pay report
  2. payroll-processed rate
  3. trailing-rate estimate
- After any sync or import: normalize, rebuild marts, record the run.
- Fix the AP detail sync and restrict the sub cost to the subcontract GL range from a setting.
- Schedule: see decision 1.

## 7. Build order (small commits, each shippable)

1. Fixtures, metric module and tests; `docs/consumables-strategy.md`.
2. Fix the job 800 revenue double count; migration 028 account config and seed; Admin mapping view.
3. Export import adapter (pay report first), labor basis precedence, `job_week` extension,
   `/api/v1/leadership/*` routes. Change the contract doc, router, `apiTypes.ts` and `demoApi.ts`
   together.
4. Shell: reference tokens with light/dark, top nav, header selectors, URL state, freshness.
5. Home: portfolio strip and Overview.
6. Account page: Sites, Over Target and Overtime tabs.
7. Map tab, site drawer, subcontractor invoices, AP detail fix, CompanyCam mapping and photo route.
8. Analytics with drill-down and CSV.
9. Scheduling (decision 1), stale and partial notes, remove the retired views and Recharts.

## 8. Decisions (resolved 2026-09-23) and inputs still needed

1. **Scheduled sync.** The standing rule is that WinTeam syncs run on demand only and nothing
   polls it. A nightly schedule reverses that.
2. **Prior-month labor %.** The reference labels it "incl. sub" but computes labor ÷ revenue
   without adding sub. Its August labor matches no source in the warehouse.
3. **Documented set.** `WinTeamAPI.txt` lists 9 endpoints; the published OpenAPI documents (five
   now in `config/winteam-openapi/`, plus Accounts v1) also document `GET jobs/{job}/budgets` and
   `GET payables/invoices/{n}`, which the connector already uses. Proposal: treat the published
   OpenAPI documents as the documented set, GET only. Employees and Schedules answer 403, so they
   add nothing today. `POST timekeeping/overtime` would return WinTeam's own regular and OT
   dollars, but stays uncalled until TEAM confirms it does not write.
4. **Retired views.** Hide now and delete later, or delete in the shell commit.
5. **Inputs:**
   - the Pay Report Timekeeping export for week ending 2026-09-20 (spec in `docs/export-feeds.md`);
     the reference's August labor is that report's `total_labor_dollars` for the month (job 801
     matches to the dollar)
   - the job list for Apple/Retail, and which "Henderson" is meant (Henderson ISD or another)
   - segment schemes for the other seven accounts
   - revenue method per account (÷ 4.33 until confirmed)
   - a CompanyCam token
   - from a WinTeam admin: which hour category ids are overtime and double time (setting
     `overtime_category_detail_ids`), and whether TEAM can add Employees v1 to the subscription
