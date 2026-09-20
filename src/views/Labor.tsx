import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { QueryCard } from '../components/CardState'
import { ChartTooltip, gridProps, monthTick, series, xAxisProps, yAxisProps } from '../components/ChartKit'
import { DataGrid, type Column } from '../components/DataGrid'
import { useDashboard } from '../context/DashboardContext'
import type { LaborJob, LaborPace, LaborSummary, OvertimeEmployee, PaceRow } from '../services/apiTypes'
import { monthLabel } from '../services/period'
import { money, moneyFull, number, percent, signed } from '../utils'
import { DemoNotice, Note, rangeSubtitle, ScopeLine, useReportingParams, useReportQuery } from './shared'

const methodLabel: Record<PaceRow['projection_method'], string> = { day_of_week_weighted: 'Day-of-week weighted', calendar_proration: 'Calendar proration', none: 'No projection' }

function PaceHero({ pace, row }: { pace: LaborPace; row: PaceRow }) {
  const methodNote = pace.method_notes?.[row.projection_method]
  const progress = pace.days_in_month ? (pace.days_elapsed / pace.days_in_month) * 100 : 0
  const over = row.pct_over !== null && row.pct_over > 0
  const verdict = row.budget === null ? null : row.pct_over === null ? null : row.pct_over > 3 ? 'bad' : row.pct_over > 0 ? 'watch' : 'ok'
  const vsPrior = row.prior_month_labor ? ((row.projected_labor - row.prior_month_labor) / row.prior_month_labor) * 100 : null
  return <section className="pace-hero" aria-label="Month-end labor pace">
    <div className="pace-hero__top">
      <div><span className="eyebrow">Month-end labor pace · {row.scope === 'portfolio' ? 'portfolio' : row.name}</span><strong>{monthLabel(pace.month, 'long')}</strong><small>As of {pace.as_of} · day {pace.days_elapsed} of {pace.days_in_month} · {row.jobs_with_labor} sites with labor, {row.jobs_with_budget} with budget</small></div>
      {verdict && <b className={`labor-verdict labor-verdict--${verdict}`}>{over ? `${percent(row.pct_over)} over budget at month end` : `${percent(Math.abs(row.pct_over ?? 0))} under budget at month end`}</b>}
      {!verdict && <b className="labor-verdict labor-verdict--muted">No budget to pace against</b>}
    </div>
    <div className="pace-hero__progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /><em style={{ left: `${progress}%` }}>{Math.round(progress)}% of month</em></div>
    <div className="pace-hero__kpis">
      <div><span>Labor to date</span><strong className="num">{money(row.labor_to_date)}</strong><small>{number(row.hours_to_date)} hours</small></div>
      <div><span>Projected month end</span><strong className="num">{money(row.projected_labor)}</strong><small>{methodLabel[row.projection_method]}{row.projection_method === 'day_of_week_weighted' ? ` · calendar ${money(row.projected_calendar)}` : ''}</small></div>
      <div><span>Budget</span><strong className="num">{row.budget === null ? '—' : money(row.budget)}</strong><small>{row.budget_to_date === null ? 'No labor budget' : `${money(row.budget_to_date)} expected to date`}</small></div>
      <div><span>Projected variance</span><strong className={`num ${row.projected_variance === null ? '' : row.projected_variance > 0 ? 'text-bad' : 'text-good'}`}>{row.projected_variance === null ? '—' : signed(row.projected_variance, (v) => money(v))}</strong><small>{row.pct_over === null ? 'n/a' : `${signed(row.pct_over, (v) => percent(v))} of budget`}</small></div>
      <div><span>Measured range</span><strong className="num">{row.range_lo !== null && row.range_hi !== null ? `${money(row.range_lo, 2)}–${money(row.range_hi, 2)}` : '—'}</strong><small>{row.range_n ? `from ${row.range_n} prior month-end errors` : 'Not enough closed months'}</small></div>
      <div><span>Prior month</span><strong className="num">{money(row.prior_month_labor)}</strong><small>{vsPrior === null ? '—' : `${signed(vsPrior, (v) => percent(v))} projected vs prior`}</small></div>
    </div>
    {(methodNote || pace.method_notes?.range || pace.method_notes?.labor_cost_basis) && <p className="pace-hero__method">{methodNote && <span><b>{methodLabel[row.projection_method]}:</b> {methodNote}</span>}{pace.method_notes?.range && <span><b>Range:</b> {pace.method_notes.range}</span>}{pace.method_notes?.labor_cost_basis && <span><b>Labor cost basis:</b> {pace.method_notes.labor_cost_basis}</span>}</p>}
  </section>
}

export function Labor() {
  const { query, params } = useReportingParams()
  const { filters, openJob, dimensions } = useDashboard()
  const [account, setAccount] = useState('')
  const scoped = useMemo(() => ({ ...query, account: account || query.account }), [query, account])
  const scopedParams = { ...params, account: account || params.account }
  const labor = useReportQuery<LaborSummary>('labor/summary', (api, signal) => api.laborSummary(scoped, signal), scopedParams)
  // Pace is about the month in progress: default to the latest mart month (not the closed anchor)
  // unless the user picked a month explicitly.
  const paceMonth = filters.month ?? dimensions?.latest_month ?? undefined
  const paceQuery = useMemo(() => ({ month: paceMonth, account: account || filters.account || undefined }), [paceMonth, filters.account, account])
  const pace = useReportQuery<LaborPace>('labor/pace', (api, signal) => api.laborPace(paceQuery, signal), paceQuery as Record<string, unknown>)
  const k = labor.data?.kpis
  const accounts = useMemo(() => [...(labor.data?.by_account ?? [])].sort((a, b) => b.labor_cost - a.labor_cost), [labor.data])
  const allAccounts = useMemo(() => (account ? accounts.filter((a) => a.parent_account === account) : accounts), [accounts, account])
  const paceRow = pace.data?.rows.find((r) => (account ? r.scope !== 'portfolio' && r.name === account : r.scope === 'portfolio')) ?? pace.data?.rows[0]
  const target = k?.target_labor_pct ?? null
  const laborPct = k?.labor_pct_revenue ?? null
  const verdict = laborPct === null || target === null ? 'muted' : laborPct > target + 3 ? 'bad' : laborPct > target ? 'watch' : 'ok'
  const trackMax = Math.max(laborPct ?? 0, target ?? 0) * 1.15 || 1
  const overBudget = useMemo(() => (labor.data?.by_job ?? []).filter((j) => (j.labor_variance ?? 0) > 0).sort((a, b) => (b.labor_variance ?? 0) - (a.labor_variance ?? 0)), [labor.data])
  const employeeColumns: Column<OvertimeEmployee>[] = [
    { key: 'employee_source_id', header: 'Employee (source id)', render: (r) => <strong className="num">{r.employee_source_id}</strong> },
    { key: 'hours', header: 'Hours', numeric: true, render: (r) => number(r.hours) },
    { key: 'overtime_hours', header: 'OT hours', numeric: true, render: (r) => number(r.overtime_hours) },
    { key: 'ot_pct', header: 'OT %', numeric: true, value: (r) => (r.hours ? (r.overtime_hours / r.hours) * 100 : null), className: (r) => ((r.hours ? (r.overtime_hours / r.hours) * 100 : 0) > 15 ? 'text-bad' : undefined), render: (r) => percent(r.hours ? (r.overtime_hours / r.hours) * 100 : null) },
    { key: 'jobs', header: 'Sites', numeric: true },
  ]
  const accountColumns: Column<LaborSummary['by_account'][number]>[] = [
    { key: 'parent_account', header: 'Account', render: (r) => <strong>{r.parent_account}</strong> },
    { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => moneyFull(r.revenue) },
    { key: 'labor_cost', header: 'Labor', numeric: true, render: (r) => moneyFull(r.labor_cost) },
    { key: 'budget_labor', header: 'Budget', numeric: true, render: (r) => moneyFull(r.budget_labor) },
    { key: 'variance', header: 'Variance', numeric: true, value: (r) => (r.budget_labor === null ? null : r.labor_cost - r.budget_labor), className: (r) => (r.budget_labor === null ? undefined : r.labor_cost > r.budget_labor ? 'text-bad' : 'text-good'), render: (r) => (r.budget_labor === null ? '—' : signed(r.labor_cost - r.budget_labor, (v) => money(v))) },
    { key: 'labor_pct_revenue', header: 'Labor %', numeric: true, className: (r) => (target !== null && (r.labor_pct_revenue ?? 0) > target ? 'text-bad' : 'text-good'), render: (r) => percent(r.labor_pct_revenue) },
    { key: 'hours', header: 'Hours', numeric: true, render: (r) => number(r.hours) },
    { key: 'overtime_hours', header: 'OT hours', numeric: true, render: (r) => number(r.overtime_hours) },
  ]
  return <div className="labor-reference-view">
    <ScopeLine />
    <DemoNotice>Pace uses a seeded partial September 2026; history is seeded site-month data.</DemoNotice>
    <label className="account-select"><span>Account</span><select value={account} onChange={(e) => setAccount(e.target.value)}><option value="">All accounts</option>{accounts.map((row) => <option key={row.parent_account} value={row.parent_account}>{row.parent_account}</option>)}</select></label>
    <div className="account-tabs" role="tablist" aria-label="Labor account view"><button role="tab" aria-selected={!account} className={!account ? 'active' : ''} onClick={() => setAccount('')}>All accounts</button>{accounts.map((row) => <button role="tab" aria-selected={account === row.parent_account} key={row.parent_account} className={account === row.parent_account ? 'active' : ''} onClick={() => setAccount(row.parent_account)}>{row.parent_account}</button>)}</div>
    <QueryCard title="Month-end labor pace" subtitle="Month in progress · projection, not a forecast" query={pace} skeleton="kpi" className="chart-card--flush" isEmpty={(p) => !p.rows.length || !paceRow} emptyHint="No labor recorded yet for this month and scope.">{(p) => (paceRow ? <PaceHero pace={p} row={paceRow} /> : null)}</QueryCard>
    <section className="labor-combo">
      <div className="labor-combo__top"><div><strong>{account || 'All accounts'}</strong><span>{rangeSubtitle(labor.data?.range, `target ${target !== null ? percent(target) : '—'} of revenue`)}</span></div>{laborPct !== null && target !== null && <b className={`labor-verdict labor-verdict--${verdict}`}>{laborPct <= target ? `${percent(target - laborPct)} under target` : `${percent(laborPct - target)} over target`}</b>}</div>
      <div className="labor-combo__kpis">
        <div><span>Total labor</span><strong className="num">{money(k?.labor_cost)}</strong><small className={k?.labor_variance === null || k?.labor_variance === undefined ? '' : k.labor_variance > 0 ? 'text-bad' : 'text-good'}>{k?.labor_variance === null || k?.labor_variance === undefined ? 'No budget in range' : `${signed(k.labor_variance, (v) => money(v))} vs budget`}</small></div>
        <div><span>Revenue</span><strong className="num">{money(k?.revenue)}</strong><small>{k?.revenue_per_hour ? `${money(k.revenue_per_hour, 0)} / hour` : ''}</small></div>
        <div><span>Labor %</span><strong className={`num ${verdict === 'ok' ? 'text-good' : verdict === 'muted' ? '' : 'text-bad'}`}>{percent(laborPct)}</strong><small>{verdict === 'ok' ? 'On track' : verdict === 'watch' ? 'Watch' : verdict === 'bad' ? 'High' : '—'}</small></div>
        <div><span>Target</span><strong className="num">{percent(target)}</strong><small>≤ is favorable</small></div>
        <div><span>OT cost estimate</span><strong className="num">{money(k?.overtime_cost_estimate)}</strong><small>{number(k?.overtime_hours)} OT hours · {percent(k?.overtime_pct)}</small></div>
      </div>
      <div className="labor-target-track" aria-hidden="true"><i style={{ width: `${Math.min(100, ((laborPct ?? 0) / trackMax) * 100)}%` }} className={verdict === 'ok' ? 'is-good' : 'is-bad'} /><em style={{ left: `${Math.min(100, ((target ?? 0) / trackMax) * 100)}%` }} /></div>
      {labor.data?.definitions && <p className="labor-definitions">{Object.entries(labor.data.definitions).map(([k, v]) => <span key={k}><b>{k.replace(/_/g, ' ')}:</b> {v}</span>)}</p>}
      {pace.data?.method_notes?.labor_cost_basis && <Note>Labor cost basis (month in progress): {pace.data.method_notes.labor_cost_basis}</Note>}
    </section>
    <div className="dashboard-grid">
      <QueryCard title="Labor % of revenue" subtitle={`${account || 'Portfolio'} · trailing 12 months · target as dashed reference`} className="span-8" query={labor} isEmpty={(l) => !l.monthly.some((m) => m.revenue)}>{(l) => <ResponsiveContainer width="100%" height="100%"><LineChart data={l.monthly.map((m) => ({ ...m, target }))} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}><CartesianGrid {...gridProps} /><XAxis dataKey="month" tickFormatter={monthTick} {...xAxisProps} /><YAxis domain={['dataMin - 4', 'dataMax + 4']} tickFormatter={(v) => `${Math.round(v)}%`} {...yAxisProps} width={40} /><Tooltip content={<ChartTooltip formatter={(v, n) => [percent(Number(v)), n]} />} />{target !== null && <ReferenceLine y={target} stroke="var(--text)" strokeDasharray="5 4" label={{ value: `Target ${percent(target)}`, position: 'insideBottomRight', fill: 'var(--muted)', fontSize: 10 }} />}<Line dataKey="labor_pct_revenue" name="Labor %" stroke={series.primary} strokeWidth={2.5} dot={{ r: 2 }} activeDot={{ r: 4 }} isAnimationActive={false} /></LineChart></ResponsiveContainer>}</QueryCard>
      <QueryCard title="Overtime hours" subtitle={`${account || 'Portfolio'} · trailing 12 months`} className="span-4" query={labor} isEmpty={(l) => !l.monthly.length}>{(l) => <ResponsiveContainer width="100%" height="100%"><BarChart data={l.monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid {...gridProps} /><XAxis dataKey="month" tickFormatter={monthTick} {...xAxisProps} tick={{ fill: 'var(--muted)', fontSize: 9 }} /><YAxis tickFormatter={(v) => number(v)} {...yAxisProps} width={44} /><Tooltip content={<ChartTooltip formatter={(v, n) => [`${number(Number(v))} h`, n]} />} cursor={{ fill: 'var(--surface-2)' }} /><Bar dataKey="overtime_hours" name="OT hours" fill={series.bad} fillOpacity={0.8} radius={[3, 3, 0, 0]} isAnimationActive={false} /></BarChart></ResponsiveContainer>}</QueryCard>
    </div>
    {pace.data && !account && pace.data.rows.length > 1 && <QueryCard title="Pace by account" subtitle={`${monthLabel(pace.data.month)} · projected month-end labor vs budget`} query={pace} skeleton="table" isEmpty={(p) => p.rows.length <= 1}>{(p) => <DataGrid rows={p.rows.filter((r) => r.scope === 'account')} columns={[{ key: 'name', header: 'Account', render: (r: PaceRow) => <strong>{r.name}</strong> }, { key: 'labor_to_date', header: 'To date', numeric: true, render: (r: PaceRow) => money(r.labor_to_date) }, { key: 'projected_labor', header: 'Projected', numeric: true, render: (r: PaceRow) => money(r.projected_labor) }, { key: 'budget', header: 'Budget', numeric: true, render: (r: PaceRow) => money(r.budget) }, { key: 'pct_over', header: 'Projected variance', numeric: true, className: (r: PaceRow) => (r.pct_over === null ? undefined : r.pct_over > 0 ? 'text-bad' : 'text-good'), render: (r: PaceRow) => (r.pct_over === null ? 'No budget' : `${signed(r.projected_variance, (v) => money(v))} · ${signed(r.pct_over, (v) => percent(v))}`) }, { key: 'prior_month_labor', header: 'Prior month', numeric: true, render: (r: PaceRow) => money(r.prior_month_labor) }, { key: 'projection_method', header: 'Method', render: (r: PaceRow) => methodLabel[r.projection_method] }]} rowKey={(r) => r.name} defaultSort={{ key: 'pct_over', dir: 'desc' }} onRowClick={(r) => setAccount(r.name)} csvName="labor-pace-by-account" dense />}</QueryCard>}
    <QueryCard title="Account summary" subtitle={rangeSubtitle(labor.data?.range)} query={labor} skeleton="table" isEmpty={() => !allAccounts.length}>{() => <DataGrid rows={allAccounts} columns={accountColumns} rowKey={(r) => r.parent_account} defaultSort={{ key: 'labor_cost', dir: 'desc' }} onRowClick={(r) => setAccount(r.parent_account)} csvName="labor-by-account" dense />}</QueryCard>
    <div className="dashboard-grid">
      <QueryCard title="Sites over labor budget" subtitle={`${overBudget.length} sites · worked hours and overtime vs scheduled allowance`} className="span-7" query={labor} isEmpty={() => !overBudget.length} emptyTitle="No site is over its labor budget" emptyHint="Sites without a budget are not evaluated.">{() => <div className="hours-cut-list"><div className="hours-cut-legend"><span><i className="worked" />Regular hours</span><span><i className="overtime" />Overtime hours</span><span><i className="allowance" />Scheduled allowance</span></div>{overBudget.slice(0, 10).map((site: LaborJob) => { const max = Math.max(site.hours, site.scheduled_hours) * 1.12 || 1, regular = Math.max(0, site.hours - site.overtime_hours), overHours = Math.max(0, site.hours - site.scheduled_hours); return <button type="button" key={site.job_number} className="hours-cut-row" onClick={() => openJob(site.job_number)}><div><strong>{site.job_name}</strong><span>{site.parent_account} · {signed(site.labor_variance, (v) => money(v))} over budget</span><b className={overHours > 0 ? 'text-bad' : 'text-good'}>{overHours > 0 ? `${number(overHours)} h to cut` : 'Within allowance'}</b></div><div className="hours-cut-track"><i className="worked" style={{ width: `${(regular / max) * 100}%` }} /><i className="overtime" style={{ width: `${(site.overtime_hours / max) * 100}%` }} /><em style={{ left: `${(site.scheduled_hours / max) * 100}%` }} /></div><small>{number(site.hours)} h worked · {number(site.scheduled_hours)} h scheduled · {number(site.overtime_hours)} h OT ({percent(site.overtime_pct)})</small></button> })}</div>}</QueryCard>
      <QueryCard title="Top overtime employees" subtitle={rangeSubtitle(labor.data?.range, 'source employee ids')} className="span-5" query={labor} skeleton="table" isEmpty={(l) => !l.overtime_employees.length} emptyHint="No overtime recorded in this range." note={<Note>Overtime derivation follows the `overtime_rule` setting (see Data dictionary).</Note>}>{(l) => <DataGrid rows={l.overtime_employees} columns={employeeColumns} rowKey={(r) => r.employee_source_id} defaultSort={{ key: 'overtime_hours', dir: 'desc' }} csvName="overtime-employees" dense maxHeight={360} />}</QueryCard>
    </div>
  </div>
}
