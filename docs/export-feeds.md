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

### 1a. Timekeeping labor summary (accepted in place of the Pay Report)

WinTeam's labor summary by employee (ExportStartDate, ExportEndDate, Hours1..Hours16, LaborDollars,
OvtHrs, DTHrs, OvtDollars, DTDollars) is loaded as pay report labor, recognized by its columns.

- **Run it for one Monday-Sunday week** (ExportStartDate = Monday, ExportEndDate = Sunday), each
  Monday for the week just ended; daily for the current week if the dashboard should show it live.
  LaborDollars is a total for the window, so a longer window cannot be split into weeks: a row whose
  Hours1..Hours16 do not add up to TotalHours is refused unless the window sits inside one week.
- Hours1 is ExportStartDate. A row whose daily hours reconcile is spread over those days (dollars and
  OT in proportion to hours, to the cent, totals exact).
- The file covers its window only through the day before ExportRunDate, so days not yet worked keep
  their estimate. Within that window it replaces the company's pay report labor.
- Companies are labeled by CompanyName through the `company_aliases` setting first (Sarus and the
  Crane companies are separate WinTeam databases whose company numbers overlap), then by number.
- Used: ExportRunDate, ExportStartDate, ExportEndDate, CompanyNumber, CompanyName, JobNum or
  JobNumber, EmployeeNumber, TotalHours, HoursTypeDescription, Hours1..Hours16, LaborDollars, OvtHrs,
  DTHrs, OvtDollars, DTDollars. EmployeeName can be left out.

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

### 2a. Job Cost Analysis by GL line (WinTeam's own layout, preferred)

The export WinTeam produces (one row per job, fiscal period and GL account: GLAccountNumber,
ActualDollars, ActualHours, ActualOvertimeHours, PeriodStartDate or FiscalYear / FiscalPeriod) is
recognized by its columns and pivoted into the job-month columns above by GL account range:

| GL accounts | Column |
|---|---|
| 30000-39999 | Revenue (34000 OS Revenue is also the variable revenue, read for pallet-site accounts only) |
| 40000-40999 | Direct labor (hours from these lines) |
| 41000-42999 | Payroll taxes and insurance |
| 44000-44999 | Subcontractors |
| 45000-45999 | Materials |
| 46000-47999 | Equipment and supplies |
| 43000-43999, 48000-49999 | Other direct costs |

Other accounts are reported in the import's errors and not loaded. The ranges are the setting
`job_cost_gl_map` in ops.app_setting (same shape as `JOB_COST_GL_MAP` in app/native_exports.py).
A file replaces the imported months it covers for its companies.

- **Do not filter GL accounts.** The 2026-08-02 export carried revenue only on 31800, 31803, 31807
  and 34000: FedEx's fixed billing and Amazon's billing are booked to accounts it left out.
- **Run after month-end close**, for the closed month and the two before it. The 2026-08-02 run
  for July was early: FedEx Bloomington had $8,952 of July labor against about $19,675 once closed.
- Include payroll taxes, supplies and other direct lines for the loaded labor % and the income
  statement bridge.

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

For the company view and the allocations, send the company-wide statement with Account = `Company`
(also accepted: All, Total, Crane IFS, Consolidated). Payroll burden reads payroll taxes and workers comp
against wages; overhead reads the G&A (admin) lines.

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

### WinTeam scheduled queries, as emailed

The reports mailbox (docs/mail-inbox.md) and the Admin upload recognize these by their columns, so
the WinTeam Query Scheduler can email them as they are; the file name does not matter.

| Scheduled query (file as sent) | Loads as | Notes |
|---|---|---|
| `<Company>_timekeeping_recent_<date>.csv` | Pay Report Timekeeping | One row per punch with WorkDate and TotalLaborDollars. Covers its companies from the first to the last work date in the file; start the window on a Monday so the first week is whole. Straight-time pay arrives as `Dollars`; regular dollars are total less OT and DT. One file per WinTeam database (Crane, Sarus): the company is taken from CompanyName through `company_aliases` first, because the company numbers of the two databases overlap. |
| `SYS Query Scheduler - <stamp>.xlsx` (Job Cost Analysis by GL line) | Job Cost Analysis | Replaces its companies' job cost for the fiscal periods in the file. It carries the GL lines the query selects; one limited to revenue, labor and subcontractor lines loads no payroll taxes, materials or supplies for the month. |
| FedEx feedback and star ratings (ServiceChannel export) | Feedback | Feedback, WO Number, Location Number, Provider Name, Trade, Feed Back Date, Star Ratings Comment, Star Ratings Score. Upserted by work order; Location Number ties to the site through Relay. Shown on the account's Feedback tab and the site drawer. |
| `<Company>_hours_budget_comparison_<date>.csv` (timekeeping labor summary) | Pay Report labor | Only when run for one Monday-Sunday week. A longer window whose rows cannot be split into weeks is refused as a whole and nothing is loaded. Not needed when the timekeeping query is sent. |
