import { useMemo, useState } from 'react'
import type { LeadershipAccount, LeadershipFeedbackResponse, LeadershipRow, StaffingSitesResponse } from '../../services/apiTypes'
import { useApiQuery } from '../../hooks/useApiQuery'
import { queryKey } from '../../services/queryClient'
import { SiteCharts } from '../AmazonCharts'
import { scoreTone, stars } from './Feedback'
import { closedMonths, includesVendor, inRegion, monthLaborPct, regionOf, siteMonths, subregionOf, useMonthly, vendorLabel } from '../data'
import { hours1, money, pct } from '../format'
import { accountSummary, statusOf, type AccountSummary, type MetricOptions, type SiteMetrics } from '../metrics'
import { directOf, palletOf, variableWk } from '../Overview'
import { monthShort } from '../routes'
import { useLeadership } from '../state'
import { Badge, Pills, SortTable, toneOf, useVocab, type Column } from '../ui'
import { wordsFor } from '../vocab'

type Row = SiteMetrics<LeadershipRow>

type HrSite = StaffingSitesResponse['sites'][number]
/**
 * filled: the tracker's filled count, else people (HR's rule: "people working ÷ positions" where the tracker
 * has no Filled). people: HR's headcount, else people who worked here this week per PnL's timekeeping.
 */
interface Staffed { positions: number | null; filled: number | null; people: number | null; peopleFrom: 'hr' | 'timekeeping' | null; open: number | null; headcount: number | null; hires: number; separations: number; source: string | null; asOf: string | null }

const POSITIONS_SOURCE: Record<string, string> = { tracker: 'staffing tracker', budget: 'estimated from budget', observed: 'estimated from roster' }
const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** Self-performed on the mart's rule (common.delivery_sql): no delivery model and hours counts as self-performed. */
export const selfPerformed = (r: LeadershipRow) => r.delivery_model === 'self_perform' || (r.delivery_model == null && r.hours > 0)

/** HR figures for a site row, summed over its rolled-in jobs, with PnL's people-who-worked count where HR
 * has no headcount; null when there is nothing for any of them. */
export function staffedOf(r: Row, hr: Map<string, HrSite>): Staffed | null {
  const found = (r.kids?.length ? r.kids : [r.job_number]).map((j) => hr.get(`${r.company}|${j}`))
    .filter((x): x is HrSite => x != null && (x.week_start != null || x.state_week != null || x.people_worked != null))
  if (!found.length) return null
  const add = (f: (x: HrSite) => number | null | undefined) => (found.some((x) => f(x) != null) ? found.reduce((a, x) => a + (f(x) ?? 0), 0) : null)
  const states = found.map((x) => x.state_week).filter((w): w is string => !!w).sort()
  const headcount = add((x) => x.active_headcount)
  const worked = add((x) => x.people_worked)
  const people = headcount ?? worked
  const tracker = add((x) => x.filled_positions)
  return { positions: add((x) => x.budgeted_positions), filled: tracker ?? people, people, peopleFrom: headcount != null ? 'hr' : worked != null ? 'timekeeping' : null,
    open: add((x) => x.open_positions), headcount,
    hires: add((x) => x.hires) ?? 0, separations: add((x) => x.separations) ?? 0, source: found.map((x) => x.positions_source).find(Boolean) ?? null, asOf: states[0] ?? null }
}

const fillOf = (s: Staffed | null) => (s?.filled != null && s.positions ? s.filled / s.positions : null)

export const roleBadge = (r: Row) => (r.role === 'catch_all' ? <Badge status="none" label="Catch-all" /> : r.role === 'non_billed' ? <Badge status="none" label="Non-billed" /> : <Badge status={r.status} />)

/**
 * Every account's site table. Columns that depend on data appear only where the account has it:
 * fixed / variable invoice (a Job Cost Analysis revenue split), pallet labor (rolled-in pallet jobs),
 * the vendor column (accounts whose labor % counts agency or subcontractor cost). Prior closed months'
 * labor % come from job cost (sub counted at the account's factor), else the row's prior month.
 */
export function Sites({ account, summary, options, selfOnly, ratings }: { account: LeadershipAccount; summary: AccountSummary<LeadershipRow>; options: MetricOptions; selfOnly: boolean
  /** Customer feedback by site over 12 months (Feedback tab data), when the account has any. */
  ratings?: LeadershipFeedbackResponse['by_site'] }) {
  const { navigate, can, route, weekStart, monthMode, api, keyPrefix, decision } = useLeadership()
  const staffing = useApiQuery<StaffingSitesResponse>(decision && can('tab.sites') ? queryKey(`${keyPrefix}/staffing/sites`, { account: account.slug, week: weekStart }) : null,
    (signal) => api.staffingSites(account.slug, { week: weekStart }, signal), [api, account.slug, weekStart])
  const charts = account.vocabulary === 'amazon' && !monthMode
  const w = wordsFor(useVocab())
  const [filter, setFilter] = useState('All')
  const monthly = useMonthly(account.slug)
  const factor = options.vendorFactor ?? 1
  const closed = closedMonths(monthly.data).slice(-2)
  const hasCatch = summary.sites.some((r) => r.role === 'catch_all')
  const hasNb = summary.sites.some((r) => r.role === 'non_billed')
  const groups = ['All', ...summary.segments.map((s) => s.segment), ...(hasCatch ? ['Catch-all'] : []), ...(hasNb ? ['Non-billed'] : [])]
  // Region filter (carried from the Portfolio in the URL); a region none of this account's sites is in is ignored.
  const regions = [...new Set(summary.sites.map(regionOf))].sort()
  const hasRegions = regions.length > 1 || summary.sites.some((r) => r.region)
  const region = route.region && regions.includes(route.region) ? route.region : undefined
  const subregions = region ? [...new Set(summary.sites.filter((r) => regionOf(r) === region).map(subregionOf))].sort() : []
  const subregion = route.subregion && subregions.includes(route.subregion) ? route.subregion : undefined
  const setRegion = (next: { region?: string; subregion?: string }) => navigate(next, { replace: true })
  const rows = summary.sites.filter((r) => inRegion(r, region, subregion)).filter((r) => filter === 'All' || (filter === 'Catch-all' ? r.role === 'catch_all' : filter === 'Non-billed' ? r.role === 'non_billed' : r.segment === filter && r.role === 'site'))
  const hasVariable = summary.sites.some((r) => variableWk(r, options) != null)
  const hasPallet = summary.sites.some((r) => palletOf(r) > 0 || (r.kids?.length ?? 1) > 1)
  const vendor = includesVendor(account) && !selfOnly
  const allocated = can('data.allocations') && summary.sites.some((r) => r.allocation > 0)
  const fixed = (r: Row) => r.invoice - (variableWk(r, options) ?? 0)
  const budget = (r: Row) => (r.invoice > 0 ? r.invoice * r.target : null)
  const variance = (r: Row) => (r.invoice > 0 ? r.cost - r.invoice * r.target : null)
  const lpOf = (r: Row, m: string) => (monthly.data ? monthLaborPct(siteMonths(monthly.data.jobs, r.company, r.kids, r.job_number), m, factor) : null)
  const priorMonth = rows.find((r) => r.revenue_month)?.revenue_month ?? null

  const ratingOf = useMemo(() => {
    const m = new Map<string, { average: number | null; ratings: number }>()
    for (const s of ratings ?? []) if (s.company && s.job_number) m.set(`${s.company}|${s.job_number}`, s)
    return (r: Row) => m.get(`${r.company}|${r.job_number}`)
  }, [ratings])
  const hrSites = useMemo(() => new Map((staffing.data?.sites ?? []).map((x) => [`${x.company}|${x.job_number}`, x])), [staffing.data])
  const hrShown = Boolean(staffing.data?.configured) && summary.sites.some((r) => r.role === 'site' && selfPerformed(r))
  const staffedRow = (r: Row) => (r.role === 'site' && selfPerformed(r) ? staffedOf(r, hrSites) : null)
  const staffedTip = (s: Staffed) => [s.positions == null && 'No positions figure in HR',
    s.people != null && `${s.people} ${s.peopleFrom === 'timekeeping' ? 'worked here this week' : 'on the HR roster'}`, `Hires ${s.hires}`, `Separations ${s.separations}`,
    s.source && `Positions: ${POSITIONS_SOURCE[s.source] ?? s.source}`, s.asOf && `As of ${shortDate(s.asOf)}`].filter(Boolean).join(' · ')
  const staffedCell = (r: Row) => {
    if (r.role !== 'site' || !selfPerformed(r)) return ''
    const s = staffedRow(r)
    if (!s || (s.positions == null && s.filled == null)) return <span className="warn" title={s ? staffedTip(s) : 'No HR staffing for this job'}>–</span>
    if (s.positions == null) return <span title={staffedTip(s)}>{s.filled}</span>
    const fill = fillOf(s)
    return <span className={fill == null ? '' : fill < 0.9 ? 'warn' : ''} title={staffedTip(s)}>{s.filled ?? '–'} / {s.positions}</span>
  }
  const cols: Column<Row>[] = [
    { key: 'job', header: 'Job', left: true, value: (r) => Number(r.job_number) || r.job_number, render: (r) => <>{r.job_number}{(r.kids?.length ?? 1) > 1 && <span className="neutral"> +{r.kids!.slice(1).join(',')}</span>}</> },
    { key: 'name', header: 'Site', left: true, value: (r) => r.site_name, className: 'nm', render: (r) => <>{r.site_name}{r.labor > 0 && r.labor_basis === 'trailing_rate_estimate' && <span className="warn"> ~</span>}</> },
    ...(hasRegions ? [{ key: 'reg', header: 'Region', left: true, value: (r: Row) => `${regionOf(r)} ${subregionOf(r)}`, render: (r: Row) => <>{regionOf(r)} <span className="neutral">{subregionOf(r)}</span></>, csv: (r: Row) => `${regionOf(r)} / ${subregionOf(r)}` }] : []),
    ...(hrShown ? [
      { key: 'staff', header: 'Staffed', value: (r: Row) => fillOf(staffedRow(r)), render: staffedCell,
        csv: (r: Row) => { const x = staffedRow(r); return !x ? '' : x.positions == null ? (x.filled ?? '') : `${x.filled ?? ''}/${x.positions}` } },
      { key: 'open', header: 'Open', value: (r: Row) => staffedRow(r)?.open ?? null, render: (r: Row) => staffedRow(r)?.open ?? '' },
    ] : []),
    ...(hasVariable ? [
      { key: 'fix', header: 'Fixed inv', value: fixed, render: (r: Row) => money(fixed(r)) },
      { key: 'var', header: 'Var inv', value: (r: Row) => variableWk(r, options), render: (r: Row) => (variableWk(r, options) ? money(variableWk(r, options)) : '–') },
    ] : []),
    { key: 'inv', header: w.invoiceCol, value: (r) => r.invoice, render: (r) => money(r.invoice) },
    { key: 'dir', header: w.directCol, value: directOf, render: (r) => money(directOf(r)) },
    ...(hasPallet ? [{ key: 'pal', header: 'Pallet $', value: palletOf, render: (r: Row) => (palletOf(r) ? money(palletOf(r)) : '–') }] : []),
    ...(vendor ? [{ key: 'ven', header: w.subCol(vendorLabel(account)), value: (r: Row) => r.vendor, render: (r: Row) => (r.vendor ? money(r.vendor) : '–') }] : []),
    { key: 'lab', header: w.laborCol, value: (r) => r.cost, render: (r) => <b>{money(r.cost)}</b> },
    { key: 'lp', header: 'Labor %', value: (r) => r.measurePct, render: (r) => <span className={toneOf(r.status)}>{pct(r.measurePct)}</span> },
    ...(closed.length
      ? closed.map((m): Column<Row> => ({ key: `lp-${m}`, header: w.prior(monthShort(m)), value: (r) => lpOf(r, m), render: (r) => <span className="neutral">{pct(lpOf(r, m))}</span> }))
      : [{ key: 'prior', header: w.prior(monthShort(priorMonth)), value: (r: Row) => r.priorLaborPct, render: (r: Row) => <span className="neutral">{pct(r.priorLaborPct)}</span> }]),
    { key: 'bud', header: 'Budget', value: budget, render: (r) => <span className="neutral">{money(budget(r))}</span> },
    { key: 'var$', header: '$ Var', value: variance, render: (r) => { const v = variance(r); return <span className={v == null ? '' : v > 0 ? 'bad' : 'ok'}>{money(v)}</span> } },
    ...(allocated ? [
      { key: 'alloc', header: 'Alloc $', value: (r: Row) => r.allocation, render: (r: Row) => <span className="neutral">{money(r.allocation)}</span> },
      { key: 'mgn', header: 'Margin', value: (r: Row) => r.margin, render: (r: Row) => <span className={r.margin < 0 ? 'bad' : ''}>{money(r.margin)}</span> },
    ] : []),
    { key: 'hrs', header: 'Hours', value: (r) => r.hours, render: (r) => hours1(r.hours) },
    { key: 'oth', header: 'OT hrs', value: (r) => r.ot_hours, render: (r) => hours1(r.ot_hours) },
    { key: 'otp', header: 'OT %', value: (r) => r.otPct, render: (r) => <span className={r.otPct > 0.25 ? 'bad' : r.otPct > 0.15 ? 'warn' : ''}>{pct(r.otPct)}</span> },
    { key: 'over', header: w.hoursOverCol, value: (r) => r.overHours, render: (r) => (r.overHours > 0.5 ? <span className="bad">{hours1(r.overHours)}</span> : '–') },
    ...(ratings?.length ? [{ key: 'rate', header: 'Rating', value: (r: Row) => ratingOf(r)?.average ?? null,
      render: (r: Row) => { const x = ratingOf(r); return x ? <span className={scoreTone(x.average)} title={`${x.ratings} ratings, 12 months`}>{stars(x.average)}</span> : '–' } }] : []),
    { key: 'st', header: 'Status', value: (r) => r.measurePct, render: roleBadge, csv: (r) => (r.role === 'site' ? r.status : r.role) },
  ]
  const s = accountSummary(rows, options, []).all
  const sum = (f: (r: Row) => number | null) => rows.reduce((a, r) => a + (f(r) ?? 0), 0)
  const totalVar = sum(variance)
  const priorCols = closed.length || 1
  const selfRows = rows.filter((r) => r.role === 'site' && selfPerformed(r))
  const staffedRows = selfRows.map(staffedRow).filter((x): x is Staffed => x != null)
  const selfCount = selfRows.length
  const staffedCount = staffedRows.length
  const positioned = staffedRows.filter((x) => x.positions != null)
  const hrTotal = (list: Staffed[], f: (x: Staffed) => number | null) => (list.some((x) => f(x) != null) ? list.reduce((a, x) => a + (f(x) ?? 0), 0) : '–')
  const tot = <tr className="tot"><td></td><td className="l">Total ({rows.length})</td>{hasRegions && <td></td>}
    {hrShown && <><td title={`${staffedCount} of ${selfCount} self-performed sites with staffing; filled / positions over the ${positioned.length} with positions`}>{hrTotal(positioned, (x) => x.filled)} / {hrTotal(positioned, (x) => x.positions)}</td><td>{hrTotal(staffedRows, (x) => x.open)}</td></>}
    {hasVariable && <><td>{money(sum(fixed))}</td><td>{money(sum((r) => variableWk(r, options)))}</td></>}
    <td>{money(s.invoice)}</td><td>{money(sum(directOf))}</td>{hasPallet && <td>{money(sum(palletOf))}</td>}{vendor && <td>{money(s.vendor)}</td>}<td>{money(s.cost)}</td>
    <td className={toneOf(statusOf(s.measurePct, options.target, options.watchBand))}>{pct(s.measurePct)}</td>{Array.from({ length: priorCols }, (_, i) => <td key={i} />)}
    <td className="neutral">{money(sum(budget))}</td><td className={totalVar > 0 ? 'bad' : 'ok'}>{money(totalVar)}</td>
    {allocated && <><td className="neutral">{money(s.allocation)}</td><td className={s.margin < 0 ? 'bad' : ''}>{money(s.margin)}</td></>}
    <td>{hours1(s.hours)}</td><td>{hours1(s.otHours)}</td><td>{pct(s.otPct)}</td><td>{hours1(sum((r) => r.overHours))}</td>{ratings?.length ? <td></td> : null}<td></td></tr>
  return <>
    <div className="ctrl" style={{ marginBottom: 12 }}>
      <Pills label="Filter sites" options={groups.map((o) => ({ value: o, label: o }))} value={filter} onChange={setFilter} />
      {regions.length > 1 && <><label htmlFor="site-region" className="sr-only">Region</label>
        <select id="site-region" value={region ?? ''} onChange={(e) => setRegion({ region: e.target.value || undefined, subregion: undefined })}>
          <option value="">All regions</option>{regions.map((r) => <option key={r}>{r}</option>)}</select></>}
      {subregions.length > 1 && <><label htmlFor="site-subregion" className="sr-only">Subregion</label>
        <select id="site-subregion" value={subregion ?? ''} onChange={(e) => setRegion({ subregion: e.target.value || undefined })}>
          <option value="">All of {region}</option>{subregions.map((r) => <option key={r}>{r}</option>)}</select></>}
    </div>
    {charts && <SiteCharts account={account} rows={rows} options={options} weekStart={weekStart} part="top" />}
    <div className="card"><SortTable caption={`${account.name} sites`} rows={rows} columns={cols} defaultSort={{ key: 'lp', dir: -1 }} total={tot} pageSize={100}
      rowClass={(r) => (r.role !== 'site' || !(r.invoice > 0) ? 'dim' : '')} onRowClick={(r) => navigate({ site: { company: r.company ?? '', job: r.job_number } })}
      rowLabel={(r) => `Open ${r.site_name}`} csvName={`${account.slug}-sites`} /></div>
    {charts && <SiteCharts account={account} rows={rows} options={options} weekStart={weekStart} part="bottom" />}
  </>
}
