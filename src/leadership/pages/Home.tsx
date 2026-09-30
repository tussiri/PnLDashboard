import { useMemo } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../../services/apiTypes'
import { dataFlags, daysInMonth, monthFlags, priorMonth, rowsOfWeek, segmentOrder, useMonthRows, useRows } from '../data'
import { hours, hours1, money, moneyK, pct } from '../format'
import { accountSummary, statusOf, type MetricOptions } from '../metrics'
import { Overview } from '../Overview'
import { addDays, monthLabel, weekLabel } from '../routes'
import { PageHeader, updatedLine } from '../Shell'
import { useLeadership } from '../state'
import { Badge, Empty, LoadError, Skeleton, toneOf, VocabContext } from '../ui'
import { invoiceLabel, vocabOf, weekChange, wordsFor } from '../vocab'

/** The chosen account at a glance: labor % against target, then the week's money and hours. */
function AccountSnapshot({ account, rows, prior, options, periodLabel }: {
  account: LeadershipAccount; rows: LeadershipRow[]; prior: LeadershipRow[]; options: MetricOptions; periodLabel: string
}) {
  const period = options.period ?? 'week'
  const { can } = useLeadership()
  const s = rows.length ? accountSummary(rows, options, segmentOrder(account)) : null
  const p = prior.length ? accountSummary(prior, options, segmentOrder(account)) : null
  const vocab = vocabOf(account)
  const w = wordsFor(vocab)
  if (!s) return <div className="snap snap--none"><div className="snap__hdr"><h2 className="snap__name">{account.name}</h2><Badge status="none" label="No sites" /></div></div>
  const a = s.account
  const lp = a.measurePct
  const status = statusOf(lp, options.target, options.watchBand)
  const change = lp != null && p?.account.measurePct != null ? lp - p.account.measurePct : null
  const scale = Math.max(options.target * 1.5, lp ?? 0, 0.01)
  const over = s.headerOverHours
  return <VocabContext.Provider value={vocab}><section className="snap" aria-label={`${account.name} this ${period}`}>
    <div className="snap__top">
      <div className="snap__id">
        <div className="snap__hdr"><h2 className="snap__name">{account.name}</h2><Badge status={status} /></div>
        <div className="snap__meta">{periodLabel}; {s.billed.count} sites, {s.billed.over} over target</div>
      </div>
      <div className="snap__lp">
        <div className="snap__lpv"><span className="kl">Labor %</span><b className={toneOf(status)}>{pct(lp)}</b><span className="ks">{weekChange(change, vocab, period)}</span></div>
        <div className="gauge" role="img" aria-label={`Labor % ${pct(lp)} against a ${pct(options.target)} target`}>
          <span className={`gauge__fill ${toneOf(status)}`} style={{ width: `${Math.min(100, ((lp ?? 0) / scale) * 100)}%` }} />
          <span className="gauge__mark" style={{ left: `${(options.target / scale) * 100}%` }}><small>{pct(options.target)}</small></span>
        </div>
      </div>
    </div>
    <div className="snap__grid">
      <div><span className="kl">{invoiceLabel(w, vocab, period)}</span><b>{money(a.invoice)}</b></div>
      <div><span className="kl">{w.labor}</span><b>{money(a.cost)}</b></div>
      {can('data.allocations') && <div><span className="kl">Margin</span><b className={a.margin < 0 ? 'bad' : ''}>{money(a.margin)}</b><span className="ks">{pct(a.marginPct)}{a.allocation > 0 ? `, after ${moneyK(a.allocation)} alloc.` : ''}</span></div>}
      <div><span className="kl">{w.hoursOver}</span><b className={over > 0 ? 'bad' : 'ok'}>{hours1(over / (options.periodDays ?? 7))}<span className="of">/day</span></b><span className="ks">{hours(over)}h this {period}</span></div>
      <div><span className="kl">OT %</span><b className={a.otPct > 0.15 ? 'bad' : a.otPct > 0.1 ? 'warn' : ''}>{pct(a.otPct)}</b><span className="ks">{hours(a.otHours)} hrs</span></div>
      <div><span className="kl">{w.hours}</span><b>{hours(a.hours)}</b></div>
    </div>
  </section></VocabContext.Provider>
}

export function Home() {
  const { selectedAccount, weekStart, optionsFor, config, monthMode, month } = useLeadership()
  const slug = selectedAccount?.slug
  const weekQuery = useRows(monthMode ? undefined : 'featured', 2)
  const monthQuery = useMonthRows(monthMode ? slug : undefined, monthMode ? month : undefined)
  const priorQuery = useMonthRows(monthMode ? slug : undefined, monthMode && month ? priorMonth(month) : undefined)
  const rowsQuery = monthMode ? monthQuery : weekQuery
  const all = rowsQuery.data?.rows
  const current = useMemo(() => (monthMode ? all ?? [] : rowsOfWeek(all, weekStart)), [monthMode, all, weekStart])
  const prior = useMemo(() => (monthMode ? priorQuery.data?.rows ?? [] : rowsOfWeek(all, weekStart ? addDays(weekStart, -7) : undefined)), [monthMode, priorQuery.data, all, weekStart])
  const selectedRows = useMemo(() => current.filter((r) => r.account_slug === slug), [current, slug])
  const options = useMemo<MetricOptions>(() => (monthMode && month
    ? { ...optionsFor(selectedAccount), revenueMethod: 'weekly_billing', period: 'month', periodDays: daysInMonth(month) }
    : optionsFor(selectedAccount)), [optionsFor, selectedAccount, monthMode, month])
  const summary = useMemo(() => (selectedRows.length && selectedAccount ? accountSummary(selectedRows, options, segmentOrder(selectedAccount)) : null), [selectedRows, selectedAccount, options])
  const flags = useMemo(() => (monthMode && month ? monthFlags(config.data, month, selectedRows) : dataFlags(config.data, weekStart, selectedRows)), [config.data, weekStart, selectedRows, monthMode, month])
  const periodLabel = monthMode && month ? monthLabel(`${month}-01`) : weekStart ? weekLabel(weekStart) : ''
  const subtitle = [periodLabel || null, updatedLine(config.data)].filter(Boolean).join('. ')
  if (config.error) return <><PageHeader title="Leadership P&L" /><LoadError error={config.error} onRetry={config.refetch} /></>
  return <>
    <PageHeader title={selectedAccount ? `${selectedAccount.name} Labor P&L` : 'Leadership P&L'} subtitle={subtitle} period />
    {rowsQuery.error ? <LoadError error={rowsQuery.error} onRetry={rowsQuery.refetch} />
      : !all ? <Skeleton height={150} />
        : selectedAccount && <AccountSnapshot account={selectedAccount} options={options} periodLabel={periodLabel}
          rows={selectedRows} prior={prior.filter((r) => r.account_slug === selectedAccount.slug)} />}
    {!all ? <Skeleton height={320} />
      : !selectedAccount || !summary ? <Empty>No data for this {monthMode ? 'month' : 'week'}.</Empty>
        : <VocabContext.Provider value={vocabOf(selectedAccount)}><Overview account={selectedAccount} rows={selectedRows} summary={summary} options={options} flags={flags} headline={false} /></VocabContext.Provider>}
    {selectedAccount && summary && <p className="foot"><a href={`#/account/${selectedAccount.slug}${monthMode && month ? `?period=month&month=${month}` : weekStart ? `?week=${addDays(weekStart, 6)}` : ''}`}>All {selectedAccount.name} sites</a></p>}
  </>
}
