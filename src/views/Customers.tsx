import { useMemo } from 'react'
import { QueryCard } from '../components/CardState'
import { GroupBars } from '../components/Charts'
import { DataGrid, type Column } from '../components/DataGrid'
import { KpiCard } from '../components/KpiCard'
import { useDashboard } from '../context/DashboardContext'
import type { AccountRow, AccountsResponse } from '../services/apiTypes'
import { isMeaningfulMargin, marginPercent, money, moneyFull, number, percent, sum } from '../utils'
import { DemoNotice, rangeSubtitle, ScopeLine, StatusBadge, useReportingParams, useReportQuery } from './shared'

export function Customers() {
  const { query, params } = useReportingParams()
  const { setFilters, navigate } = useDashboard()
  const accounts = useReportQuery<AccountsResponse>('accounts', (api, signal) => api.accounts(query, signal), params)
  const rows = useMemo(() => [...(accounts.data?.accounts ?? [])].sort((a, b) => b.revenue - a.revenue), [accounts.data])
  const revenue = sum(rows, (r) => r.revenue), ar = sum(rows, (r) => r.ar_open)
  const atRisk = rows.filter((r) => r.status !== 'Healthy').length
  const focus = (name: string) => { setFilters((f) => ({ ...f, account: name })); navigate('jobs') }
  const columns: Column<AccountRow>[] = [
    { key: 'parent_account', header: 'Account', render: (r) => <><strong>{r.parent_account}</strong><span className="muted"> {r.customer_numbers.filter(Boolean).join(', ')}</span></> },
    { key: 'jobs', header: 'Sites', numeric: true },
    { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => moneyFull(r.revenue) },
    { key: 'gross_margin_pct', header: 'Margin', numeric: true, className: (r) => (!isMeaningfulMargin(r.gross_margin_pct) ? 'text-muted' : (r.gross_margin_pct ?? 0) < 20 ? 'text-bad' : 'text-good'), render: (r) => marginPercent(r.gross_margin_pct) },
    { key: 'labor_pct', header: 'Labor %', numeric: true, value: (r) => (r.revenue ? (r.labor_cost / r.revenue) * 100 : null), render: (r) => percent(r.revenue ? (r.labor_cost / r.revenue) * 100 : null) },
    { key: 'ot_pct', header: 'OT %', numeric: true, value: (r) => (r.hours ? (r.overtime_hours / r.hours) * 100 : null), render: (r) => percent(r.hours ? (r.overtime_hours / r.hours) * 100 : null) },
    { key: 'ar_open', header: 'Open AR', numeric: true, render: (r) => moneyFull(r.ar_open) },
    { key: 'days_outstanding_weighted', header: 'Weighted days', numeric: true, className: (r) => ((r.days_outstanding_weighted ?? 0) > 45 ? 'text-bad' : undefined), render: (r) => number(r.days_outstanding_weighted) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ]
  return <>
    <ScopeLine />
    <DemoNotice>Accounts aggregate the seeded sites.</DemoNotice>
    <div className="kpi-grid kpi-grid--compact">
      <KpiCard label="Active accounts" loading={accounts.loading} value={number(rows.length)} delta={null} context={`${number(sum(rows, (r) => r.jobs))} contracted sites`} favorable="none" />
      <KpiCard label="Portfolio revenue" loading={accounts.loading} value={money(revenue)} delta={null} context={rangeSubtitle(accounts.data?.range, 'USD')} />
      <KpiCard label="Top-3 concentration" loading={accounts.loading} value={percent(revenue ? (sum(rows.slice(0, 3), (r) => r.revenue) / revenue) * 100 : null)} delta={null} context="share of account revenue" favorable="down" />
      <KpiCard label="Accounts at risk" loading={accounts.loading} value={number(atRisk)} delta={null} context={`${money(ar)} open receivables`} favorable="down" />
    </div>
    <div className="dashboard-grid">
      <QueryCard title="Revenue by account" subtitle={`${rangeSubtitle(accounts.data?.range)} · click to focus`} className="span-5" query={accounts} isEmpty={() => !rows.length}>{() => <GroupBars data={rows.map((r) => ({ name: r.parent_account, revenue: r.revenue }))} onSelect={focus} max={12} />}</QueryCard>
      <QueryCard title="Account health" subtitle={`${rangeSubtitle(accounts.data?.range)} · click a row to filter to the account`} className="span-7" query={accounts} skeleton="table" isEmpty={() => !rows.length}>{() => <DataGrid rows={rows} columns={columns} rowKey={(r) => r.parent_account} defaultSort={{ key: 'revenue', dir: 'desc' }} onRowClick={(r) => focus(r.parent_account)} csvName="accounts" dense />}</QueryCard>
    </div>
  </>
}
