import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { QueryCard } from '../components/CardState'
import { DataGrid, type Column } from '../components/DataGrid'
import { useDashboard } from '../context/DashboardContext'
import type { JobRow } from '../services/apiTypes'
import type { DeliveryFilter } from '../types'
import { isMeaningfulMargin, money, moneyFull, number, percent, signed } from '../utils'
import { DemoNotice, MarginCell, rangeSubtitle, ScopeLine, StatusBadge, useJobsQuery } from './shared'
import { deliveryLabel } from './forecastShared'


export function Jobs() {
  const { openJob, filters, setFilters } = useDashboard()
  const jobs = useJobsQuery()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  // Delivery is a global filter (the API scopes the rows); the toolbar select drives that one state.
  const delivery = filters.delivery === 'all' ? '' : filters.delivery
  const [activeOnly, setActiveOnly] = useState(true)
  const all = jobs.data?.jobs ?? []
  // Finance reference source columns appear only when the payload carries them.
  const hasCompany = all.some((j) => j.company !== undefined && j.company !== null)
  const hasDelivery = all.some((j) => j.delivery_model !== undefined && j.delivery_model !== null)
  const rows = useMemo(() => all.filter((j) => (!status || j.status === status) && (!delivery || j.delivery_model === delivery) && (!activeOnly || j.is_active) && (!q || `${j.job_name} ${j.job_number} ${j.parent_account} ${j.city} ${j.state_province} ${j.branch} ${j.manager_name} ${j.company ?? ''}`.toLowerCase().includes(q.toLowerCase()))), [all, q, status, delivery, activeOnly])
  const columns: Column<JobRow>[] = [
    { key: 'job_name', header: 'Site', render: (r) => <><strong>{r.job_name}</strong><span className="muted"> {r.job_number}{r.is_active ? '' : ' · inactive'}</span>{r.delivery_model === 'subcontracted' && <span className="tag-chip tag-chip--sub">Subcontracted</span>}</> },
    { key: 'parent_account', header: 'Account' },
    ...(hasCompany ? [{ key: 'company', header: 'Company', value: (r: JobRow) => r.company ?? '', render: (r: JobRow) => r.company ?? <span className="muted">—</span> } as Column<JobRow>] : []),
    ...(hasDelivery ? [{ key: 'delivery_model', header: 'Delivery', value: (r: JobRow) => r.delivery_model ?? '', render: (r: JobRow) => deliveryLabel(r.delivery_model) } as Column<JobRow>] : []),
    { key: 'branch', header: 'Branch', render: (r) => <>{r.branch}<span className="muted"> · {r.city}, {r.state_province}</span></> },
    { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => moneyFull(r.revenue) },
    { key: 'gross_margin_pct', header: 'Margin', numeric: true, className: (r) => (!isMeaningfulMargin(r.gross_margin_pct) ? 'text-muted' : (r.gross_margin_pct ?? 0) < 18 ? 'text-bad' : (r.gross_margin_pct ?? 0) < 25 ? 'text-warn' : 'text-good'), render: (r) => <MarginCell job={r} /> },
    { key: 'labor_variance', header: 'Labor var.', numeric: true, className: (r) => (r.labor_variance === null ? undefined : r.labor_variance > 0 ? 'text-bad' : 'text-good'), render: (r) => (r.labor_variance === null ? <span className="muted">no budget</span> : signed(r.labor_variance, (v) => money(v))) },
    { key: 'ot_pct', header: 'OT %', numeric: true, value: (r) => (r.hours ? (r.overtime_hours / r.hours) * 100 : null), className: (r) => ((r.hours ? (r.overtime_hours / r.hours) * 100 : 0) > 15 ? 'text-bad' : (r.hours ? (r.overtime_hours / r.hours) * 100 : 0) > 10 ? 'text-warn' : undefined), render: (r) => percent(r.hours ? (r.overtime_hours / r.hours) * 100 : null) },
    { key: 'ar_open', header: 'Open AR', numeric: true, render: (r) => <>{moneyFull(r.ar_open)}{r.days_outstanding_weighted !== null && <span className={`muted ${r.days_outstanding_weighted > 45 ? 'text-bad' : ''}`}> · {Math.round(r.days_outstanding_weighted)}d</span>}</> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} reasons={r.status_reasons} /> },
  ]
  return <>
    <ScopeLine />
    <DemoNotice>Site statuses, company and delivery model are derived from seeded rows.</DemoNotice>
    <QueryCard title="Sites" subtitle={rangeSubtitle(jobs.data?.range, 'click a row or press Enter to open')} query={jobs} skeleton="table" isEmpty={(j) => !j.jobs.length} emptyHint="No sites match the global filters.">{() => <DataGrid rows={rows} columns={columns} rowKey={(r) => r.job_number} defaultSort={{ key: 'revenue', dir: 'desc' }} onRowClick={(r) => openJob(r.job_number)} csvName="sites" pageSize={25} emptyTitle="No sites match" emptyHint="Adjust the search, status or active filter." toolbar={<><label className="grid-search"><Search size={14} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search site, account, company, city, manager…" aria-label="Search sites" /></label><label className="inline-select"><span>Status</span><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option>Healthy</option><option>Watch</option><option>Critical</option></select></label>{hasDelivery && <label className="inline-select"><span>Delivery</span><select value={delivery} onChange={(e) => setFilters((f) => ({ ...f, delivery: (e.target.value || 'all') as DeliveryFilter }))} aria-label="Delivery model"><option value="">All</option><option value="self_perform">Self-performed</option><option value="subcontracted">Subcontracted</option></select></label>}<label className="inline-check"><input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Active only</label></>} />}</QueryCard>
  </>
}
