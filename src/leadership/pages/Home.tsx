import { useMemo } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../../services/apiTypes'
import { dataFlags, rowsOfWeek, segmentOrder, useRows } from '../data'
import { hours1, pct, pts } from '../format'
import { accountSummary, statusOf } from '../metrics'
import { Overview } from '../Overview'
import { addDays, weekLabel } from '../routes'
import { PageHeader, updatedLine } from '../Shell'
import { useLeadership } from '../state'
import { Badge, Empty, LoadError, Skeleton, toneOf, VocabContext } from '../ui'
import { vocabOf, weekChange } from '../vocab'
import { FedexOverview } from './FedexViews'

function StripCard({ account, rows, prior, selected, onSelect, optionsFor }: {
  account: LeadershipAccount; rows: LeadershipRow[]; prior: LeadershipRow[]; selected: boolean; onSelect: () => void; optionsFor: ReturnType<typeof useLeadership>['optionsFor']
}) {
  const options = optionsFor(account)
  const s = rows.length ? accountSummary(rows, options, segmentOrder(account)) : null
  const p = prior.length ? accountSummary(prior, options, segmentOrder(account)) : null
  const measure = s?.account.measurePct ?? null
  const status = statusOf(measure, options.target, options.watchBand)
  const change = measure != null && p?.account.measurePct != null ? measure - p.account.measurePct : null
  if (!s) return <div className="acct acct--none" aria-label={`${account.name}: no sites mapped`}><div className="acct__hdr"><span className="acct__name">{account.name}</span><Badge status="none" label="No sites" /></div></div>
  const vocab = vocabOf(account)
  return <VocabContext.Provider value={vocab}><button type="button" className="acct" aria-pressed={selected} onClick={onSelect}>
    <div className="acct__hdr"><span className="acct__name">{account.name}</span><Badge status={status} /></div>
    <div className="acct__grid">
      <div><div className="kl">Labor %</div><b className={toneOf(status)}>{pct(measure)}</b><small>{weekChange(change, vocab)}</small></div>
      {vocab === 'fedex'
        ? <div><div className="kl">Hrs over</div><b>{hours1(s.headerOverHours)}</b><small>{s.billed.over} sites over</small></div>
        : <div><div className="kl">Hours to cut</div><b>{hours1(s.headerOverHours / 7)}/day</b><small>{s.billed.over} sites over</small></div>}
      <div><div className="kl">OT %</div><b className={s.account.otPct > 0.15 ? 'bad' : s.account.otPct > 0.1 ? 'warn' : ''}>{pct(s.account.otPct)}</b><small>{Math.round(s.account.otHours).toLocaleString('en-US')} hrs</small></div>
    </div>
  </button></VocabContext.Provider>
}

export function Home() {
  const { featured, selectedAccount, weekStart, navigate, optionsFor, config } = useLeadership()
  const rowsQuery = useRows('featured', 2)
  const all = rowsQuery.data?.rows
  const current = useMemo(() => rowsOfWeek(all, weekStart), [all, weekStart])
  const prior = useMemo(() => rowsOfWeek(all, weekStart ? addDays(weekStart, -7) : undefined), [all, weekStart])
  const selectedRows = useMemo(() => current.filter((r) => r.account_slug === selectedAccount?.slug), [current, selectedAccount])
  const options = useMemo(() => optionsFor(selectedAccount), [optionsFor, selectedAccount])
  const summary = useMemo(() => (selectedRows.length && selectedAccount ? accountSummary(selectedRows, options, segmentOrder(selectedAccount)) : null), [selectedRows, selectedAccount, options])
  const flags = useMemo(() => dataFlags(config.data, weekStart, selectedRows), [config.data, weekStart, selectedRows])
  const subtitle = [weekStart ? weekLabel(weekStart) : null, updatedLine(config.data)].filter(Boolean).join('. ')
  if (config.error) return <><PageHeader title="Leadership P&L" /><LoadError error={config.error} onRetry={config.refetch} /></>
  return <>
    <PageHeader title={selectedAccount ? `${selectedAccount.name} Labor P&L` : 'Leadership P&L'} subtitle={subtitle} />
    <h2 className="sr-only">Featured accounts</h2>
    {rowsQuery.error ? <LoadError error={rowsQuery.error} onRetry={rowsQuery.refetch} />
      : !all ? <div className="strip">{featured.map((a) => <Skeleton key={a.slug} height={96} />)}</div>
        : <div className="strip">{featured.map((a) => <StripCard key={a.slug} account={a} optionsFor={optionsFor} selected={a.slug === selectedAccount?.slug}
          rows={current.filter((r) => r.account_slug === a.slug)} prior={prior.filter((r) => r.account_slug === a.slug)}
          onSelect={() => navigate({ account: a.slug }, { replace: true })} />)}</div>}
    <h2 className="sr-only">{selectedAccount?.name} overview</h2>
    {!all ? <Skeleton height={320} />
      : !selectedAccount || !summary ? <Empty>No data for this week.</Empty>
        : <VocabContext.Provider value={vocabOf(selectedAccount)}>{vocabOf(selectedAccount) === 'fedex'
          ? <FedexOverview account={selectedAccount} rows={selectedRows} summary={summary} options={options} />
          : <Overview account={selectedAccount} rows={selectedRows} summary={summary} options={options} flags={flags} />}</VocabContext.Provider>}
    {selectedAccount && summary && <p className="foot"><a href={`#/account/${selectedAccount.slug}${weekStart ? `?week=${addDays(weekStart, 6)}` : ''}`}>All {selectedAccount.name} sites</a></p>}
  </>
}
