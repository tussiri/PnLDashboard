import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { QueryCard } from '../components/CardState'
import { AgingBars } from '../components/Charts'
import { series } from '../components/ChartKit'
import { DataGrid, type Column } from '../components/DataGrid'
import { KpiCard } from '../components/KpiCard'
import { useDashboard } from '../context/DashboardContext'
import { CASH_APPLICATION_WARNING, CASH_APPLICATION_WARN_BELOW, applyCollectible, cashApplicationTone, collectibleAvailable as hasCollectible } from '../services/aging'
import type { AgingBucketKey, AgingCustomer, ArAgingResponse, ArInvoiceRow, ArInvoicesResponse } from '../services/apiTypes'
import { downloadCsv, toCsv } from '../services/csv'
import { fmtDate, money, moneyFull, number, percent, sum } from '../utils'
import { DemoNotice, JobLink, Note, ScopeLine, useReportingParams, useReportQuery } from './shared'

const PAGE = 25
const bucketColors: Record<AgingBucketKey, string> = { current: series.primary, d30: series.secondary, d60: series.warn, d90: series.bad, d90_plus: '#9b2c3a' }
const bucketKeys: AgingBucketKey[] = ['current', 'd30', 'd60', 'd90', 'd90_plus']

export function Billing() {
  const { query, params } = useReportingParams()
  const { api, filters } = useDashboard()
  const agingFilters = useMemo(() => ({ scope: query.scope, account: query.account, sub_account: query.sub_account, delivery: query.delivery, region: query.region, branch: query.branch, service_type: query.service_type, vertical: query.vertical, company: query.company }), [query])
  const aging = useReportQuery<ArAgingResponse>('ar/aging', (api, signal) => api.arAging(agingFilters, signal), agingFilters as Record<string, unknown>)
  const [bucket, setBucket] = useState<AgingBucketKey | null>(null)
  const [customer, setCustomer] = useState('')
  const [page, setPage] = useState(0)
  // null = "not touched": defaults to ON whenever the API reports a collectible total.
  const [collectibleChoice, setCollectibleChoice] = useState<boolean | null>(null)
  const collectibleAvailable = hasCollectible(aging.data)
  const collectibleOnly = collectibleAvailable && (collectibleChoice ?? true)
  const view = useMemo(() => (aging.data ? applyCollectible(aging.data, collectibleOnly) : null), [aging.data, collectibleOnly])
  const invoiceQuery = useMemo(() => ({ bucket: bucket ?? undefined, customer: customer || undefined, scope: query.scope, account: query.account, sub_account: query.sub_account, delivery: query.delivery, limit: PAGE, offset: page * PAGE }), [bucket, customer, query, page])
  const invoices = useReportQuery<ArInvoicesResponse>('ar/invoices', (api, signal) => api.arInvoices(invoiceQuery, signal), invoiceQuery as Record<string, unknown>)
  const totalOpen = view?.totalOpen ?? 0
  const buckets = view?.buckets ?? []
  const over90 = sum(buckets.filter((b) => b.bucket === 'd90' || b.bucket === 'd90_plus'), (b) => b.amount)
  const invoiceCount = view?.invoiceCount ?? 0
  const customers = view?.customers ?? []
  const excluded = view?.excluded ?? []
  const excludedOpen = sum(excluded, (c) => c.total)
  const labels = Object.fromEntries((aging.data?.buckets ?? []).map((b) => [b.bucket, b.label])) as Record<AgingBucketKey, string>
  const pageCount = Math.max(1, Math.ceil((invoices.data?.total ?? 0) / PAGE))
  const asOf = aging.data?.as_of ?? aging.data?.source.ar_as_of ?? null
  const cash = aging.data?.cash_application ?? null
  const cashTone = cashApplicationTone(cash)
  const columns: Column<ArInvoiceRow>[] = [
    { key: 'invoice_number', header: 'Invoice', render: (r) => <strong className="num">{r.invoice_number}</strong> },
    { key: 'customer_name', header: 'Customer', render: (r) => <>{r.customer_name ?? '—'}{r.parent_account && r.parent_account !== r.customer_name ? <span className="muted"> · {r.parent_account}</span> : null}</> },
    { key: 'job_name', header: 'Site', render: (r) => (r.job_number ? <JobLink job={{ job_number: r.job_number }}>{r.job_name ?? r.job_number}</JobLink> : r.job_name ?? '—') },
    { key: 'invoice_date', header: 'Invoiced', render: (r) => fmtDate(r.invoice_date), csv: (r) => r.invoice_date },
    { key: 'terms', header: 'Terms', render: (r) => r.terms ?? '—' },
    { key: 'days_outstanding', header: 'Days', numeric: true, className: (r) => ((r.days_outstanding ?? 0) > 60 ? 'text-bad' : (r.days_outstanding ?? 0) > 30 ? 'text-warn' : undefined) },
    { key: 'aging_bucket', header: 'Bucket', render: (r) => (r.aging_bucket ? <span className="bucket-chip" style={{ color: bucketColors[r.aging_bucket] }}>{labels[r.aging_bucket] ?? r.aging_bucket}</span> : '—') },
    { key: 'collection_status', header: 'Status', render: (r) => r.collection_status ?? '—' },
    { key: 'invoice_total', header: 'Invoice', numeric: true, render: (r) => moneyFull(r.invoice_total) },
    { key: 'open_balance', header: 'Open', numeric: true, render: (r) => moneyFull(r.open_balance) },
  ]
  const exportAll = async () => {
    const all: ArInvoiceRow[] = []
    for (let offset = 0; offset < (invoices.data?.total ?? 0); offset += 500) { const chunk = await api.arInvoices({ ...invoiceQuery, limit: 500, offset }); all.push(...chunk.items); if (!chunk.items.length) break }
    downloadCsv('open-invoices', toCsv(all, columns.map((c) => ({ key: c.key, header: c.header, value: (row: ArInvoiceRow) => (c.csv ? c.csv(row) : (row as Record<string, unknown>)[c.key]) }))))
  }
  const customerMax = Math.max(1, ...customers.map((c) => c.total))
  const customerLabel = (c: AgingCustomer) => `${c.customer_name}${c.is_collectible === false ? ' (excluded)' : ''}`
  return <>
    <ScopeLine />
    <DemoNotice>Seeded open invoices; Harbor Properties is flagged as an intercompany balance.</DemoNotice>
    {aging.data && <div className="ar-header" aria-label="Receivables basis">
      <strong>Open receivables{asOf ? ` as of ${fmtDate(asOf)}` : ''}</strong>
      {collectibleAvailable && <span className="ar-totals"><span>Total open <b className="num">{money(aging.data.total_open)}</b></span><span>Collectible <b className="num">{money(aging.data.collectible_open)}</b></span><span>Excluded <b className="num">{money(excludedOpen)}</b> · {excluded.length} customer{excluded.length === 1 ? '' : 's'}</span></span>}
      {collectibleAvailable && <label className="inline-check"><input type="checkbox" checked={collectibleOnly} onChange={(e) => setCollectibleChoice(e.target.checked)} /> Collectible only</label>}
    </div>}
    <div className="kpi-grid kpi-grid--compact">
      <KpiCard label={collectibleOnly ? 'Collectible receivables' : 'Open receivables'} loading={aging.loading} value={money(totalOpen)} delta={null} context={`${asOf ? `As of ${fmtDate(asOf)} · ` : ''}${number(invoiceCount)} open invoices`} favorable="down" />
      <KpiCard label="DSO" loading={aging.loading} value={aging.data?.dso_days === null || aging.data?.dso_days === undefined ? '—' : `${number(aging.data.dso_days)} days`} delta={null} context="open AR ÷ (trailing-3-month revenue ÷ 91)" favorable="down" />
      <KpiCard label="Over 90 days" loading={aging.loading} value={money(over90)} delta={null} context={percent(totalOpen ? (over90 / totalOpen) * 100 : null) + ' of open AR'} favorable="down" />
      <KpiCard label="Customers with balances" loading={aging.loading} value={number(customers.length)} delta={null} context={customers[0] ? `largest: ${customers[0].customer_name} ${money(customers[0].total)}` : ''} favorable="none" />
    </div>
    {cash && <section className={`cash-application ${cashTone === 'warn' ? 'cash-application--warn' : ''}`} aria-label="Cash application">
      <header><strong>Cash application</strong><span className="muted">{asOf ? `Aging snapshot as of ${fmtDate(asOf)}` : 'Latest aging snapshot'}{cashTone === 'warn' ? ` · below ${CASH_APPLICATION_WARN_BELOW}% applied` : ''}</span></header>
      <div className="cash-application__facts">
        <div><span>With any payment applied</span><strong className="num">{percent(cash.pct_with_payment_applied, 0)}</strong><small>{number(cash.invoices_with_payment_applied)} of {number(cash.invoices_open)} open invoices</small></div>
        <div><span>Open with nothing applied</span><strong className="num">{money(cash.open_nothing_applied)}</strong><small>{totalOpen ? `${percent((cash.open_nothing_applied / aging.data!.total_open) * 100, 0)} of total open` : ''}</small></div>
        <div><span>Of which over 90 days</span><strong className="num">{money(cash.open_nothing_applied_over_90)}</strong><small>no payment applied · aged past 90</small></div>
        <div><span>Oldest open invoice</span><strong className="num">{cash.oldest_open_invoice_date ? fmtDate(cash.oldest_open_invoice_date) : '—'}</strong><small>invoice date</small></div>
      </div>
      {cashTone === 'warn' && <p className="cash-application__warning"><strong>Warning.</strong> {CASH_APPLICATION_WARNING}</p>}
      <p className="cash-application__note">{cash.note}</p>
    </section>}
    <div className="dashboard-grid">
      <QueryCard title="Aging buckets" subtitle={`Open AR by days outstanding${collectibleOnly ? ' · collectible customers' : ''} · click a bar to filter invoices`} className="span-5" query={aging} isEmpty={() => !totalOpen} emptyTitle="No open receivables" emptyHint="Nothing is outstanding for the current filters.">{() => <AgingBars buckets={buckets} onSelect={(b) => { setBucket(b); setPage(0) }} active={bucket} />}</QueryCard>
      <QueryCard title="Aging by customer" subtitle="Stacked by bucket · sorted by total open · click a row to filter invoices" className="span-7" query={aging} isEmpty={() => !customers.length} note={collectibleAvailable ? <Note>{collectibleOnly ? `Intercompany and settlement balances (${excluded.map((c) => c.customer_name).join(', ') || 'none in this scope'}) are excluded per the ar_treatment_rules setting; they are not collectible cash.` : 'Showing every customer, including intercompany and settlement balances that are not collectible cash.'}</Note> : undefined}>{() => <div className="stack-matrix"><div className="stack-matrix__legend">{bucketKeys.map((key) => <span key={key}><i style={{ background: bucketColors[key] }} />{labels[key] ?? key}</span>)}</div>{customers.slice(0, 12).map((c: AgingCustomer) => <button type="button" key={c.customer_number} className={`stack-matrix__row ${customer === c.customer_number ? 'is-active' : ''}`} onClick={() => { setCustomer(customer === c.customer_number ? '' : c.customer_number); setPage(0) }} aria-pressed={customer === c.customer_number}><span className="stack-matrix__name"><strong>{c.customer_name}{c.is_collectible === false && <span className="tag-chip">Excluded</span>}</strong><small>{c.invoices} inv.{c.company ? ` · ${c.company}` : ''}</small></span><span className="stack-matrix__bar" style={{ width: `${(c.total / customerMax) * 100}%` }}>{bucketKeys.map((key) => (c[key] ? <i key={key} style={{ width: `${(c[key] / c.total) * 100}%`, background: bucketColors[key] }} title={`${labels[key] ?? key}: ${money(c[key])}`} /> : null))}</span><b className="num">{money(c.total)}</b></button>)}</div>}</QueryCard>
    </div>
    <QueryCard title="Open invoices" subtitle={`${invoices.data ? `${number(invoices.data.total)} invoices` : 'Loading'}${bucket ? ` · bucket ${labels[bucket] ?? bucket}` : ''}${customer ? ` · ${aging.data?.by_customer.find((c) => c.customer_number === customer)?.customer_name ?? customer}` : ''}`} query={invoices} skeleton="table" isEmpty={(i) => !i.items.length} emptyHint="No open invoices match the bucket and customer filters." action={<div className="toolbar-inline"><label className="inline-select"><span>Bucket</span><select value={bucket ?? ''} onChange={(e) => { setBucket((e.target.value || null) as AgingBucketKey | null); setPage(0) }}><option value="">All</option>{bucketKeys.map((key) => <option key={key} value={key}>{labels[key] ?? key}</option>)}</select></label><label className="inline-select"><span>Customer</span><select value={customer} onChange={(e) => { setCustomer(e.target.value); setPage(0) }}><option value="">All</option>{(aging.data?.by_customer ?? []).map((c) => <option key={c.customer_number} value={c.customer_number}>{customerLabel(c)}</option>)}</select></label><button type="button" className="text-button" onClick={exportAll} disabled={!invoices.data?.total}>Export CSV</button></div>} note={<Note>Paged server-side ({PAGE} per page). Export fetches every page for the current filters.{collectibleOnly ? ' The invoice list is not filtered by the collectible toggle; excluded customers are marked in the customer selector.' : ''}</Note>}>{(i) => <DataGrid rows={i.items} columns={columns} rowKey={(r) => r.invoice_number} defaultSort={{ key: 'days_outstanding', dir: 'desc' }} dense footer={pageCount > 1 ? <div className="data-grid__pager data-grid__pager--footer"><button type="button" onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}><ChevronLeft size={13} aria-hidden="true" />Previous</button><span className="num">Page {page + 1} of {pageCount}</span><button type="button" onClick={() => setPage(Math.min(pageCount - 1, page + 1))} disabled={page >= pageCount - 1}>Next<ChevronRight size={13} aria-hidden="true" /></button></div> : null} />}</QueryCard>
  </>
}
