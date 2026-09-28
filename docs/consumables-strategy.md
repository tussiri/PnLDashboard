# Consumables: capture strategy

Status: design only. Consumables do not appear on the dashboard until one of the options below
codes them to a site. `mart.job_week` carries nullable `consumables_cost` and `consumables_basis`
(`actual` | `estimate`), so any option slots in without a schema change. Once a basis is chosen,
the P&L reads labor % and cost %, where cost % = (labor + sub + consumables) ÷ invoice.

## What exists today

- Job Cost Analysis carries a `Supplies` line per job and month. It holds what AP has already coded to
  the job, which is incomplete: most supply purchases post to branch or overhead jobs.
- AP invoice GL distributions (`payables/invoices/{n}`) carry a job number and GL account per line.
  Supply GL accounts that are coded to a site job reach `core.fact_ap_distribution` today.
- No supplier feed, purchasing-card feed or inventory issue data reaches the warehouse.

## Options

| | A. Code supply AP to job in WinTeam | B. Supplier invoice feed by ship-to | C. Purchasing card coded to job | D. Estimated allocation |
|---|---|---|---|---|
| Data source | WinTeam AP distributions (API, already synced) and Job Cost `Supplies` | Supplier EDI or CSV (line items, ship-to address) | Card provider export (merchant, amount, job code field) | Revenue × account-level % |
| Effort to build | Low: GL account list in settings; the data already flows | Medium to high: per-supplier parser, address-to-job match table, exceptions queue | Medium: one parser plus a job-code validation rule | Low: one setting per account |
| Accuracy | High for coded lines; misses what stays on overhead jobs | High when ship-to is the site; weak for warehouse or branch deliveries | Medium: depends on cardholder coding discipline | Low: an estimate by definition |
| Timeliness | At AP posting (days to weeks) | At invoice (days) | At statement or daily feed | Immediate |
| Who changes process | AP clerks code each supply line to the site job (split invoices by site) | Purchasing sets one ship-to per site; suppliers must send the feed | Cardholders enter a job number on every transaction | Finance sets and reviews the % quarterly |
| Consumables basis | `actual` | `actual` | `actual` | `estimate` (labeled everywhere) |

Inventory issue tickets (WinTeam inventory module) would be the most precise source, charging the
job when stock leaves the branch. They are not considered here because the inventory module is not
in use and its API is not in the subscription.

## Recommendation

1. **Now:** option D as an interim, labeled estimate. Set a % of revenue per featured account from
   the last 12 closed months of Job Cost `Supplies` ÷ revenue for jobs where supplies are coded. It is
   shown only as a separate "Consumables (est.)" column, never merged into labor %.
2. **Next 1–2 months:** option A. It needs no new system. The AP process change is splitting supply
   invoices by site job. Start with the featured accounts. The dashboard reports coverage (share of
   supply AP dollars coded to a site job) so progress is visible.
3. **Where a supplier dominates:** add option B for that one supplier if its invoices already
   carry the site ship-to (common for national janitorial distributors). Build per supplier only
   when coverage from A stalls.
4. **Option C** only if purchasing cards carry a material share of supply spend. Check card spend
   before investing.

Per site, the estimate is replaced by actuals once option A coverage for that site reaches an agreed
threshold (proposal: 80% of trailing-3-month supply AP coded).
