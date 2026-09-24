import { useApiQuery } from '../../hooks/useApiQuery'
import type { LeadershipAccount, LeadershipVendorsResponse } from '../../services/apiTypes'
import { queryKey } from '../../services/queryClient'
import { money } from '../format'
import { monthLabel } from '../routes'
import { useLeadership } from '../state'
import { Empty, Kpi, LoadError, Skeleton, SortTable, type Column } from '../ui'

type Line = LeadershipVendorsResponse['lines'][number]
type Vendor = LeadershipVendorsResponse['by_vendor'][number]
type Site = LeadershipVendorsResponse['by_site'][number]

/** Subcontractor invoices coded to the account's sites (AP distributions from subcontractor vendors only). */
export function Vendors({ account }: { account: LeadershipAccount }) {
  const { api, keyPrefix, decision, navigate } = useLeadership()
  const q = useApiQuery<LeadershipVendorsResponse>(decision ? queryKey(`${keyPrefix}/leadership/vendors`, { account: account.slug, months: 6 }) : null,
    (signal) => api.leadershipVendors(account.slug, 6, signal), [api, account.slug])
  if (q.error) return <LoadError error={q.error} onRetry={q.refetch} />
  if (!q.data) return <Skeleton height={320} />
  const d = q.data
  if (!d.lines.length) return <Empty>No subcontractor invoices coded to {account.name} sites since {monthLabel(d.since)}.</Empty>
  const vendorCols: Column<Vendor>[] = [
    { key: 'name', header: 'Vendor', left: true, value: (r) => r.vendor_name, className: 'nm' },
    { key: 'no', header: 'Vendor #', value: (r) => r.vendor_number },
    { key: 'inv', header: 'Invoices', value: (r) => r.invoices },
    { key: 'amt', header: 'Amount', value: (r) => r.amount, render: (r) => money(r.amount) },
    { key: 'share', header: 'Share', value: (r) => r.amount / d.total, render: (r) => `${((r.amount / d.total) * 100).toFixed(1)}%` },
  ]
  const siteCols: Column<Site>[] = [
    { key: 'job', header: 'Job', left: true, value: (r) => r.job_number },
    { key: 'name', header: 'Location', left: true, value: (r) => r.site_name, className: 'nm' },
    { key: 'inv', header: 'Invoices', value: (r) => r.invoices },
    { key: 'amt', header: 'Amount', value: (r) => r.amount, render: (r) => money(r.amount) },
  ]
  const lineCols: Column<Line>[] = [
    { key: 'date', header: 'Date', left: true, value: (r) => r.invoice_date },
    { key: 'site', header: 'Location', left: true, value: (r) => `${r.job_number} ${r.site_name}`, className: 'nm' },
    { key: 'vendor', header: 'Vendor', left: true, value: (r) => r.vendor_name, className: 'nm' },
    { key: 'invno', header: 'Invoice', left: true, value: (r) => r.invoice_number },
    { key: 'gl', header: 'GL', value: (r) => r.gl_account_number },
    { key: 'amt', header: 'Amount', value: (r) => r.amount, render: (r) => money(r.amount) },
  ]
  const months = d.by_month
  return <>
    <div className="kpi-lg">
      <Kpi label="Subcontractor invoices" value={money(d.total)} sub={`Since ${monthLabel(d.since)}`} />
      <Kpi label="Vendors" value={d.by_vendor.length} sub="Subcontractor vendor types" />
      <Kpi label="Sites billed" value={d.by_site.length} sub={`of ${account.sites} mapped`} />
      <Kpi label="Latest month" value={months.length ? money(months[months.length - 1].amount) : '–'} sub={months.length ? monthLabel(months[months.length - 1].month) : ''} />
      <Kpi label="Invoice lines" value={d.lines.length} />
    </div>
    <div className="charts2">
      <div className="card"><div className="ct"><span>By vendor</span></div><SortTable caption="Subcontractor cost by vendor" rows={d.by_vendor} columns={vendorCols} defaultSort={{ key: 'amt', dir: -1 }} /></div>
      <div className="card"><div className="ct"><span>By site</span></div><SortTable caption="Subcontractor cost by site" rows={d.by_site} columns={siteCols} defaultSort={{ key: 'amt', dir: -1 }}
        onRowClick={(r) => navigate({ site: { company: r.company, job: r.job_number } })} rowLabel={(r) => `Open ${r.site_name}`} /></div>
    </div>
    <div className="card"><div className="ct"><span>Invoice lines</span></div><SortTable caption="Subcontractor invoice lines" rows={d.lines} columns={lineCols} defaultSort={{ key: 'date', dir: -1 }} csvName={`${account.slug}-subcontractor-invoices`} /></div>
  </>
}
