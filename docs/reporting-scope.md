# Reporting scope: key accounts first

The analysis views default to the **key accounts** and reach the long tail by drill-down. This
document is the backend half of the contract section "Reporting scope: key accounts first" in
`docs/api-contract.md`.

Everything lives in one place: `services/api/app/common.py` (`MartFilters`, `resolve_filters`,
`scope_block`, `range_block`, `envelope`, `job_scope_subquery`). The routers only call it. The
executive weekly view (`routers/executive.py`) uses the same helpers (`scope_clause`, `DELIVERY_SQL`,
`key_accounts_setting`), so the two views cannot drift apart.

## The scope model

Every reporting endpoint accepts, on top of the existing `region` / `branch` / `service_type` /
`vertical` / `company` / `job_number` filters:

| Parameter | Values | Default | Meaning |
|---|---|---|---|
| `scope` | `key` \| `all` \| `other` | **`key`** | `key` = the accounts in setting `key_accounts` combined; `other` = every account that is not one of them; `all` = the whole portfolio |
| `account` | a `parent_account` name | - | one account, key or other (the drill-down) |
| `sub_account` | a sub-account label | - | the second level under an account (school district, FedEx Express / Ground). **Requires `account`; 422 otherwise** |
| `delivery` | `all` \| `self_perform` \| `subcontracted` | `all` | the delivery model of the site |

An unknown `scope` or `delivery` is a `422`.

### SQL emitted (`MartFilters.clause(alias)`)

In this fixed order: the exact-match dimension filters, then the scope, then `sub_account`, then
`delivery`. Everything is parameterized.

```
scope=key    ->  AND {alias}.parent_account = ANY(%s::text[])            -- the key-account names
scope=other  ->  AND (coalesce({alias}.parent_account, '') <> ALL(%s::text[]))
scope=all    ->  (nothing)
account=X    ->  AND {alias}.parent_account = %s                          -- scope contributes nothing
sub_account  ->  AND {alias}.sub_account = %s
delivery=D   ->  AND coalesce({alias}.delivery_model,
                      CASE WHEN {alias}.hours > 0 THEN 'self_perform' ELSE 'subcontracted' END) = %s
```

`coalesce(parent_account, '')` in the `other` test is deliberate: `NULL <> ALL (...)` evaluates to
NULL, which `WHERE` treats as false, so an unassigned job would silently disappear from "everything
else". The delivery rule is the executive view's rule verbatim; `mart.job_month` carries both
`delivery_model` and `hours`, so it is valid there exactly as it is on `mart.job_week`.

### Precedence: `account` > `scope`

An explicit account **is** the scope. With `account` set the key/other membership test contributes
no SQL, the response echoes `range.scope.mode = "account"`, and `filters` does not repeat `scope`.
`account=All` is not an account: it means "no account", so the requested scope applies.

### Disclosure on every response

`range` gains a scope block (`MonthRange.as_dict()` itself is unchanged; `common.range_block` /
`common.envelope` add it where responses are assembled):

```json
"range": { "from": "...", "to": "...", "months": 8, "period": "YTD", "anchor": "...",
           "scope": { "mode": "key", "label": "Key accounts",
                      "accounts": ["FedEx", "Amazon", "Education", "Whole Foods", "Aldi"],
                      "sites": 526 } }
```

* `mode` - `key` | `all` | `other` | `account`.
* `label` - what to print: the account name, or "Key accounts" / "Other accounts" / "All accounts",
  suffixed with ` / <sub_account>` and ` / <delivery> sites` when those narrow it.
* `accounts` - the accounts that define the scope when they are enumerable: the key accounts for
  `key`, the one account for `account`. Empty for `all` and for `other`, whose membership is
  "everything else" and is stated by the label.
* `sites` - distinct `mart.job_month.job_number` under the whole filter set, across **every** month
  (a cheap headline count, not the selected period's reporting sites).

`/ar/aging` and `/ar/invoices` have no month range (the aging is a snapshot), so their scope block
sits at the top level as `scope` instead of inside `range`.

## What each endpoint scopes

| Endpoint | Scoped how |
|---|---|
| `/portfolio/summary` | every `mart.job_month` CTE (KPIs, prior range, jobs-below-target, monthly trend, `by_region` / `by_service_type` / `by_account` / `by_company`), plus `ar_open` / `dso_days` through the scope's job numbers |
| `/jobs`, `/accounts`, `/alerts` | the `agg` CTE of `JOB_ROWS_SQL`; the employee / AR / invoice CTEs join back to it, so they follow |
| `/jobs/{job_number}` | **not** scoped: a job page is its own scope (`scope=all` internally), so the key/other test can never hide the job being looked at. `range.scope.mode` is `all` with `sites: 1` |
| `/labor/summary` | every `mart.job_month` query; `overtime_employees` (punch-grained) through the scope's job numbers |
| `/labor/pace` | its own `account` / `job_number` arguments only - the pace model's portfolio row stays company-wide. `scope` echoes what those selected |
| `/timekeeping/summary` | the `jobs` CTE that the punch and schedule joins hang off, plus `by_job` / `by_branch` / the KPI totals |
| `/budget/variance` | all four `mart.job_month` queries (totals, monthly, by_account, by_job) |
| `/ar/aging`, `/ar/invoices` | AR facts are invoice-grained, so the scope restricts them to the job numbers `mart.job_month` selects |
| `/ap/summary` | **echoed only** - see below |
| `/forecasts` | the forecast rows are filtered to the scope's sites and led by a `__SCOPE__` aggregate |
| `/dimensions` | not a report: it publishes the scope vocabulary (`key_accounts`, `other_accounts`, `delivery_models`, `scopes`) |

### Coverage: what a key-account view leaves out

`/portfolio/summary.kpis` carries

* `revenue_share_of_all` - the scope's revenue / **every** account's revenue for the same month
  range (no scope, no other filter on the denominator); `null` when that denominator is 0.
* `revenue_all_accounts` - that denominator, so the page can show both numbers.

### What stays company-wide (and says so)

* **AP vendor figures.** WinTeam AP invoices carry no job and no account, so nothing on
  `/ap/summary` can be attributed to a key account. The request's scope is echoed in `range.scope`
  and `scope_note` states in one sentence that every figure on the page is company-wide. The same
  is true of `kpis.ap_invoiced` / `ap_paid` and the `ap_invoiced` / `ap_paid` columns of
  `/portfolio/summary.monthly`, which come from `mart.portfolio_month`; that page's `scope_note`
  says so.
* **AR invoices with no service location.** When the scope narrows the portfolio, AR facts are
  restricted to the scope's job numbers, which drops invoices that carry no job. With
  `scope=all` and no other filter nothing narrows, no restriction is emitted, and those invoices
  stay in the total - so `scope=all` remains the company-wide AR number it always was.
  `/ar/aging.scope_note` states this.
* **`/forecasts/history`** without `account`: the engine's gates are portfolio-level, so the fitted
  history stays the portfolio series. A key-account history would not line up with the bands the
  site forecasts were built from.

## Forecasts

`/forecasts?metric=&scope=&account=` (`routers/forecast.py`):

* `scope=all` with no account - unchanged: the `__ALL__` portfolio row leads the site rows.
* `account=X` - unchanged: `__ALL__` is omitted and an `__ACCOUNT__` row leads.
* `scope=key|other` with no account - the rows are the scope's site rows led by a **`__SCOPE__`**
  row: the same shape and the same arithmetic as `__ACCOUNT__` (`forecasting.aggregate_account`,
  method `sum_of_site_forecasts`), with `job_name` = the scope label. `account_summary` is filled
  for it and gains `scope` (the mode) and `aggregate_row` (`__SCOPE__` / `__ACCOUNT__`).

The lead row is always sorted first in horizon order; site rows follow by point desc, as before.

## Settings involved

| Setting | Used for |
|---|---|
| `key_accounts` | the key-account list, `[{name, label}]` in display order (migration 013). Normalized by `common.key_accounts_setting`; falls back to `common.DEFAULT_KEY_ACCOUNTS` (FedEx, Amazon, Education, Whole Foods, Aldi) when unset or malformed. Editable through `PUT /settings/key_accounts` |
| `sub_account_rules` | the second-level labels (migration 014). Applied by `app.weekly.apply_sub_accounts` at the end of every mart rebuild to **both** `mart.job_week` and `mart.job_month` (migration 018 added the column to the monthly mart) from one Python pass, so the two marts always carry identical labels |
| `close_lag_days` | which month is "closed" - `/dimensions.other_accounts` is ordered by the latest closed month's revenue |

Changing `key_accounts` takes effect on the next request (it is read per request). Changing
`sub_account_rules` needs a mart rebuild (`POST /marts/rebuild`), because the labels are stored.

## `/dimensions`

```json
"key_accounts":   [{"name": "FedEx", "label": "FedEx (incl. FXE, FXG)", "sites": 332,
                    "sub_accounts": [{"name": "FedEx Express (FXE)", "sites": 236}]}],
"other_accounts": [{"name": "CoreSite Real Estate, LLC", "sites": 3, "latest_month_revenue": 0.0}],
"delivery_models": ["self_perform", "subcontracted"],
"scopes": ["key", "all", "other"]
```

`key_accounts` is in the configured order with sub-accounts by site count desc; `other_accounts` is
ordered by the latest **closed** month's revenue desc, then by name. `accounts` (every name),
`months`, `month_status`, `default_month` and the rest are unchanged.
