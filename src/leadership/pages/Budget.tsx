import { useMemo, useState } from 'react'
import { useApiQuery } from '../../hooks/useApiQuery'
import type { BudgetMonth, BudgetPlanRow, LeadershipAccount, LeadershipBudgetResponse } from '../../services/apiTypes'
import { queryClient, queryKey } from '../../services/queryClient'
import { parseBudget, type BudgetRow, type BudgetWeekRow } from '../budgetParse'
import { money, pct } from '../format'
import { monthLabel } from '../routes'
import { useLeadership } from '../state'
import { Empty, Kpi, LoadError, Skeleton, SortTable, type Column } from '../ui'

const BASIS: Record<NonNullable<BudgetMonth['actual']>['basis'], string> = { job_cost: 'Job cost', pay_report: 'Timekeeping', estimate: 'Timekeeping, part estimated' }
const signedMoney = (n: number) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`
const points = (n: number | null) => (n == null ? '–' : `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(1)} pts`)
const over = (n: number | null | undefined) => (n == null ? '' : n > 0 ? 'bad' : 'ok')
const DAY_LABEL: Record<string, string> = { school_days: 'school', staff_days: 'staff', closure_days: 'closure', summer_days: 'summer', stat_holidays: 'holiday' }
const daysOf = (d: BudgetMonth['details']) => Object.entries(d).filter(([, v]) => v).map(([k, v]) => `${v} ${DAY_LABEL[k] ?? k}`).join(', ')

/** The account's monthly labor plan against actuals: site and overhead labor, events left out (Budget tab). */
export function BudgetTab({ account }: { account: LeadershipAccount }) {
  const { api, keyPrefix, decision } = useLeadership()
  const q = useApiQuery<LeadershipBudgetResponse>(decision ? queryKey(`${keyPrefix}/leadership/budget`, { account: account.slug }) : null,
    (signal) => api.leadershipBudget(account.slug, signal), [api, account.slug])
  if (q.error) return <LoadError error={q.error} onRetry={q.refetch} />
  if (!q.data) return <Skeleton height={320} />
  const months = q.data.months
  if (!months.length) return <Empty>No budget loaded. Admin, Budgets.</Empty>
  // A month still running has its actual to date and no variance; the headline and to-date figures use whole months.
  const withActual = months.filter((m) => m.actual && !m.in_progress)
  const running = months.find((m) => m.in_progress && m.actual)
  const latest = withActual.at(-1)
  const sum = (list: BudgetMonth[], f: (m: BudgetMonth) => number) => list.reduce((t, m) => t + f(m), 0)
  const ytdBudget = sum(withActual, (m) => m.budget.total), ytdActual = sum(withActual, (m) => m.actual!.total)
  const ytdRevenue = sum(withActual, (m) => m.actual!.revenue)
  const ytdBudgetRevenue = sum(withActual, (m) => m.budget.revenue ?? 0)
  const year = { budget: sum(months, (m) => m.budget.total), revenue: sum(months, (m) => m.budget.revenue ?? 0) }
  const cols: Column<BudgetMonth>[] = [
    { key: 'm', header: 'Month', left: true, value: (m) => m.month, render: (m) => monthLabel(m.month) },
    { key: 'days', header: 'Days', left: true, value: (m) => daysOf(m.details), className: 'neutral' },
    { key: 'bs', header: 'Budget site', value: (m) => m.budget.site, render: (m) => money(m.budget.site) },
    { key: 'bo', header: 'Budget overhead', value: (m) => m.budget.overhead, render: (m) => money(m.budget.overhead) },
    { key: 'bt', header: 'Budget', value: (m) => m.budget.total, render: (m) => <b>{money(m.budget.total)}</b> },
    { key: 'bp', header: 'Budget %', value: (m) => m.budget.labor_pct, render: (m) => pct(m.budget.labor_pct) },
    { key: 'as', header: 'Actual site', value: (m) => m.actual?.site ?? null, render: (m) => (m.actual ? money(m.actual.site) : '–') },
    { key: 'ao', header: 'Actual overhead', value: (m) => m.actual?.overhead ?? null, render: (m) => (m.actual ? money(m.actual.overhead) : '–') },
    { key: 'at', header: 'Actual', value: (m) => m.actual?.total ?? null, render: (m) => (m.actual ? <b>{money(m.actual.total)}</b> : '–') },
    { key: 'ap', header: 'Actual %', value: (m) => m.actual?.labor_pct ?? null, render: (m) => (m.actual ? <span className={over(m.variance?.points)}>{pct(m.actual.labor_pct)}</span> : '–') },
    { key: 'v', header: 'Over', value: (m) => m.variance?.total ?? null,
      render: (m) => (m.variance ? <span className={over(m.variance.total)}>{signedMoney(m.variance.total)}{m.variance.pct != null ? ` (${pct(m.variance.pct)})` : ''}</span> : '–') },
    { key: 'pts', header: 'Pts', value: (m) => m.variance?.points ?? null, render: (m) => <span className={over(m.variance?.points)}>{points(m.variance?.points ?? null)}</span> },
    { key: 'ev', header: 'Events', value: (m) => m.actual?.events ?? null, render: (m) => (m.actual?.events ? <span className="neutral">{money(m.actual.events)}</span> : '–') },
    { key: 'b', header: 'Actual from', left: true, value: (m) => (m.actual ? `${m.in_progress ? 'Month to date; ' : ''}${BASIS[m.actual.basis]}` : ''), className: 'neutral' },
  ]
  return <>
    <div className="kpi-lg">
      {latest && <Kpi label={`${monthLabel(latest.month)} actual`} value={money(latest.actual!.total)} tone={over(latest.variance?.total)}
        sub={`${pct(latest.actual!.labor_pct)} of billing; ${BASIS[latest.actual!.basis].toLowerCase()}`} />}
      {latest && <Kpi label={`${monthLabel(latest.month)} budget`} value={money(latest.budget.total)} sub={`${pct(latest.budget.labor_pct)} of billing`} />}
      {latest?.variance && <Kpi label={`${monthLabel(latest.month)} over`} value={signedMoney(latest.variance.total)} tone={over(latest.variance.total)}
        sub={`${points(latest.variance.points)}; site ${signedMoney(latest.variance.site)}, overhead ${signedMoney(latest.variance.overhead)}`} />}
      {withActual.length > 0 && <Kpi label={`To date, ${withActual.length} months`} value={signedMoney(ytdActual - ytdBudget)} tone={over(ytdActual - ytdBudget)}
        sub={`${pct(ytdRevenue ? ytdActual / ytdRevenue : null)} actual, ${pct(ytdBudgetRevenue ? ytdBudget / ytdBudgetRevenue : null)} budget`} />}
      {running && <Kpi label={`${monthLabel(running.month)} to date`} value={money(running.actual!.total)} sub={`Budget for the month ${money(running.budget.total)}`} />}
      <Kpi label="Plan, full year" value={money(year.budget)} sub={`${pct(year.revenue ? year.budget / year.revenue : null)} of ${money(year.revenue)}`} />
    </div>
    <div className="card"><div className="ct"><span>Budget vs actual by month</span><span className="ks">Events left out</span></div>
      <SortTable caption={`${account.name} labor budget by month`} rows={months} columns={cols} defaultSort={{ key: 'm', dir: 1 }} csvName={`${account.slug}-budget`} /></div>
  </>
}

const toPlan = (r: BudgetRow): BudgetPlanRow => ({ month: r.month, site_labor: r.site_labor, overhead_labor: r.overhead_labor, revenue: r.revenue, supplies: r.supplies, details: r.details })

/** Admin > Budgets: paste an account's monthly labor plan from its workbook, check it, save it. */
export function BudgetsAdmin() {
  const { adminApi: api, adminConfig, adminKeyPrefix: keyPrefix, decision } = useLeadership()
  const accounts = adminConfig.data?.accounts ?? []
  const [slug, setSlug] = useState('')
  const account = slug || accounts.find((a) => a.slug === 'plano-isd')?.slug || accounts[0]?.slug || ''
  const [text, setText] = useState('')
  const [sheets, setSheets] = useState<{ file: string; sheets: { name: string; text: string }[] } | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // A pasted table, or every sheet of an uploaded workbook: the monthly plan and the weekly calendar are found by their headers.
  const found = useMemo(() => {
    const sources = sheets ? sheets.sheets : text.trim() ? [{ name: 'Pasted', text }] : []
    return sources.map((x) => ({ name: x.name, parsed: parseBudget(x.text) })).filter((x) => x.parsed.rows.length || x.parsed.weeks.length || !sheets)
  }, [sheets, text])
  const months = found.flatMap((x) => x.parsed.rows)
  const weekRows = found.flatMap((x) => x.parsed.weeks)
  const problems = found.flatMap((x) => x.parsed.errors.map((e) => (sheets ? `${x.name}: ${e}` : e)))
  const skipped = found.flatMap((x) => x.parsed.skipped)
  const readFile = async (file: File | undefined) => {
    if (!file) return
    setMessage(null); setText(''); setSheets(null)
    if (/\.(csv|tsv|txt)$/i.test(file.name)) { setText(await file.text()); return }
    setBusy(true)
    try { setSheets(await api.readBudgetWorkbook(file)) }
    catch (e) { setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) }) }
    finally { setBusy(false) }
  }
  const q = useApiQuery<LeadershipBudgetResponse>(decision && account ? queryKey(`${keyPrefix}/leadership/budget`, { account }) : null,
    (signal) => api.leadershipBudget(account, signal), [api, account])
  const act = async (done: string, fn: () => Promise<unknown>) => {
    setBusy(true); setMessage(null)
    try { await fn(); setMessage({ ok: true, text: done }); queryClient.invalidate(); q.refetch() }
    catch (e) { setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) }) }
    finally { setBusy(false) }
  }
  const name = accounts.find((a) => a.slug === account)?.name ?? account
  const previewCols: Column<BudgetRow>[] = [
    { key: 'm', header: 'Month', left: true, value: (r) => r.month, render: (r) => monthLabel(`${r.month}-01`) },
    { key: 's', header: 'Site labor', value: (r) => r.site_labor, render: (r) => money(r.site_labor) },
    { key: 'o', header: 'Overhead labor', value: (r) => r.overhead_labor, render: (r) => money(r.overhead_labor) },
    { key: 't', header: 'Total', value: (r) => (r.site_labor ?? 0) + (r.overhead_labor ?? 0), render: (r) => <b>{money((r.site_labor ?? 0) + (r.overhead_labor ?? 0))}</b> },
    { key: 'r', header: 'Revenue', value: (r) => r.revenue, render: (r) => money(r.revenue) },
    { key: 'p', header: 'Labor %', value: (r) => (r.revenue ? ((r.site_labor ?? 0) + (r.overhead_labor ?? 0)) / r.revenue : null), render: (r) => pct(r.revenue ? ((r.site_labor ?? 0) + (r.overhead_labor ?? 0)) / r.revenue : null) },
    { key: 'su', header: 'Supplies', value: (r) => r.supplies, render: (r) => money(r.supplies) },
    { key: 'd', header: 'Days', left: true, value: (r) => daysOf(r.details), className: 'neutral' },
  ]
  const weekCols: Column<BudgetWeekRow>[] = [
    { key: 'w', header: 'Week ending', left: true, value: (r) => r.week_end },
    { key: 's', header: 'Site labor', value: (r) => r.site_labor, render: (r) => money(r.site_labor) },
    { key: 'o', header: 'Overhead labor', value: (r) => r.overhead_labor, render: (r) => money(r.overhead_labor) },
    { key: 'h', header: 'Stat holiday labor', value: (r) => r.holiday_labor, render: (r) => (r.holiday_labor ? money(r.holiday_labor) : '–') },
    { key: 't', header: 'Total', value: (r) => r.site_labor + r.overhead_labor, render: (r) => <b>{money(r.site_labor + r.overhead_labor)}</b> },
    { key: 'd', header: 'Days', left: true, value: (r) => daysOf(r.details), className: 'neutral' },
  ]
  const weeks = q.data?.weeks ?? []
  const what = [months.length ? `${months.length} months` : null, weekRows.length ? `${weekRows.length} weeks` : null].filter(Boolean).join(' and ')
  return <>
    <div className="card">
      <div className="ct"><span>Labor budget</span></div>
      <div className="form-grid">
        <label className="field"><span>Account</span><select value={account} onChange={(e) => { setSlug(e.target.value); setText(''); setSheets(null); setMessage(null) }}>
          {accounts.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}</select></label>
      </div>
      <label className="field wide"><span>Budget workbook (.xlsx or .csv)</span>
        <input type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" disabled={busy} onChange={(e) => { void readFile(e.target.files?.[0]); e.target.value = '' }} /></label>
      {sheets && <p className="ks">{sheets.file}: {found.length ? found.map((x) => `${x.name} (${x.parsed.kind === 'weeks' ? `${x.parsed.weeks.length} weeks` : `${x.parsed.rows.length} months`})`).join(', ') : 'no sheet with a Month or Week ending table'}
        {' '}<button type="button" className="linkbtn" onClick={() => setSheets(null)}>Clear</button></p>}
      {!sheets && <label className="field wide"><span>Or paste from Excel</span>
        <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} /></label>}
      {problems.length > 0 && <ul className="msg bad">{problems.map((e) => <li key={e}>{e}</li>)}</ul>}
      {months.length > 0 && <SortTable caption="Monthly budget to save" rows={months} columns={previewCols} defaultSort={{ key: 'm', dir: 1 }} />}
      {weekRows.length > 0 && <SortTable caption="Weekly budget to save" rows={weekRows} columns={weekCols} defaultSort={{ key: 'w', dir: 1 }} pageSize={14} />}
      {(months.length > 0 || weekRows.length > 0) && <div className="ctrl">
        <button type="button" className="btn primary" disabled={busy || problems.length > 0}
          onClick={() => void act(`Saved ${what} for ${name}`, async () => {
            await api.saveBudget(account, { months: months.map(toPlan), weeks: weekRows }); setText(''); setSheets(null) })}>
          Save {what} for {name}</button>
        {skipped.length > 0 && <span className="ks">Skipped: {[...new Set(skipped)].join(', ')}</span>}
      </div>}
      {message && <p className={`msg ${message.ok ? 'ok' : 'bad'}`} role="status">{message.text}</p>}
    </div>
    <div className="card">
      <div className="ct"><span>{name}, saved</span>{(q.data?.months.length ?? 0) > 0 &&
        <button type="button" className="btn sm" disabled={busy} onClick={() => { if (window.confirm(`Clear the whole ${name} budget?`)) void act(`Cleared ${name} budget`, () => api.deleteBudget(account)) }}>Clear all</button>}</div>
      {q.error ? <LoadError error={q.error} onRetry={q.refetch} /> : !q.data ? <Skeleton height={120} /> : !q.data.months.length ? <Empty>No budget saved.</Empty>
        : <div className="tw"><table><caption className="sr-only">Saved budget</caption>
          <thead><tr><th className="nosort">Month</th><th className="nosort">Site labor</th><th className="nosort">Overhead labor</th><th className="nosort">Total</th><th className="nosort">Revenue</th><th className="nosort">Labor %</th><th className="nosort">Days</th><th className="nosort"></th></tr></thead>
          <tbody>{q.data.months.map((m) => <tr key={m.month}><td>{monthLabel(m.month)}</td><td>{money(m.budget.site)}</td><td>{money(m.budget.overhead)}</td><td><b>{money(m.budget.total)}</b></td>
            <td>{money(m.budget.revenue)}</td><td>{pct(m.budget.labor_pct)}</td><td className="neutral">{daysOf(m.details)}</td>
            <td><button type="button" className="linkbtn" disabled={busy} onClick={() => void act(`Removed ${monthLabel(m.month)}`, () => api.deleteBudget(account, m.month.slice(0, 7)))}>Remove</button></td></tr>)}</tbody>
        </table></div>}
    </div>
    <div className="card">
      <div className="ct"><span>{name}, weekly calendar</span>{weeks.length > 0 && <span className="ctrl"><span className="ks">{weeks.length} weeks, {weeks[0].week_end} to {weeks.at(-1)!.week_end}</span>
        <button type="button" className="btn sm" disabled={busy} onClick={() => { if (window.confirm(`Clear the ${name} weekly calendar?`)) void act(`Cleared ${name} weekly calendar`, () => api.deleteBudget(account, undefined, undefined, true)) }}>Clear weeks</button></span>}</div>
      {!weeks.length ? <Empty>No weekly calendar saved.</Empty>
        : <SortTable caption="Saved weekly calendar" rows={weeks.map((x) => ({ week_end: x.week_end, site_labor: x.site, overhead_labor: x.overhead, holiday_labor: x.holiday, details: x.details }))}
          columns={weekCols} defaultSort={{ key: 'w', dir: 1 }} pageSize={14} />}
    </div>
  </>
}
