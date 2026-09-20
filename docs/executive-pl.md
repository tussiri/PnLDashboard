# Executive labor P&L (weekly)

Last updated: 2026-09-04 (vendor cost projection and the live AP look, section 9, with the scope split and vendor type labels of migration 016; sub-accounts and delivery slicing, section 8). Backend for the executive "Labor P&L Dashboard" replica: weekly labor
cost, hours and overtime by site and business unit, labor % of invoicing against BU targets, for
any parent account. Weeks are Monday-based ("Week of Aug 24").

| Piece | Where |
|---|---|
| Inputs added for it | `core.fact_daily_budget`, `core.contract_billing` (migration 007; loaded by `sources/finance_reference.py`) |
| Mart | `mart.job_week`, one row per (job, Monday week), rebuilt by `app/weekly.py::rebuild` at the end of every `marts.rebuild_all`; `sub_account` (migration 014) labelled by `weekly.apply_sub_accounts` in the same transaction |
| API | `GET /api/v1/executive/labor-pl`, `GET /api/v1/executive/accounts` (`routers/executive.py`; contract in `docs/api-contract.md`) |
| Settings | `bu_targets`, `bu_colors`, `agency_sub`, `ot_bands` (007), `bu_order` (012), `key_accounts` (013), `sub_account_rules` (014), `subcontractor_vendor_types` (015), `vendor_type_labels` (016) in `ops.app_setting`, editable through the admin API |
| Tests | `services/api/tests/test_weekly.py` (pure: overlap shares, 12/53, OT estimate, basis order, site codes, sub-account rules, delivery scoping SQL, accounts shape, the sub projection, vendor-type matching, the vendor block) |

The original lives in Finance_Reporting (`cfo_dashboard/account_pl.py`, `transformations/_timekeeping.py`).
The SQL in `weekly.py` is the authoritative implementation; the pure Python functions next to it
mirror the rules for unit tests and the API notes.

## 1. Row universe

A `(job, week)` row exists for every Monday week up to the current week (`week_start <= today`) in
which the job has any timekeeping or any daily budget row, or that overlaps a month with monthly
revenue, subcontract cost, labor budget, hours, AR invoices or agency-sub AP invoices. Rows carry the
job's parent account, company (= business unit), delivery model and `site_code` (the token after
`" - "` in the job name: "Amazon - LGB3" -> "LGB3"; otherwise the whole job name).

The current week is partial until Sunday's punches are loaded; `days_with_labor` (distinct work
dates in the week) says how complete it is. The API's default `selected_week` is the latest week in
scope with `days_with_labor = 7`.

## 2. Slices: apportioning monthly figures to weeks

Every week is split into one slice per calendar month it overlaps (a straddle week such as Jul 27 -
Aug 2 has a 5-day July slice and a 2-day August slice). Monthly figures are apportioned to a slice
by calendar days: `monthly x slice_days / days_in_month`. The weekly slices of a month therefore
reconcile to the month exactly. `mart.job_week.month_shares` records every slice's days and bases,
and the week's basis labels are those of the dominant slice (most days among non-`none` slices).

## 3. Definitions and bases

| Field | Definition | Basis values |
|---|---|---|
| `hours`, `ot_hours`, `dt_hours` | `core.fact_timekeeping` by work-date week: total, overtime and double-time hours (the timekeeping categories) | - |
| `direct_dollars` | STRAIGHT-TIME labor: `sum(fact_timekeeping.labor_cost)` = hours x the job rate. No premium. | `labor_cost_basis`: `trailing_job_rate` (reference source: the job's trailing closed-month job-cost rate, direct labor / actual hours) or `hours_x_rate` (WinTeam API) |
| `ot_dollars` | ESTIMATE of the premium: `ot_hours x rate x 0.5 + dt_hours x rate x 1.0`, at each row's rate | always an estimate; the feeds do not carry the paid premium |
| `invoicing` | per slice, first that applies: (1) closed month with job-cost revenue -> `revenue x days / days_in_month`; (2) `core.contract_billing` amount effective for the month (latest `effective_month <= month`) -> `monthly_amount x 12/53 x days / 7`; (3) AR invoices for the service month -> `revenue_total x days / days_in_month`; (4) the job's most recent month, among the last 3 closed months before the slice's month, with job-cost revenue or AR service-month revenue > 0: `GREATEST(job-cost revenue, AR revenue)` of that month prorated exactly like (1), flagged `invoicing_estimated = true` with `carry_forward_source` = `job_cost` or `ar_invoice` (migrations 009 / 010); (5) 0 | `job_cost_month_prorated`, `contract`, `ar_invoice_prorated`, `carry_forward` (`invoicing_estimated`, `carry_forward_source`), `none` |
| `sub_dollars` | per slice, the month's known subcontract cost x day share. Known cost = the job-cost subcontractors line in a closed month; for the sites in `agency_sub`, the vendor's AP invoices coded to the site (invoice-number prefix, e.g. `LGB3027` -> LGB3, `PSP001` -> PSP3) x `pct`, by invoice month, when the job-cost line is empty. A month that is not closed and has no known cost is PROJECTED (section 9): the site's average weekly subcontract cost over its job-cost months among the last 3 closed months, x the slice's days / 7; a site with no such month projects 0. A closed month with nothing booked is 0. | `sub_basis`: `job_cost`, `agency_ap`, `trailing_3mo_projection` (`sub_estimated = true`), `none` |
| `budget_dollars`, `budget_hours` | per slice: `core.fact_daily_budget` summed over the slice's days when the job's daily rows cover the slice; else the monthly labor budget (`core.fact_labor_budget_month`: daily-budget month sum, hours budget comparison or wage by job) x day share; else null | `daily_budget`, `hbc`, `none` |
| `total_dollars` | `direct + ot + sub` | - |
| labor % (browser) | `total_dollars / invoicing`; BU target / high from `bu_targets` | - |

"Closed month" = a month `mart.job_month` reports on the job-cost basis (`revenue_basis = 'job_cost'`:
covered by a job-cost import and past `close_lag_days`). The monthly marts are rebuilt first, so the
weekly figures reconcile to them: for a closed month, the sum of a job's weekly `invoicing` slices
equals its `mart.job_month.revenue`, and the sum of its `sub_dollars` slices (basis `job_cost`)
equals `subcontract_cost`.

### The 12/53 rule

The original dashboard derives weekly invoicing from a monthly contract amount as
`monthly x 12/53 x (days of the week inside the month / 7)`: twelve months of billing spread over the
53 week-starts a year can have. It applies only when `core.contract_billing` has an amount for the
job and month. The restored reference database has no `app.contract_billing` table, so the table is
empty and the basis never applies today; the loader records `contract_billing.present = false` in
its notes and the API says so in `notes`.

## 4. Loader (finance reference source)

`POST /integrations/finance-reference/load` gained two steps after the labor budget:

* `fact_daily_budget`: `core.fact_daily_budget` from the reference `core.fact_daily_budget` (one
  row per job and day, latest non-superseded import per day; company aliased; job numbers as
  exported - the daily budget export exists for the Crane databases only, so no Sarus namespacing
  is needed). Coverage in the current dump: 2025-12-05 to 2026-07-26, 198 jobs.
* `contract_billing`: `core.contract_billing` from the reference `app.contract_billing` when the
  table exists (it does not in the current dump).

Both tables and `mart.job_week` are in `RESET_TABLES`, so a reload replaces them.

## 5. API

`GET /executive/labor-pl?account=All|<parent_account>&sub_account=<name>&delivery=all|self_perform|subcontracted&weeks=18&week=YYYY-MM-DD`

* `account`: "All" = the `key_accounts` setting combined; `sub_account` narrows to one
  `mart.job_week.sub_account` label; `delivery` (default `all`, anything else is a 422) narrows by
  delivery model - see section 8. Both are echoed in the response.
* `weeks`: window of Mondays ending at the latest week with labor in scope (when `week` lies
  outside it, the window ends at `week`). `weeks` in the response lists every Monday of the window.
* `selected_week`: `week` if given (must be a Monday, else 422), otherwise the latest full week.
* `business_units`: from `bu_targets` / `bu_colors` (key = slug, name, color, target_pct, high_pct),
  plus any company found in the rows that is not configured (null targets).
* `rows`: contract fields (including `invoicing_estimated`, `sub_account`, `delivery_model`) plus `sub_basis`. `ot_bands` echoes the OT % thresholds setting.
* `vendor`: the selected week's month vendor-cost block (projected month subcontract cost, live AP look,
  6-month history) - section 9; `null` when the scope has no rows.
* `notes`: every derivation above, the selected week's invoicing / subcontract / budget basis mix,
  how many of the selected week's sites are on the carry-forward basis (and the estimated $), the
  selected week's delivery split (self-performed sites and their labor, subcontracted sites and
  their vendor cost, and how unlabelled jobs were counted), the contract-billing state, the daily
  budget span, and that QA scores are unavailable.
* `qa`: always null.

`GET /executive/accounts` -> `{source, accounts: [{name, label, sites, business_units, delivery, sub_accounts}]}`:
"All" first (the key accounts combined: sites, BUs, `delivery` site counts, no `sub_accounts`), then
the `key_accounts` setting in its order, each with `sites` = distinct jobs in `mart.job_week`,
`business_units` = the companies present (in `bu_order`), `delivery: {self_perform, subcontracted}`
site counts and `sub_accounts: [{name, sites, delivery}]` ordered by sites desc then name. A job's
delivery for these counts is its `delivery_model`, or self_perform when it has any hours in the
mart, else subcontracted (the row rule of section 8 applied to the job's total).

## 6. Differences from the original Amazon dashboard

* **No QA scores.** They are not in the warehouse; `qa` is null and the note says so.
* **No Elite BU.** The data carries four companies (Crane IFS, Crane West, Crane Southwest, Sarus);
  Crane Southwest is new relative to the original's three configured BUs and is seeded with the
  Crane IFS targets.
* **OT dollars are estimated** (0.5 / 1.0 premium at the trailing job rate). The original used the
  export's straight-time OT/DT dollars at the base rate (or loaded dollars for a few sites); neither
  feed carries the paid premium here.
* **Direct dollars use the trailing job-cost rate**, not the export's `dollars` field (the reference
  dump's timekeeping dollar fields are unreliable, roughly $79/h).
* **Invoicing precedence differs**: the original went contract -> billed AR -> carry-forward of the
  last AR month (flagged estimated). Here the finance-approved closed-month job-cost revenue comes
  first, contract second, AR third, and the carry-forward (fourth) carries the greater of the job's
  job-cost and AR revenue for its most recent month with either, from the last three closed months
  only; it is flagged `invoicing_estimated` on the row with `carry_forward_source` saying which won. With `contract_billing` empty, the 12/53
  rule is dormant.
* **Sub dollars prefer the job-cost subcontractors line** in closed months; the KM Group agency
  allocation (x 0.70 to LGB3 / APC2 / PSP3) fills months where that line is empty, and the
  trailing-3-closed-months projection (section 9) applies to non-closed months only. The original
  used the AP allocation alone.
* **Budget**: daily budget first, then the monthly budget x day share (the original preferred the
  HBC monthly budget before daily rows landed; the education school-days special case is not
  needed because the daily rows already carry the school-day shape where they exist).
* The current week is included as a partial week (the original only listed loaded weeks).

## 7. Verification against the reference load (2026-09-03)

`POST /integrations/finance-reference/load` -> 15,556 `mart.job_week` rows (618 jobs, weeks
2025-06-30 .. 2026-08-31), 21,011 daily budget rows, 0 contract billing rows (table absent in the
reference database).

`GET /executive/labor-pl?account=Amazon`: 18 weeks 2026-05-04 .. 2026-08-31, `selected_week`
2026-08-24 (the last week with 7 days of labor; `as_of` 2026-09-01), 395 rows. Selected-week sites:
Crane IFS = DET3, DET6, DET6 MM, DTW1, IAG1, SBN1, ZDT2; Crane West = APC2, CAZ5, LGB3, MCC1, PSP3,
UCA5, USD1, USF4; Sarus = BDL3/7, DCY2.

July reconciliation (Amazon): the weekly `invoicing` slices of the 21 sites on the
`job_cost_month_prorated` basis sum to $2,610,814.73 against $2,610,814.74 of July job-cost revenue
in `mart.job_month` (cent rounding); per site the difference is <= $0.02. The three Amazon sites with
no July job-cost row (BDL3/7 $498,393, DCY2 $36,668, Project - Crane West $396,111) take the
`ar_invoice_prorated` basis, so the weekly total for July ($3.54M) is higher than the monthly mart's
job-cost total, by exactly those AR amounts. Sarus has only 14 job-cost rows in July, which is why
its Amazon sites are on the AR basis.

Selected week (2026-08-24) BU totals with the carry-forward basis (migrations 009 / 010; 16 of 17
Amazon sites carry their most recent recent-closed month's revenue forward - 12 from the job-cost
figure, 4 from AR - $718,937 of $718,937 estimated):

| BU | Invoicing (est.) | Direct | OT est. | Sub | Total | Labor % | Target / high |
|---|---|---|---|---|---|---|---|
| Crane IFS | $346,452 | $213,876 | $16,865 | $34,727 | $265,468 | 76.6% | 64.5 / 70 |
| Crane West | $251,664 | $178,080 | $10,327 | $23,441 | $211,848 | 84.2% | 59.5 / 65 |
| Sarus | $120,820 | $64,514 | $5,057 | $627 | $70,197 | 58.1% | 64.5 / 70 |
| All | $718,937 | | | | $547,512 | 76.2% | |

Examples: IAG1 carries July AR $144,054 (its July job-cost row held only $18,636) -> $32,528 for
the week, labor % 126.6% (its $34,727 sub carried from July dominates); BDL3/7 carries July AR
$498,393 (no July job-cost row) -> $112,540, labor % 56.4%; CAZ5 carries July AR $65,544 -> $14,800,
labor % 136.2%. USD1 / USF4 stay above 100% on their own July job-cost figures ($30.9k / $33.3k).
May - July weeks carry $787k - $913k of weekly invoicing on the job-cost basis.

### Known gaps

* **Current-week invoicing is an estimate.** August is not closed, no AR invoices with an August
  service month are in the dump, and `contract_billing` is empty, so every August week is on the
  `carry_forward` basis (`invoicing_estimated = true`): the greater of the job's job-cost and AR
  revenue for its most recent month with either, among the last three closed months (May - July),
  prorated by calendar days; `carry_forward_source` says which figure won. Filling
  `core.contract_billing` (an admin table by design: job_number, effective_month, monthly_amount)
  replaces the estimate with the 12/53 rule. A straddle week is flagged estimated when any of its
  slices is carried forward (its `invoicing_basis` stays that of the dominant slice).
* **Sub in August / September is a projection** (section 9; until 2026-09-04 it carried July
  forward, and July holds unusually large subcontract lines: $709k across Amazon vs ~$130k/month
  before, so the carry-forward overstated the current weeks by about 2x). Each row is flagged
  `sub_estimated`; APC2 uses its August KM Group invoice for its August slice (`agency_ap`).
* **Budget for Jul 27 - Jul 31** falls to the monthly basis because the daily rows end on
  2026-07-26, and July's monthly figure is itself the daily sum through the 26th, so that slice is
  slightly understated. It resolves when the daily budget export is extended.
* Budget `none` rows are jobs with no labor budget at all (project / management jobs).

## 8. Sub-accounts and delivery model (migration 014, 2026-09-04)

`mart.job_week.sub_account` is the second level under a key account, so the executive page can
slice a district or a FedEx operating company without a new parent account. It is derived per job
by `weekly.sub_account_for(account, job_name, customer_name, rules)` from the setting
`sub_account_rules` and written back by `weekly.apply_sub_accounts` at the end of every rebuild
(a Python pass over the current `core.dim_job` rows with a parent account; one `UPDATE ... FROM
unnest(...)` on `job_key`). Jobs without a parent account keep NULL.

`sub_account_rules` = `{account: {basis, prefix_map, default}}`, `"*"` for every other account:

```json
{"Education": {"basis": "customer_name",
               "prefix_map": {"ws-": "White Settlement Independent School District",
                              "white settlement": "White Settlement Independent School District",
                              "plano": "Plano Independent School District",
                              "henderson": "Henderson Independent School District",
                              "crowley": "Crowley Independent School District",
                              "crawley": "Crowley Independent School District",
                              "aldine": "Aldine Independent School District"}},
 "FedEx": {"basis": "job_prefix", "prefix_map": {"fxe": "FedEx Express (FXE)", "fxg": "FedEx Ground (FXG)"}, "default": "FedEx"},
 "*": {"basis": "customer_name"}}
```

For a job in account A, with `rules[A]` else `rules["*"]`:

1. a `prefix_map` key (longest first) that the lower-cased job name starts with as a whole word
   ("plano" matches "Plano - Wells Elementary" and "Plano Independent School District", not
   "Planoville"; "fxe" matches "FXE_AGCA Pittsburgh PA"; a key ending in punctuation such as "ws-"
   matches wherever it starts) -> its label. On the `customer_name` basis the key may also be an
   inner word ("ISD Plano - Wells"); on the `job_prefix` basis only the leading word counts, so
   "FedEx - FXE Ramp" does not become Express;
2. else, on the `customer_name` basis, the job's AR customer name when it is non-empty and differs
   from the account name (case-insensitive) -> the customer name;
3. else `default` when set, else the account name.

Hence FedEx: "FXE_..." -> FedEx Express (FXE), "FXG_..." -> FedEx Ground (FXG), "FedEx - City, ST"
and "FXPO_..." -> FedEx (the default; the AR customer "FedEx - CA" is ignored on the job_prefix
basis). Education: Plano / Crowley (incl. the "Crowley ISD" district job and the "Crawley" spelling)
/ White Settlement ("WS-..." sites and the district job whose customer is abbreviated "...Dist.",
which is why "white settlement" was added to the seeded map) / Henderson ("Henderson-..." and
"Henderson High School"); a district not in the map falls back to its customer name, else
"Education". Amazon: every job -> "Amazon.com Services LLC" (a job without a customer -> "Amazon");
Whole Foods: "Whole Foods Market" or "Whole Foods" (the customer that equals the account); Aldi:
"ALDI Inc.". The rules are a setting, so a new district needs a map entry, not a deploy.

**Delivery model.** `delivery=self_perform|subcontracted` filters rows by
`coalesce(delivery_model, CASE WHEN hours > 0 THEN 'self_perform' ELSE 'subcontracted' END)`
(`executive.DELIVERY_SQL`): a job without a delivery model in `core.dim_job` counts as
self-performed in a week where it has hours and as subcontracted otherwise, and the notes say how
many such sites the selected week has. Row semantics are unchanged: `hours` / `ot_hours` /
`direct_dollars` / `ot_dollars` are self-performed labor (a subcontracted site normally has none,
but a site flagged subcontracted that still books punches keeps them - e.g. FedEx RCNC below);
`sub_dollars` is the vendor cost apportioned from the job-cost P&L or the agency rule; vendor
identity is not job-linked in WinTeam, so the split is per site, not per vendor.

### Verification (2026-09-04, after `POST /marts/rebuild`: 16,191 rows, 706 jobs labelled)

Distinct `sub_account` values (sites = distinct jobs in `mart.job_week`):

| Account | Sub-account | Sites | Self-performed / subcontracted |
|---|---|---|---|
| FedEx (332) | FedEx | 154 | 61 / 93 |
| | FedEx Express (FXE) | 125 | 10 / 115 |
| | FedEx Ground (FXG) | 53 | 4 / 49 |
| Amazon (27) | Amazon.com Services LLC | 27 | 11 / 16 |
| Education (149) | Plano Independent School District | 87 | 86 / 1 |
| | Crowley Independent School District | 38 | 37 / 1 |
| | White Settlement Independent School District | 14 | 14 / 0 |
| | Henderson Independent School District | 10 | 10 / 0 |
| Whole Foods (16) | Whole Foods Market | 10 | 4 / 6 |
| | Whole Foods | 6 | 1 / 5 |
| Aldi (2) | ALDI Inc. | 2 | 1 / 1 |

"All" = 526 sites, 239 self-performed / 287 subcontracted. No row has a NULL `sub_account`.

`GET /executive/labor-pl?account=Education&sub_account=Plano Independent School District`:
selected week 2026-08-24, 87 sites (all Crane Southwest), invoicing $463,786.37, hours 12,913.36
(OT 2,575.58), direct $208,370.40, OT est. $21,652.26, sub $903.23, total $230,925.89 (labor 49.8%),
budget $95,198.31; delivery split 86 self-performed ($204,353 labor), 1 subcontracted ($903).

`GET /executive/labor-pl?account=FedEx&week=2026-08-24`: 110 sites, 6,449.82 h, sub $125,695.85.

* `delivery=subcontracted`: 54 sites (52 FXE, 2 FedEx), sub_dollars $125,695.85, invoicing
  $141,541.11, hours 86.47 - all from one site, RCNC, whose job is flagged subcontracted but books
  punches (direct $1,654.73, OT est. $16.84); every other subcontracted site has 0 h. 4 of the 54
  are jobs without a delivery model and no hours that week.
* `delivery=self_perform`: 56 sites (50 FedEx, 5 FXE, 1 FXG), hours 6,363.35 (OT 564.87), direct
  $120,438.40, OT est. $5,284.75, sub $0, invoicing $262,725.07; one site ("City of Industry, CA
  Pallet", 97.01 h) has no delivery model and counts as self-performed by the hours rule.
* 54 + 56 = 110 and 86.47 + 6,363.35 = 6,449.82 h: the two slices partition the account.

`delivery=vendor` -> 422 "delivery must be one of all, self_perform, subcontracted". An unknown
`sub_account` returns no rows with a note that says the scope is empty.

## 9. Vendor cost: projection and the live AP look (migration 015, 2026-09-04)

Contract: `docs/api-contract.md`, "Vendor cost: projection and live AP look".

### 9.1 Projection for weeks in a month that is not closed

`mart.job_week.sub_dollars` for a slice in a month that is not closed no longer carries the site's
latest known month forward (July 2026's one-off subcontract lines were being carried into every
August and September week). It is now a projection from the site's recent closed months:

```
weekly_rate = avg over the job's job-cost months m among the last 3 closed months before the slice's month
              of  subcontract_cost(m) / days_in_month(m) x 7
slice sub   = weekly_rate x slice_days / 7                      (sub_basis 'trailing_3mo_projection', sub_estimated = true)
projected month (month_shares[month].sub_month) = weekly_rate x days_in_month / 7
```

* "Closed months" are the months `mart.job_month` reports on the job-cost basis, as everywhere in
  this mart; the window is the last `TRAILING_SUB_MONTHS` (3) of them before the slice's month, and
  the average runs over the job's rows in that window with `revenue_basis = 'job_cost'` (1..3
  months: a booked 0 lowers the rate, a month without a job-cost row for the job is simply absent).
* A job with no job-cost month in the window projects 0 with `sub_basis = 'none'`.
* Closed months (`job_cost`, apportioned by calendar days) and the agency rule (`agency_ap`, which
  still wins for its sites' months with a KM Group invoice) are unchanged. A partial job-cost line
  in a non-closed month (`mart.job_month.revenue_basis` null / `job_cost_partial`) is NOT used; the
  month is projected until it closes.
* `month_shares[month]` gains `sub_month`: the monthly figure the slice was apportioned from (the
  job-cost line, the agency allocation, or the projected month), so a month's projected vendor cost
  over a set of sites can be summed without re-deriving it.
* Pure twins: `weekly.trailing_weekly_sub_rate(closed_months)` and
  `weekly.project_weekly_sub(closed_months, week_days_in_month, days_in_month)`; the SQL is the
  `trail` lateral in `JOB_WEEK_SQL`. `carry_forward` stays in the `sub_basis` CHECK (migration 015)
  so a mart built before the migration stays valid until the next rebuild; the rebuild no longer
  emits it.

Example (IAG1, job 520, week of 2026-08-31): job-cost months in the window May - July are June
($19,737.50) and July ($153,791.91); weekly rate = (19,737.50 / 30 x 7 + 153,791.91 / 31 x 7) / 2 =
$19,666; the week's 1 August day + 6 September days = $19,666.31; projected August month
$87,093.66 (x 31 / 7), September $84,284.19 (x 30 / 7).

### 9.2 The `vendor` block of `GET /executive/labor-pl`

```json
"vendor": {
  "month": "2026-08-01", "month_status": "in_progress", "as_of": "2026-09-04",
  "projected_month_sub": 132002.79, "projected_month_sub_all": 707903.53, "projected_basis": "trailing_3mo_projection",
  "sites": 17, "sites_projected": 16, "sites_by_basis": {"trailing_3mo_projection": 16, "agency_ap": 1},
  "ap_live": {"invoiced_to_date": 881305.99, "invoices": 60, "vendors": 13, "through": "2026-08-31", "all_invoiced": 1979468.34,
              "by_vendor_type": [{"vendor_type": "Subcontractor", "invoiced": 881305.99, "invoices": 60, "vendors": 13}]},
  "history": [{"month": "2026-02-01", "job_cost_sub": 28644.02, "job_cost_sub_all": 385615.63,
               "ap_subcontractor_invoiced": 943807.61, "ap_all_invoiced": 2147139.87}, ...],
  "scope_note": "projected_month_sub and history[].job_cost_sub are scoped to account Amazon; projected_month_sub_all, ... company-wide ..."
}
```
```

* `month` = the selected week's dominant month (`executive.dominant_month`: most of the 7 days; a
  straddle week is never a tie). `month_status` = `closed` when `common.month_status_rows` says so
  (invoiced and past `close_lag_days`), else `in_progress`. `as_of` = the date the live look was
  taken (today); `ap_live` counts invoices dated up to it.
* `projected_month_sub` = the sum over the selected week's rows in scope (account / sub_account /
  delivery, exactly the rows shown) of `month_shares[month].sub_month`: the closed month's job-cost
  line per site, the agency allocation for `agency_ap` sites, else the trailing projection
  (weekly rate x days_in_month / 7). `projected_basis` is `job_cost` for a closed month, else
  `trailing_3mo_projection`; `sites_projected` counts the sites on the projection and
  `sites_by_basis` gives the mix (extra fields beyond the contract, as is `ap_live.all_invoiced`,
  `by_vendor_type[].vendors` and `sites`).
* `ap_live` = AP invoices of `mart.v_ap_invoice_effective` (both sources after the 011 precedence)
  dated (`coalesce(invoice_date, posting_date)`) in the month up to `as_of`, of vendors matching
  the setting `subcontractor_vendor_types`: a string term matches case-insensitively as a substring
  of the invoice's `vendor_type`, then of the vendor name; an integer term matches
  `core.dim_vendor.vendor_type_id` exactly (`executive.match_subcontractor_vendor`). `through` =
  the latest matching invoice date; `by_vendor_type` groups by the invoice's own `vendor_type`
  when the feed carries one, else by the matching term (`"janitorial"`, `"type 6"`).
  `ap_live` is `null` when no AP invoice at all is loaded for the month; with invoices but no match
  it is all zeros with `through = null`.
* `history` = the last 6 closed (job-cost) months up to `month`, each with `job_cost_sub` (sum of
  `mart.job_month.subcontract_cost` on the job-cost basis over the jobs in scope), `job_cost_sub_all`
  (the same over every job) and the company-wide `ap_subcontractor_invoiced` / `ap_all_invoiced`
  for the month. `projected_month_sub_all` is the company-wide twin of `projected_month_sub` (the
  sum of `sub_month` over every site's row of the selected week). `scope_note` spells the split out
  for the page: compare AP against the `_all` figures.
* `by_vendor_type[].vendor_type` = the invoice's `vendor_type` when the feed carries one, else the
  label of its `vendor_type_id` from the setting `vendor_type_labels` (migration 016, seeded
  `{"6": "Subcontractor"}`; the WinTeam vendors endpoint returns ids only), else `"type N"` for an
  id match or the matching term for a name match.
* **AP figures are company-wide, not per account**: WinTeam AP invoices are not linked to jobs
  (the only job link is the configured agency rule), so `ap_live` and the history's AP columns are
  the same whichever account is selected; the notes say so.
* Two notes are appended: the projected month with its basis mix, and the AP scope with the terms
  used and the live totals.

### 9.3 Verification (2026-09-04, after `POST /marts/rebuild`: 16,191 rows; live setting `subcontractor_vendor_types` = `[6, "subcontract", "sub contract", "staffing", "agency"]`, `vendor_type_labels` = `{"6": "Subcontractor"}`)

`mart.job_week.sub_basis` over the whole mart: `job_cost` 14,137, `trailing_3mo_projection` 1,672,
`none` 261, `agency_ap` 121 (no `carry_forward` left).

`GET /executive/labor-pl?account=Amazon` (17 sites per week):

| Week | Before (carry-forward) | After (projection) |
|---|---|---|
| 2026-08-24 | `carry_forward` 16 sites $55,745.86 + `agency_ap` 1 (APC2) $3,048.81 = $58,794.67 | `trailing_3mo_projection` 16 sites $26,758.27 + `agency_ap` 1 $3,048.81 = $29,807.08 |
| 2026-08-31 | `carry_forward` 17 sites $58,794.67 | `trailing_3mo_projection` 17 sites $31,154.57 (all `sub_estimated`) |

Per site, week of 2026-08-31: IAG1 $19,666.31, APC2 $4,396.30, USD1 $2,761.15, LGB3 $1,316.13,
MCC1 $979.06, UCA5 $776.73, PSP3 $661.66, USF4 $388.36, BDL3/7 $208.87; the eight Crane IFS / Sarus
sites without a subcontract line in May - July project $0.

`vendor` for the default week (2026-08-24 -> August 2026, `in_progress`, `as_of` 2026-09-04),
`account=Amazon`: `projected_month_sub` $132,002.79 (16 projected sites + APC2's August KM Group
allocation $13,501.85), `projected_month_sub_all` $707,903.53; `ap_live` $881,305.99 / 60 invoices /
13 vendors through 2026-08-31 of $1,979,468.34 AP invoiced in August, all under `Subcontractor`
(type 6). History (Feb - Jul): `job_cost_sub` $28,644.02 / $75,955.14 / $131,323.15 / $111,580.23 /
$147,322.29 / $709,679.57; `job_cost_sub_all` $385,615.63 / $558,744.70 / $611,946.40 / $601,852.19 /
$698,554.13 / $2,776,058.35; `ap_subcontractor_invoiced` $943,807.61 / $1,061,213.32 / $848,970.57 /
$993,582.88 / $1,218,787.53 / $3,767,175.62; `ap_all_invoiced` $2.15M / $2.50M / $2.38M / $1.94M /
$2.31M / $5.55M - AP subcontractor invoicing runs at roughly 1.4 - 2.4x the job-cost line
company-wide, and both jump in July. `account=All`: 275 sites (270 projected, 1 agency, 4 none),
`projected_month_sub` $707,062.87 vs `_all` $707,903.53 (the key accounts hold nearly all of the
projected vendor cost), `job_cost_sub` Jul $2,608,054.25 vs `_all` $2,776,058.35. A July week
(`week=2026-07-20`, closed): `projected_basis` `job_cost`, $709,679.57 (= Amazon's July
`mart.job_month` line), `_all` $2,776,058.35, `ap_live` $3,767,175.62 / 325 invoices / 64 vendors
through 2026-07-31. For `week=2026-08-31` (-> September): `projected_month_sub` $134,482.13 (17
projected), `ap_live` matched only what is dated in September so far.

`GET /executive/labor-pl?account=FedEx&delivery=subcontracted`: week 2026-08-24, 54 sites all on
`trailing_3mo_projection`, `sub_dollars` $125,147.05 (was $125,695.85 carried forward),
`projected_month_sub` $554,222.59 for August; history `job_cost_sub` Feb $356,401.61, Mar
$439,538.92, Apr $447,459.79, May $445,168.32, Jun $540,249.70, Jul $1,793,101.38. Week
2026-08-31: 55 sites, $125,300.80, September projected $537,003.38.

### Known gaps

* **Vendor type comes from an id, not a label.** Neither AP source carries a `vendor_type` text
  (every effective row has it null) and `core.dim_vendor` holds only `vendor_type_id`; the seeded
  name terms alone matched only janitorial-*supply* vendors (Ridley's Vacuum & Janitorial Supply,
  C & C Janitorial Supplies, ...: $179,644 in August). The real subcontractors carry
  `vendor_type_id = 6` (KM Group, Inc., ProClean Facility Services, Industrial Cleaning Pros,
  Integrity Concepts, Growing Up Care Solutions, ...), so the live setting now leads with the
  integer `6` (and drops `janitorial` / `labor`) and `vendor_type_labels` names it
  "Subcontractor". Another tenant's ids need their own entries in both settings.
* `as_of` is the request date, so the current month's `ap_live` grows daily; the history months are
  complete.
