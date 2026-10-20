# Company P&L

The company P&L the way finance builds it, on the Company page and under Admin > Company P&L.

## Source

Each month reads the Cross Tab Income Statement by job (export feed 3a) when it is loaded. Months
without it fall back to the Job Cost Analysis, with payroll taxes estimated from the allocations burden
rate; those months are marked with `*`. GL ranges: revenue 30000s, labor 40000–40999, payroll taxes
41000–42999, subcontractors 44000s, supplies 45000–47999, other direct 43000s and 48000–49999,
operating expenses 50000 and up (below gross profit).

## Overhead rule (Admin > Company P&L)

1. Corporate overhead is the net cost of the overhead jobs (cost less any revenue on them).
2. Each group is charged its fixed charge and its account staff first (New FedEx subs: $30,000 fixed
   plus $15,000 account staff by default). A month can override either amount.
3. The rest (the pool) is split by revenue among the groups that share the pool (Education and
   Amazon + other customers by default).
4. A group's charge is spread over its customers by revenue.

Groups match jobs by account and, optionally, delivery model; the default group takes every other job.
Net profit = before overhead − overhead, so moving charges between groups never changes the company total.

## Accruals and reclasses

- An accrual adds an amount to a job's line for the month, such as sub invoices billed but not yet
  posted. It records the line's actual at the time; once the actual has grown by 90% of the accrual,
  the accrual counts as posted and stops applying. "Find missing sub invoices" suggests one for each
  subcontracted Relay site billed in the month whose sub cost is under 90% of the prior month.
- A reclass moves an amount on one line from one job to another (for example, into an overhead job).
- Either can be reversed by hand; nothing is deleted.

## Invoice basis per account

Weekly invoice = monthly amount ÷ divisor, where the monthly amount is the latest loaded month
(`last_month`), the three-month run rate (`run_rate_3m`), or the contract schedule for the week's
month (`contract`, export feed 3b). Finance's reports use last month for Plano, the run rate for FedEx
and the contract schedule for Crowley; migration 057 switches Crowley ISD to the contract basis.
