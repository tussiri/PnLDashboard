import { X } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { useApiQuery } from '../../hooks/useApiQuery'
import type { LeadershipSiteResponse } from '../../services/apiTypes'
import { queryKey } from '../../services/queryClient'
import { TrendChart } from '../charts'
import { includesVendor, inSentence, vendorLabel } from '../data'
import { hours, hours1, money, pct, pts, rate } from '../format'
import { siteMetrics } from '../metrics'
import { monthLabel, weekLabel, weekTick } from '../routes'
import { useLeadership } from '../state'
import { Badge, ChartCard, Empty, Kpi, LoadError, Skeleton, Swatch, toneOf, VocabContext } from '../ui'
import { vocabOf } from '../vocab'
import { useTokens } from '../charts'

/** Site detail drawer: this week's labor P&L, a 13-week trend, subcontractor invoices and CompanyCam photos. */
export function SiteDrawer({ company, job }: { company: string; job: string }) {
  const { api, keyPrefix, decision, weekStart, navigate, accountBySlug, optionsFor } = useLeadership()
  const t = useTokens()
  const panel = useRef<HTMLDivElement>(null)
  const close = () => navigate({ site: undefined })
  const q = useApiQuery<LeadershipSiteResponse>(decision && weekStart ? queryKey(`${keyPrefix}/leadership/site`, { company, job, week: weekStart }) : null,
    (signal) => api.leadershipSite(company, job, { week: weekStart, weeks: 13 }, signal), [api, company, job, weekStart])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, job])

  const account = accountBySlug(q.data?.site.account_slug ?? undefined)
  const options = useMemo(() => optionsFor(account), [optionsFor, account])
  const weeks = useMemo(() => (q.data?.weeks ?? []).map((r) => siteMetrics(r, options)), [q.data, options])
  const current = weeks.find((r) => r.week_start === weekStart)
  const site = q.data?.site
  const m = 'Labor %'

  return <VocabContext.Provider value={vocabOf(account)}>
    <button type="button" className="scrim" aria-label="Close site detail" onClick={close} />
    <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" ref={panel} tabIndex={-1}>
      <div className="drawer__hdr">
        <div><h1 id="drawer-title">{site ? `${site.job_number} ${site.site_name}` : `Job ${job}`}</h1>
          <p className="ks">{[site?.segment, account?.name ?? site?.parent_account ?? 'Other', site?.company, weekStart ? weekLabel(weekStart) : null].filter(Boolean).join(' · ')}</p></div>
        <button type="button" className="iconbtn" onClick={close} aria-label="Close"><X size={14} aria-hidden="true" /></button>
      </div>
      {q.error ? <LoadError error={q.error} onRetry={q.refetch} /> : !q.data ? <Skeleton height={400} /> : <>
        {current ? <div className="kpi-lg">
          <Kpi label="Invoicing" value={money(current.invoice)} sub={current.revenue_allocated ? `Incl. ${money(current.revenue_allocated / (options.divisor ?? 4.33))} spread from parent` : `${monthLabel(current.revenue_month)} revenue`} />
          <Kpi label="Direct labor" value={money(current.labor)} sub={current.labor_basis === 'pay_report' ? 'Pay report' : 'Estimated'} tone={current.labor_basis === 'pay_report' ? '' : 'warn'} />
          <Kpi label={m} value={pct(current.measurePct)} tone={toneOf(current.status)} sub={`${current.measurePct == null ? '' : `${pts(current.measurePct - current.target)} vs ${pct(current.target)} target; `}${monthLabel(current.revenue_month)} ${pct(current.priorLaborPct)}`} />
          <Kpi label="Hours" value={hours1(current.hours)} sub={`${hours1(current.ot_hours)} OT (${pct(current.otPct)})`} />
          <Kpi label="Hours to cut" value={<>{hours1(current.overHours / 7)}<span className="of">/day</span></>} tone={current.overHours > 0.5 ? 'bad' : 'ok'} sub={`${hours1(current.overHours)}h this week; base rate ${rate(current.baseRate)}`} />
          {(includesVendor(account) || (current.sub_week ?? 0) > 0) && <Kpi label={vendorLabel(account)} value={money(current.sub_week)} sub={includesVendor(account) ? `Total labor ${money(current.cost)}` : undefined} />}
        </div> : <Empty>No data for this week.</Empty>}
        {weeks.length > 1 && <ChartCard title={`${m} by week`} height={200}
          legend={<><Swatch color={t.accent} label={m} /><Swatch line label={`Target ${pct(options.target)}`} /></>}
          chart={<TrendChart labels={weeks.map((r) => weekTick(r.week_start))} values={weeks.map((r) => r.measurePct)} target={current?.target ?? options.target} label={m} />}
          table={<table><thead><tr><th className="nosort l">Week ending</th><th className="nosort">Invoicing</th><th className="nosort">Direct labor</th><th className="nosort">{m}</th><th className="nosort">Hours</th><th className="nosort">OT hrs</th></tr></thead>
            <tbody>{weeks.map((r) => <tr key={r.week_start}><td className="l">{weekTick(r.week_start)}</td><td>{money(r.invoice)}</td><td>{money(r.labor)}</td><td>{pct(r.measurePct)}</td><td>{hours1(r.hours)}</td><td>{hours1(r.ot_hours)}</td></tr>)}</tbody></table>} />}
        <div className="card">
          <div className="ct"><span>{vendorLabel(account)} invoices since {monthLabel(q.data.invoices.since)}</span><span>{money(q.data.invoices.total)}</span></div>
          {q.data.invoices.lines.length ? <div className="tw"><table><caption className="sr-only">{vendorLabel(account)} invoices</caption>
            <thead><tr><th className="nosort l">Date</th><th className="nosort l">Vendor</th><th className="nosort l">Invoice</th><th className="nosort l">Source</th><th className="nosort">GL</th><th className="nosort">Amount</th></tr></thead>
            <tbody>{q.data.invoices.lines.map((l, i) => <tr key={`${l.invoice_number}-${i}`}><td className="l">{l.invoice_date}</td><td className="l nm">{l.vendor_name}</td><td className="l">{l.invoice_number}</td><td className="l neutral">{l.source === 'relay' ? 'Relay' : 'WinTeam'}</td><td>{l.gl_account_number ?? '–'}</td><td>{money(l.amount)}</td></tr>)}</tbody>
          </table></div> : <Empty>No {inSentence(vendorLabel(account))} invoices.</Empty>}
        </div>
        <div className="card">
          <div className="ct"><span>Photos</span></div>
          {!q.data.photos.configured ? <Empty>CompanyCam is not connected.</Empty>
            : !q.data.photos.project_id ? <Empty>No CompanyCam project mapped.</Empty>
              : q.data.photos.error ? <LoadError error={q.data.photos.error} />
                : q.data.photos.items?.length ? <div className="photos">{q.data.photos.items.map((p, i) => <a key={String(p.id ?? i)} href={p.web ?? '#'} target="_blank" rel="noreferrer noopener">
                  <img src={p.thumbnail ?? p.web ?? ''} alt={`Site photo${p.creator_name ? ` by ${p.creator_name}` : ''}`} loading="lazy" /></a>)}</div>
                  : <Empty>No photos.</Empty>}
        </div>
        {site && <div className="card"><div className="ct"><span>Site</span>{site.role !== 'site' && <Badge status="none" label={site.role === 'catch_all' ? 'Catch-all' : 'Non-billed'} />}</div>
          <dl className="dl">
            <dt>Address</dt><dd>{[site.address_line_1, site.city, site.state_province, site.postal_code].filter(Boolean).join(', ') || '–'}</dd>
            <dt>Parent job</dt><dd>{site.parent_job_number ?? '–'}</dd>
            <dt>Delivery</dt><dd>{site.delivery_model === 'subcontracted' ? 'Subcontracted' : site.delivery_model === 'self_perform' ? 'Self-performed' : '–'}</dd>
            <dt>Hours, 13 weeks</dt><dd>{hours(weeks.reduce((a, r) => a + r.hours, 0))}</dd>
          </dl></div>}
      </>}
    </div>
  </VocabContext.Provider>
}
