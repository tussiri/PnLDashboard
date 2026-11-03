import { useEffect } from 'react'
import { useApiQuery } from '../hooks/useApiQuery'
import type { LeadershipAccount, WeekChangeEffects, WeekChangeResponse, WeekChangeSite } from '../services/apiTypes'
import { queryKey } from '../services/queryClient'
import { hours, money, pct } from './format'
import { weekRange } from './routes'
import { useLeadership } from './state'
import { Kpi, SortTable, useVocab, type Column } from './ui'
import { wordsFor } from './vocab'

const signedMoney = (v: number) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`
const signedPct = (v: number | null) => (v == null ? '' : `${v >= 0 ? '+' : '−'}${pct(Math.abs(v))}`)
const signedHours = (v: number) => `${v >= 0 ? '+' : '−'}${hours(Math.abs(v))}`
/** More cost reads bad, less reads good; a change under a dollar is neutral. */
const costTone = (v: number) => (v >= 1 ? 'bad' : v <= -1 ? 'ok' : '')

const EFFECT_LABEL: Record<keyof WeekChangeEffects, string> = { hours: 'Hours', pay_rate: 'Pay rate', ot_premium: 'OT premium', started: 'Sites started', stopped: 'Sites stopped', vendor: 'Subcontractor' }
const EFFECT_SUB: Record<keyof WeekChangeEffects, string> = { hours: 'At the prior base rate', pay_rate: 'Base rate per hour', ot_premium: 'Half time on OT', started: 'No hours prior week', stopped: 'No hours this week', vendor: 'Counted cost' }
const BASIS_LABEL: Record<string, string> = { pay_report: 'pay report', payroll_rate: 'WinTeam rates', trailing_rate_estimate: 'job cost rate' }
const transition = (name: string) => name.split(' to ').map((b) => BASIS_LABEL[b] ?? b).join(' to ')
const TONE_CLASS = { increase: 'bad', decrease: 'ok', data: 'warn' } as const

/** Why the account's labor moved from the prior week: effects that add up to the change, the AI reading of them, and the sites behind it. */
export function WeekChangeCard({ account, weekStart }: { account: LeadershipAccount; weekStart: string }) {
  const { api, keyPrefix, decision, navigate } = useLeadership()
  const words = wordsFor(useVocab())
  const q = useApiQuery<WeekChangeResponse>(decision ? queryKey(`${keyPrefix}/leadership/week-change`, { account: account.slug, week: weekStart }) : null,
    (signal) => api.leadershipWeekChange(account.slug, weekStart, signal), [api, account.slug, weekStart])
  const pending = q.data?.summary.status === 'pending'
  useEffect(() => {
    if (!pending) return
    const t = window.setTimeout(() => q.refetch(), 15_000)
    return () => window.clearTimeout(t)
  }, [pending, q])
  const d = q.data
  if (q.error || !d || !d.prior.cost || !d.current.cost) return null
  const effects = (Object.keys(EFFECT_LABEL) as (keyof WeekChangeEffects)[]).filter((k) => Math.abs(d.effects[k]) >= 1)
  const s = d.summary.summary
  const cols: Column<WeekChangeSite>[] = [
    { key: 'site', header: 'Site', left: true, value: (r) => r.site_name ?? r.job_number, className: 'nm' },
    { key: 'prior', header: 'Prior wk', value: (r) => r.prior, render: (r) => money(r.prior) },
    { key: 'cur', header: 'This wk', value: (r) => r.current, render: (r) => money(r.current) },
    { key: 'chg', header: 'Change', value: (r) => r.change, render: (r) => <span className={costTone(r.change)}>{signedMoney(r.change)}</span> },
    { key: 'hrs', header: 'Hours', value: (r) => r.effects.hours + r.effects.started + r.effects.stopped, render: (r) => signedMoney(r.effects.hours + r.effects.started + r.effects.stopped) },
    { key: 'rate', header: 'Pay rate', value: (r) => r.effects.pay_rate, render: (r) => signedMoney(r.effects.pay_rate) },
    { key: 'ot', header: 'OT premium', value: (r) => r.effects.ot_premium, render: (r) => signedMoney(r.effects.ot_premium) },
    { key: 'dh', header: 'Hours chg', value: (r) => r.hours_current - r.hours_prior, render: (r) => signedHours(r.hours_current - r.hours_prior) },
    { key: 'dot', header: 'OT hrs chg', value: (r) => r.ot_hours_current - r.ot_hours_prior, render: (r) => signedHours(r.ot_hours_current - r.ot_hours_prior) },
    { key: 'emp', header: 'Staff', value: (r) => r.employees_current, render: (r) => `${r.employees_prior} to ${r.employees_current}` },
  ]
  return <div className="card wkchg">
    <div className="ct"><span>{words.labor} change, {weekRange(d.week)} vs {weekRange(d.prior_week)}</span>
      <span className={costTone(d.change)}>{signedMoney(d.change)} ({signedPct(d.change_pct)})</span></div>
    {!d.complete && <p className="ks warn">Week in progress: part of this week against all of the last</p>}
    <div className="kpi-lg wkchg__fx">{effects.map((k) => <Kpi small key={k} label={EFFECT_LABEL[k]} value={signedMoney(d.effects[k])} tone={costTone(d.effects[k])} sub={EFFECT_SUB[k]} />)}</div>
    <dl className="wkchg__facts">
      <div><dt>Prior weeks</dt><dd>{d.average_prior != null ? <>{BASE_LABEL(d.recent.length)} average {money(d.average_prior)}; this week {signedPct(d.vs_average_pct)}, prior week {signedPct(d.prior_vs_average_pct)}</> : '–'}</dd></div>
      <div><dt>Hours</dt><dd>{hours(d.prior.hours)} to {hours(d.current.hours)}; OT {hours(d.prior.ot_hours)} to {hours(d.current.ot_hours)}</dd></div>
      {(d.holidays.current.length > 0 || d.holidays.prior.length > 0) && <div><dt>Holidays</dt><dd>{d.holidays.current.length ? `This week: ${d.holidays.current.join(', ')}` : ''}{d.holidays.current.length && d.holidays.prior.length ? '; ' : ''}{d.holidays.prior.length ? `Prior week: ${d.holidays.prior.join(', ')}` : ''}</dd></div>}
      {d.source_changes.sites > 0 && <div><dt className="warn">Labor source changed</dt><dd>{d.source_changes.sites} site{d.source_changes.sites === 1 ? '' : 's'}, {signedMoney(d.source_changes.change)} of the change; {Object.entries(d.source_changes.transitions).map(([k, n]) => `${n} ${transition(k)}`).join(', ')}</dd></div>}
    </dl>
    {s && <div className="wkchg__ai">
      <div className="fbt__hd"><span className="kl">AI summary of these figures</span></div>
      <p className="fbt__line">{s.headline}</p>
      {s.drivers.length > 0 && <ul className="wkchg__drivers">{s.drivers.map((x) => <li key={x.title}><b className={TONE_CLASS[x.tone]}>{x.title}</b> {x.detail}</li>)}</ul>}
      {s.check_next.length > 0 && <div className="wkchg__next"><span className="kl">Worth checking</span><ul>{s.check_next.map((x) => <li key={x}>{x}</li>)}</ul></div>}
    </div>}
    {!s && d.summary.status === 'pending' && <div className="fbt__sent"><span className="kl">AI summary updating</span></div>}
    {d.sites.length > 0 && <SortTable caption={`Largest site changes, ${d.sites.length} of ${d.site_count}`} rows={d.sites} columns={cols} defaultSort={{ key: 'chg', dir: -1 }} pageSize={8}
      onRowClick={(r) => r.company && navigate({ site: { company: r.company, job: r.job_number } })} rowLabel={(r) => `Open ${r.site_name ?? r.job_number}`} csvName={`${account.slug}-week-change`} />}
  </div>
}

const BASE_LABEL = (recent: number) => `${Math.min(4, Math.max(recent - 1, 1))}-week`
