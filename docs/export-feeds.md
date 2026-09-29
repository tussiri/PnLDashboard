# WinTeam export feeds for the leadership P&L

The WinTeam API has no pay amounts and no job-cost P&L, so the dashboard also imports scheduled
WinTeam report exports. The API and these files fill the same tables. For labor dollars, a pay
report row always wins over an API estimate.

Format for every feed: CSV (UTF-8, comma-delimited, one header row) or XLSX (first sheet). Column
names below are the WinTeam names already recognized by the loader. Order does not matter, and
extra columns are ignored. Scope is all companies (Crane IFS, Crane West, Crane Southwest), one
file per company or combined.

## 1. Pay Report Timekeeping (required, nightly)

The WinTeam Timekeeping detail with pay dollars. It is the source of labor $, OT $ and OT hours
on the dashboard.

- Grain: one row per employee, job, work date and hours type.
- Window: work dates from the Monday 3 weeks before the run date through the run date. The overlap
  lets rows restate after payroll processes. Re-sent rows replace earlier ones.
- Schedule: nightly, after timekeeping and payroll processing.

| Column | Required | Notes |
|---|---|---|
| CompanyNumber, CompanyName | yes | |
| EmployeeNumber | yes | |
| JobNumber | yes | |
| WorkDate | yes | |
| HoursTypeID, HoursTypeDescription | yes | Regular / Overtime / Double time etc. |
| RegularHours, OvertimeHours, DoubletimeHours | yes | |
| TotalHours | yes | |
| PayRate, OTRate, DTRate | yes | |
| RegularLaborDollars, OvertimeLaborDollars, DoubletimeLaborDollars | yes | Full pay (OT at 1.5x), not the premium only |
| TotalLaborDollars | yes | The reference dashboard's labor $ |
| PaidByCheckID | yes | Blank until paid; marks payroll-final rows |
| TKHoursID | yes | Row identity for replacing restated rows |
| JobDescription | optional | |
| SupervisorDescription | optional | Fills supervisor names the API cannot provide |
| Tier1..Tier6 Description | optional | |

Personal columns (employee name, SSN, address) are not needed. Leave them out.

## 2. Job Cost Analysis (required, monthly)

Revenue, direct labor, subcontract and other direct costs by job and month. It is the source of
the weekly invoice (prior closed month revenue ÷ 4.33) and of prior-month labor % including
subcontractor cost.

- Grain: one row per job and fiscal period.
- Window: the current and prior two periods, so late postings restate.
- Schedule: nightly during close, weekly otherwise.

| Column | Required |
|---|---|
| CompanyNumber, JobNumber, JobDescription | yes |
| Period (YYYY-MM or fiscal period id) | yes |
| Revenue | yes |
| DirectLabor, PayrollTaxesInsurance | yes |
| Subcontract | yes |
| Supplies, OtherDirect | yes (consumables later) |
| GrossProfit | optional (checked against the computed value) |
| FixedRevenue, VariableRevenue | optional; the contract billing and the variable (OS, pallet) billing that make up Revenue. Needed for the Pallet view (FedEx: the "Indstrl" and "OS" revenue lines). Aliases: ContractRevenue, OSRevenue, ExtraWork. |

## 3. Trend Income Statement (monthly, per account)

The account's income statement by month, for the Income Statement view and its bridge to the
dashboard sites (FedEx). Name the file `income_statement_*`; a file replaces the months it covers.

- Grain: one row per account, fiscal period and line.
- Window: the last three closed periods.

| Column | Required |
|---|---|
| Account (slug such as `fedex`, or the account name) | yes |
| Period (YYYY-MM) | yes |
| Line (income statement line description) | yes |
| Amount | yes |

Lines the view reads, matched case- and punctuation-insensitively: Revenue (Total Revenue), the
GL-only subcontracted revenue line (Indstrl, Mnftng, Wrhs - Subcontracted), Wages (Direct Wages),
Management Wages, Payroll Taxes, Workers Comp, Subcontractors, Supplies, Vehicle, Travel, Insurance,
Gross Profit, Admin, Net Profit. Other lines are kept but not shown.

## 4. Daily labor budget (optional)

`GET jobs/{job}/budgets` already supplies budget hours by day of week. Send this feed only if
Finance prefers the report's budget over the job budget setup.

| Column | Required |
|---|---|
| CompanyNumber, JobNumber, BudgetDate | yes |
| BudgetedHours, BudgetedDollars | yes |

## Delivery

Files land in the import folder the nightly sync reads (default `imports/inbox/`, mounted into
the API container; `IMPORT_INBOX_DIR`), or are uploaded on the Admin page. Each file is recorded
in `ops.import_file` by content hash, so re-sending a file is harmless. Name files
`<feed>_<company>_<YYYYMMDD>.csv`, e.g. `pay_report_crane-southwest_20260921.csv`.
