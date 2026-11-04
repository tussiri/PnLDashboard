import { Download } from 'lucide-react'
import { useContext, useState } from 'react'
import { useApiQuery } from '../../hooks/useApiQuery'
import type { FedexInvoiceBasis, FedexInvoiceRow, FedexInvoicesResponse, LeadershipAccount } from '../../services/apiTypes'
import { downloadCsv, toCsv, type CsvColumn } from '../../services/csv'
import { queryKey } from '../../services/queryClient'
import { money, pct } from '../format'
import { addDays, monthLabel } from '../routes'
import { useLeadership } from '../state'
import { CanExport, Empty, Kpi, LoadError, Pills, Skeleton, SortTable, type Column } from '../ui'

const DASH = '–'
const PAGE = 50

/** The calendar month before the one `today` is in, as [first, last]. */
export function lastMonthRange(today: string): [string, string] {
  const first = `${today.slice(0, 7)}-01`
  const last = addDays(first, -1)
  return [`${last.slice(0, 7)}-01`, last]
}

const vendorTip = (r: FedexInvoiceRow) => [
  r.crane_payables ? 'Crane self-perform: not a vendor cost' : null,
  r.not_in_winteam ? `${r.not_in_winteam} payable${r.not_in_winteam === 1 ? '' : 's'} not in WinTeam yet` : null,
  r.vendor_numbers ? `Vendor # ${r.vendor_numbers}` : null,
].filter(Boolean).join('. ') || undefined

const COLUMNS: Column<FedexInvoiceRow>[] = [
  { key: 'invoice', header: 'Invoice', left: true, value: (r) => r.invoice_number },
  { key: 'date', header: 'Date', left: true, value: (r) => r.invoice_date },
  { key: 'month', header: 'Service month', left: true, value: (r) => r.service_month, render: (r) => monthLabel(r.service_month) || DASH },
  { key: 'site', header: 'Site', left: true, value: (r) => `${r.job_number ?? ''} ${r.site_name ?? ''}`.trim(), className: 'nm' },
  { key: 'vendor', header: 'Vendor', left: true, value: (r) => r.vendors, className: 'nm',
    render: (r) => <span title={vendorTip(r)}>{r.delivery === 'Self-perform' && !r.payables ? 'Self-perform' : r.vendors ?? DASH}{r.crane_payables > 0 && <span className="neutral"> · Crane</span>}</span> },
  { key: 'vinv', header: 'Vendor invoice', left: true, value: (r) => r.vendor_invoices, render: (r) => r.vendor_invoices ?? DASH },
  { key: 'state', header: 'Portal', left: true, value: (r) => r.portal_state, render: (r) => r.portal_state ?? DASH },
  { key: 'revenue', header: 'Billed', value: (r) => r.revenue, render: (r) => money(r.revenue) },
  { key: 'cost', header: 'Vendor cost', value: (r) => r.vendor_cost, render: (r) => (r.vendor_cost == null ? DASH : money(r.vendor_cost)) },
  { key: 'margin', header: 'Margin', value: (r) => r.margin_pct, render: (r) => (r.margin_pct == null ? DASH : pct(r.margin_pct)) },
]

/** The download: every field of every invoice in the range. */
export const CSV_COLUMNS: CsvColumn<FedexInvoiceRow>[] = [
  { key: 'invoice_number', header: 'Invoice #' },
  { key: 'invoice_date', header: 'Invoice date' },
  { key: 'service_month', header: 'Service month', value: (r) => r.service_month?.slice(0, 7) },
  { key: 'billing_period_from', header: 'Billing period from' },
  { key: 'billing_period_to', header: 'Billing period to' },
  { key: 'customer_number', header: 'Customer #' },
  { key: 'company', header: 'Company' },
  { key: 'job_number', header: 'Job #' },
  { key: 'site_name', header: 'Site' },
  { key: 'stations', header: 'Stations' },
  { key: 'delivery', header: 'Delivery' },
  { key: 'revenue', header: 'Revenue before tax' },
  { key: 'tax', header: 'Tax' },
  { key: 'invoice_total', header: 'Invoice total' },
  { key: 'portal_state', header: 'Portal state' },
  { key: 'remitted', header: 'Remitted' },
  { key: 'paid_date', header: 'Paid date' },
  { key: 'vendors', header: 'Vendor' },
  { key: 'vendor_numbers', header: 'Vendor #' },
  { key: 'vendor_invoices', header: 'Vendor invoice #' },
  { key: 'work_orders', header: 'Work order #' },
  { key: 'payables', header: 'Payables' },
  { key: 'crane_payables', header: 'Crane self-perform payables' },
  { key: 'vendor_cost', header: 'Vendor cost' },
  { key: 'margin', header: 'Margin' },
  { key: 'margin_pct', header: 'Margin %', value: (r) => (r.margin_pct == null ? null : Math.round(r.margin_pct * 1000) / 10) },
  { key: 'vendor_payment', header: 'Vendor payment status' },
  { key: 'vendor_paid', header: 'Vendor paid' },
  { key: 'vendor_paid_date', header: 'Vendor paid date' },
  { key: 'check_numbers', header: 'Check #' },
  { key: 'not_in_winteam', header: 'Payables not in WinTeam' },
]

/** FedEx invoices from Relay in a date range, each with the vendor payables behind it, and a CSV of every field. */
export function FedexInvoices({ account }: { account: LeadershipAccount }) {
  const { api, keyPrefix, decision, route, navigate } = useLeadership()
  const canExport = useContext(CanExport)
  const [defaults] = useState(() => lastMonthRange(new Date().toLocaleDateString('en-CA')))
  const dateFrom = route.from ?? defaults[0]
  const dateTo = route.to ?? defaults[1]
  const basis: FedexInvoiceBasis = route.invoiceBy ?? 'invoice'
  const query = { account: account.slug, date_from: dateFrom, date_to: dateTo, basis }
  const q = useApiQuery<FedexInvoicesResponse>(decision ? queryKey(`${keyPrefix}/leadership/fedex-invoices`, query) : null,
    (signal) => api.fedexInvoices(query, signal), [api, account.slug, dateFrom, dateTo, basis])
  const d = q.data
  const download = () => d && downloadCsv(`fedex-invoices-${dateFrom}-to-${dateTo}`, toCsv(d.rows, CSV_COLUMNS))
  const t = d?.totals
  return <>
    <div className="card">
      <div className="filters ctrl">
        <label htmlFor="fi-from">From</label>
        <input id="fi-from" type="date" value={dateFrom} max={dateTo} onChange={(e) => e.target.value && navigate({ from: e.target.value }, { replace: true })} />
        <label htmlFor="fi-to">To</label>
        <input id="fi-to" type="date" value={dateTo} min={dateFrom} onChange={(e) => e.target.value && navigate({ to: e.target.value }, { replace: true })} />
        <Pills label="Dates by" value={basis} onChange={(v) => navigate({ invoiceBy: v === 'service' ? 'service' : undefined }, { replace: true })}
          options={[{ value: 'invoice', label: 'Invoice date' }, { value: 'service', label: 'Service month' }]} />
        {canExport && <button type="button" className="btn primary" disabled={!d?.rows.length} onClick={download}
          title={d?.as_of ? `From Relay, synced ${new Date(d.as_of).toLocaleString('en-US')}` : 'From Relay'}>
          <Download size={14} aria-hidden="true" />Export CSV</button>}
      </div>
    </div>
    {q.error ? <LoadError error={q.error} onRetry={q.refetch} /> : !d || !t ? <Skeleton height={420} /> : <>
      <div className="kpi-lg">
        <Kpi label="Invoices" value={t.invoices.toLocaleString('en-US')} tip={`${t.sites} sites, ${t.vendors} vendors`} />
        <Kpi label="Billed" value={money(t.revenue)} tip={`Before tax. Invoice total with tax ${money(t.invoice_total)}`} />
        <Kpi label="Vendor cost" value={money(t.vendor_cost)}
          tip={[t.without_payable ? `${t.without_payable} subcontracted invoices have no vendor payable linked yet` : null,
            t.crane_payables ? `${t.crane_payables} Crane self-perform payables left out` : null].filter(Boolean).join('. ') || undefined} />
        <Kpi label="Margin" value={t.margin_pct == null ? DASH : pct(t.margin_pct)} tip={t.margin == null ? undefined : `${money(t.margin)} on invoices with a vendor payable`} />
      </div>
      <div className="card">
        {!d.rows.length ? <Empty>No FedEx invoices in this range.</Empty>
          : <SortTable caption="FedEx invoices" rows={d.rows} columns={COLUMNS} defaultSort={{ key: 'date', dir: 1 }} pageSize={PAGE} />}
      </div>
    </>}
  </>
}
