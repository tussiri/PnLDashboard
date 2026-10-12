# Metrics

Every figure on the Company page's "At a glance" story, with its formula and its denominator. The same
definitions show on hover and focus over each figure's label, from `src/leadership/glossary.ts`; a figure
without an entry there does not compile, and `src/leadership/storyCharts.test.ts` checks each term is here.
Weekly account metrics (invoicing, labor %, hours to cut, status) are defined in `src/leadership/metrics.ts`
and `docs/api-contract.md`.

## Rules for every figure

- **Anchored to the data, not today.** The window ends with the last month of `GET /leadership/company` (the last
  month that has job cost revenue) and covers that month's calendar year to date by default, or the last 12
  months with the period toggle. The revenue trend always compares the latest 3 closed months with the 3
  before, from the last 12 months. The week is the selected week, by default the latest
  complete one (its Sunday past both today and the last rebuild).
- **Censored, not zero.** A month that is not job-cost closed is shown in the chart but left out of every
  figure. A value that is not yet knowable (too few closed months, no billing, no budget) shows a dash.
- **Flagged months stay in.** A closed month whose subcontractor or direct labor share is well above the other
  months (`flag_spikes`, e.g. July 2026 subcontract cost) is counted, and named in the card's note.

## Revenue

### Revenue

Revenue of every account over the closed months of the selected period, ending with the last month the job cost covers: the calendar year to date (the default) or the last 12 months. Job cost revenue, or Relay AR for a subcontracted FedEx site. Over the year to date it is the Company Revenue YTD.

```text
sum(revenue) over closed months in the window
```

Job-cost-closed months only: a month is closed when it has revenue and its job cost direct labor is at least 70% of timekeeping labor (or there is no timekeeping), and cost on jobs with no revenue that month is under 20% of revenue. Open months are shown but not counted.

### Last 3 months

Revenue of the latest 3 closed months against the 3 closed months before them.

```text
sum(revenue, latest 3 closed) / sum(revenue, 3 closed before) - 1
```

A dash until there are 6 closed months in the window.

### Gross margin

Gross profit as a share of revenue, over the same closed months.

```text
sum(gross_profit) / sum(revenue)
```

Job-cost-closed months only: a month is closed when it has revenue and its job cost direct labor is at least 70% of timekeeping labor (or there is no timekeeping), and cost on jobs with no revenue that month is under 20% of revenue. Open months are shown but not counted.

### Labor %

Job cost direct labor as a share of revenue, over the same closed months.

```text
sum(direct_labor) / sum(revenue)
```

Job-cost-closed months only: a month is closed when it has revenue and its job cost direct labor is at least 70% of timekeeping labor (or there is no timekeeping), and cost on jobs with no revenue that month is under 20% of revenue. Open months are shown but not counted.

## Every $100 billed

### Of every $100 billed

Where each $100 of closed-month revenue went, rounded to whole dollars that sum to 100 (largest remainder).

```text
part / sum(revenue); other job cost = revenue - gross_profit - direct_labor - subcontractors - payroll_taxes
```

Not drawn when gross profit is negative or the costs do not reconcile to gross profit.

## Accounts

### Largest account

The featured account with the most closed-month revenue, as a share of revenue of every account.

```text
account revenue / sum(revenue)
```

Accounts that are not featured count together as Other accounts. Job-cost-closed months only: a month is closed when it has revenue and its job cost direct labor is at least 70% of timekeeping labor (or there is no timekeeping), and cost on jobs with no revenue that month is under 20% of revenue. Open months are shown but not counted.

### Losing money lately

Featured accounts with a gross loss over the latest 3 closed months, of the featured accounts with revenue. Each bar also shows the account's margin over those 3 months beside its 12-month margin.

```text
count(accounts where sum(gross_profit, latest 3 closed months) < 0)
```

The year-to-date tables under Supporting detail cover the calendar year, a different period. Job-cost-closed months only: a month is closed when it has revenue and its job cost direct labor is at least 70% of timekeeping labor (or there is no timekeeping), and cost on jobs with no revenue that month is under 20% of revenue. Open months are shown but not counted.

## This week

### Over target

Featured accounts whose labor % in the week is above their target plus the watch band, of the accounts with billing that week.

```text
count(labor % > target + watch band) / count(accounts with invoicing)
```

The latest complete week unless another week is selected; a week is complete once its Sunday is past the last data rebuild. Labor is the Pay Report, else WinTeam hours at payroll rates, else a trailing-rate estimate; overtime dollars are estimated.

### Hours over target

Hours that would bring each featured account to its labor target in the week: sites over target plus catch-all jobs in full.

```text
sum(header hours over target) over accounts with invoicing
```

## Against plan

### Labor against budget

Labor of the accounts with a labor budget, against the sum of their budgets, over finished months in the window.

```text
sum(actual labor) / sum(budget labor) - 1, per month counting only accounts with both
```

Actual is job cost when the month is closed, else the month rollup from timekeeping.

### Accounts with a budget

Accounts with a labor budget and an actual for at least one finished month in the window.

## After allocations (when no account has a budget for two finished months)

### After allocations

Gross profit less management wages, burden and overhead, over the closed months in the window.

```text
sum(gross_profit - management_wages - burden - overhead)
```

Only the allocations turned on in Admin, Allocations. Job-cost-closed months only: a month is closed when it has revenue and its job cost direct labor is at least 70% of timekeeping labor (or there is no timekeeping), and cost on jobs with no revenue that month is under 20% of revenue. Open months are shown but not counted.

### Share of revenue

Gross profit after allocations as a share of revenue, over the same closed months.

```text
sum(after allocations) / sum(revenue)
```
