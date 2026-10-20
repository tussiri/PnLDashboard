# Company P&L on Finance's basis

Migration 056, `services/api/app/company_pl.py`, Company page section "Company P&L", Admin tabs
Overhead rule, Adjustments and Contracts. Built to reproduce Finance's Company P&L workbook
(`Company_PL_ex_Education_FedEx_Subs.xlsx`, built from the WinTeam Cross Tab Income Statement by job and
tied to the GL Trend).

## Source

The **Cross Tab Income Statement by job**, one file per month (per company database when the report is
run per company). Upload it on Admin > Imports as "Cross Tab Income Statement by job", or name it
`job_income_statement_YYYY-MM.xlsx` / anything containing "Cross Tab", or mail it to the reports mailbox.

* Layout: wide (a line label column, then one column per job, "101 - Amazon DFW7") or long (Job Number,
  Description, Amount, optional Period and Company). Title rows above the header are read for the
  period ("For the Period 9/1/2026 to 9/30/2026") and the company name.
* Subtotal rows (Total ..., Gross Profit, Net Income) are skipped.
* When revenue reads negative (GL credits), every amount is flipped.
* A file replaces its month (and company).

## Line categories

| Category | Line names (when no GL range matches) |
|---|---|
| revenue | revenue, sales, billing, income |
| direct_labor | wages, salaries, labor, overtime, bonus, vacation, holiday pay, sick pay, PTO, payroll |
| payroll_taxes_insurance | payroll tax, FICA, FUTA, SUTA, SUI, Medicare, unemployment, workers comp, health insurance, benefits, 401k |
| subcontractors | subcontract |
| supplies | supplies, materials, chemicals, equipment, consumables |
| operating_expense | everything else (rent, vehicle, travel, phone, interest, depreciation) |

GL account ranges on Admin > Overhead rule win over names. Set them once from the chart of accounts.

## Calculation (per month)

1. Adjustments apply: accruals add a line to a job (dropped once cleared; a negative line in the reversal
   month), reclasses move an amount between jobs.
2. Gross profit = revenue − direct labor − payroll taxes and insurance − subcontractors − supplies − other direct.
3. Net before overhead = gross profit − operating expenses on the job.
4. Corporate overhead = costs on the overhead jobs (6325, 63252, 63253) − revenue posted to them.
5. Each group is charged its fixed monthly charge (New FedEx subs $30,000) and its direct account staff
   (staff adjustments). The remaining pool is spread over the groups that share it, by revenue.
6. Group net after overhead = net before overhead − fixed − staff − pool share. Groups add up to the
   company net profit = net before overhead − corporate overhead.
7. An account carries its jobs' share of their group's overhead by revenue.

## Groups (defaults)

| Group | Jobs | Fixed / month | Shares pool |
|---|---|---|---|
| New FedEx subs | FedEx account, subcontracted sites | $30,000 | No |
| Education | Plano, Crowley, White Settlement, Henderson ISD | 0 | Yes |
| Amazon + other customers | every other job | 0 | Yes |

## Adjustments (Admin > Adjustments)

| Finance item | Entry |
|---|---|
| FedEx sub invoices not received ($208K, Sep 2026) | Accrual, Subcontractors, job, Sep, reverses Oct (or Clear when the invoices post to September) |
| Amazon account management fee posted to 6325 | Reclass, Revenue, from 6325 to the Amazon job |
| Growing Up Care invoices on Amazon project 502 | Reclass, Revenue, from 502 to Whole Foods 701 |
| Direct account staff (Education, FedEx subs, Amazon, Projects) | Direct staff, group, monthly amount |

## Weekly invoice basis (Admin > Accounts)

| Basis | Weekly invoice | Accounts |
|---|---|---|
| last_month | revenue month ÷ 4.33 | Plano ISD, White Settlement, Henderson |
| run_rate_3m | 3-month average revenue ÷ 4.33 | |
| latest_fixed_avg_variable | (revenue month fixed + 3-month average variable) ÷ 4.33 | FedEx |
| contract | contract in effect on the week's last day ÷ 4.33, else revenue month | Crowley ISD |

Contracts are entered on Admin > Contracts or imported (Company, Job Number, Effective From, Monthly
Amount) with any effective date, so a launch or a mid-month change applies from that week.
