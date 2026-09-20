import { ArrowUpRight } from 'lucide-react'
import { useDashboard } from '../context/DashboardContext'
import type { PageKey } from '../types'
import { DemoNotice } from './shared'

const reports: { name: string; owner: string; cadence: string; description: string; page: PageKey; exportNote: string }[] = [
  { name: 'Financial summary', owner: 'Finance', cadence: 'Monthly', description: 'P&L lines, direct-cost mix, top sites and monthly detail.', page: 'financial', exportNote: 'CSV: P&L lines, monthly detail' },
  { name: 'Site profitability', owner: 'Operations', cadence: 'Weekly', description: 'Margin, labor variance and hours variance by site.', page: 'jobs', exportNote: 'CSV: sites grid' },
  { name: 'Labor cost control', owner: 'Operations', cadence: 'Daily', description: 'Month-end labor pace, labor % of revenue vs target, overtime, sites over budget.', page: 'labor', exportNote: 'CSV: account summary, pace by account, OT employees' },
  { name: 'Timekeeping audit', owner: 'Payroll', cadence: 'Daily', description: 'Scheduled vs worked hours by site and branch; overtime watchlist.', page: 'timekeeping', exportNote: 'CSV: scheduled vs actual by site' },
  { name: 'AR aging', owner: 'Finance', cadence: 'Weekly', description: 'Aging buckets, customer balances, open invoices, DSO.', page: 'billing', exportNote: 'CSV: open invoices (all pages)' },
  { name: 'Budget variance', owner: 'FP&A', cadence: 'Monthly', description: 'Actual vs budget by line, account and site.', page: 'budget', exportNote: 'CSV: by account, by site' },
  { name: 'Vendor spend', owner: 'Finance', cadence: 'Monthly', description: 'AP invoiced vs paid by vendor and month; due in the next 30 days.', page: 'expenses', exportNote: 'CSV: AP by vendor' },
  { name: 'Forecast package', owner: 'FP&A', cadence: 'Monthly', description: 'Validated forecast run: site forecasts with bands, track record, assumptions.', page: 'forecast', exportNote: 'CSV: site forecasts, track record' },
  { name: 'Exceptions', owner: 'Operations', cadence: 'Daily', description: 'Threshold alerts by severity with a link to each site.', page: 'alerts', exportNote: 'Opens the site' },
]

export function Reports() {
  const { navigate } = useDashboard()
  return <>
    <DemoNotice>Reports render the demo dataset.</DemoNotice>
    <div className="report-grid">{reports.map((r) => <button type="button" key={r.name} className="report-card" onClick={() => navigate(r.page)}><span>{r.owner}</span><h3>{r.name}<ArrowUpRight size={14} aria-hidden="true" /></h3><p>{r.description}</p><div><small>Refresh cadence</small><strong>{r.cadence}</strong></div><em>{r.exportNote}</em></button>)}</div>
  </>
}
