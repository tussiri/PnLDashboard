import { useMemo } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../../services/apiTypes'
import { measureLabel, rowsOfWeek, segmentOrder, useRows } from '../data'
import { hours, hours1, money, pct } from '../format'
import { accountSummary, statusOf, type MetricOptions, type Rollup, type SiteMetrics as Metrics } from '../metrics'
import { weekLabel } from '../routes'
import { freshnessLine, PageHeader } from '../Shell'
import { useLeadership } from '../state'
import { Badge, Empty, LoadError, Pills, Skeleton, SortTable, STATUS_LABEL, toneOf, type Column } from '../ui'
import { roleBadge } from './Account'
import { SiteDrawer } from './SiteDrawer'

type Site = Metrics<LeadershipRow> & { accountName: string; groupName: string; measureName: string }
interface Group { key: string; name: string; rollup: Rollup; target: number; watchBand?: number; sites: number; measureName: string }

const OTHER = 'other'
const STATUSES = ['all', 'over', 'watch', 'on_target', 'no_billing'] as const

/** Every account, Other included, drilled account -> segment (or current account group for Other) -> site. */
export function Analytics() {
  const { featured, accountBySlug, route, navigate, weekStart, optionsFor, config, targetOverride } = useLeadership()
  const q = useRows('all', 1)
  const rows = useMemo(() => rowsOfWeek(q.data?.rows, weekStart), [q.data, weekStart])
  const featuredSlugs = useMemo(() => new Set(featured.map((a) => a.slug)), [featured])
  const scope = route.account
  const otherOptions: MetricOptions = useMemo(() => ({ target: targetOverride ?? 0.645 }), [targetOverride])

  // Every row with its metrics under its own account's options; Other uses the default target and labor basis.
  const sites: Site[] = useMemo(() => {
    const out: Site[] = []
    const bySlug = new Map<string, LeadershipRow[]>()
    for (const r of rows) {
      const key = r.account_slug && featuredSlugs.has(r.account_slug) ? r.account_slug : OTHER
      bySlug.set(key, [...(bySlug.get(key) ?? []), r])
    }
    for (const [key, list] of bySlug) {
      const account = key === OTHER ? undefined : accountBySlug(key)
      const options = account ? optionsFor(account) : otherOptions
      const s = accountSummary(list, options, segmentOrder(account))
      for (const site of s.sites) out.push({ ...site, accountName: account?.name ?? 'Other', groupName: account ? site.segment ?? (site.role === 'catch_all' ? 'Catch-all' : 'Non-billed') : site.parent_account ?? 'Unassigned', measureName: measureLabel(account) })
    }
    return out
  }, [rows, featuredSlugs, accountBySlug, optionsFor, otherOptions])

  const groupsFor = (list: Site[], keyOf: (s: Site) => string, nameOf: (s: Site) => string, optionsOf: (key: string) => MetricOptions, measureOf: (key: string) => string): Group[] => {
    const map = new Map<string, Site[]>()
    for (const s of list) map.set(keyOf(s), [...(map.get(keyOf(s)) ?? []), s])
    return [...map.entries()].map(([key, ss]) => {
      const options = optionsOf(key)
      const billed = ss.filter((s) => s.role !== 'non_billed')
      const r = accountSummary(billed, options).all
      return { key, name: nameOf(ss[0]), rollup: r, target: options.target, watchBand: options.watchBand, sites: ss.length, measureName: measureOf(key) }
    })
  }

  const scopeAccount: LeadershipAccount | undefined = scope && scope !== OTHER ? accountBySlug(scope) : undefined
  const inScope = sites.filter((s) => !scope || (scope === OTHER ? s.accountName === 'Other' : s.account_slug === scope))
  const level1 = groupsFor(sites, (s) => (s.accountName === 'Other' ? OTHER : s.account_slug!), (s) => s.accountName,
    (k) => (k === OTHER ? otherOptions : optionsFor(accountBySlug(k))), (k) => measureLabel(k === OTHER ? undefined : accountBySlug(k)))
    .sort((a, b) => (a.key === OTHER ? 1 : b.key === OTHER ? -1 : (accountBySlug(a.key)?.sort ?? 0) - (accountBySlug(b.key)?.sort ?? 0)))
  const level2 = scope ? groupsFor(inScope, (s) => s.groupName, (s) => s.groupName, (k) => {
    const o = scopeAccount ? optionsFor(scopeAccount) : otherOptions
    return { ...o, target: o.segmentTargets?.[k] ?? o.target }
  }, () => measureLabel(scopeAccount)) : []
  const filtered = inScope.filter((s) => (!route.segment || s.groupName === route.segment)
    && (!route.status || route.status === 'all' || (s.role === 'site' && s.status === route.status))
    && (!route.q || `${s.job_number} ${s.site_name} ${s.accountName} ${s.groupName} ${s.city ?? ''}`.toLowerCase().includes(route.q.toLowerCase())))

  const groupCols = (label: string): Column<Group>[] => [
    { key: 'name', header: label, left: true, value: (g) => g.name, className: 'nm' },
    { key: 'sites', header: 'Sites', value: (g) => g.sites },
    { key: 'inv', header: 'Weekly invoice', value: (g) => g.rollup.invoice, render: (g) => money(g.rollup.invoice) },
    { key: 'cost', header: 'Cost', value: (g) => g.rollup.cost, render: (g) => money(g.rollup.cost) },
    { key: 'm', header: 'Labor / cost %', value: (g) => g.rollup.measurePct, render: (g) => <span className={toneOf(statusOf(g.rollup.measurePct, g.target, g.watchBand))}>{pct(g.rollup.measurePct)}</span>, csv: (g) => g.rollup.measurePct },
    { key: 'basis', header: 'Measure', left: true, value: (g) => g.measureName, render: (g) => <span className="neutral">{g.measureName}</span> },
    { key: 'tgt', header: 'Target', value: (g) => g.target, render: (g) => pct(g.target) },
    { key: 'over', header: '$ over', value: (g) => g.rollup.overDollars, render: (g) => money(g.rollup.overDollars) },
    { key: 'hrs', header: 'Hours', value: (g) => g.rollup.hours, render: (g) => hours(g.rollup.hours) },
    { key: 'otp', header: 'OT %', value: (g) => g.rollup.otPct, render: (g) => pct(g.rollup.otPct) },
    { key: 'prior', header: 'Prior month LP', value: (g) => g.rollup.priorLaborPct, render: (g) => <span className="neutral">{pct(g.rollup.priorLaborPct)}</span> },
    { key: 'st', header: 'Status', value: (g) => g.rollup.measurePct, render: (g) => <Badge status={statusOf(g.rollup.measurePct, g.target, g.watchBand)} />, csv: (g) => statusOf(g.rollup.measurePct, g.target, g.watchBand) },
  ]
  const siteCols: Column<Site>[] = [
    { key: 'acct', header: 'Account', left: true, value: (s) => s.accountName },
    { key: 'grp', header: scope === OTHER ? 'Account group' : 'Segment', left: true, value: (s) => s.groupName, className: 'nm' },
    { key: 'job', header: 'Job', left: true, value: (s) => s.job_number },
    { key: 'name', header: 'Location', left: true, value: (s) => s.site_name, className: 'nm' },
    { key: 'co', header: 'Company', left: true, value: (s) => s.company, render: (s) => <span className="neutral">{s.company}</span> },
    { key: 'inv', header: 'Invoice', value: (s) => s.invoice, render: (s) => money(s.invoice) },
    { key: 'lab', header: 'Labor $', value: (s) => s.labor, render: (s) => money(s.labor) },
    { key: 'ven', header: 'Vendor $', value: (s) => s.sub_week, render: (s) => money(s.sub_week) },
    { key: 'm', header: 'Labor / cost %', value: (s) => s.measurePct, render: (s) => <span className={toneOf(s.status)}>{pct(s.measurePct)}</span> },
    { key: 'prior', header: 'Prior LP', value: (s) => s.priorLaborPct, render: (s) => <span className="neutral">{pct(s.priorLaborPct)}</span> },
    { key: 'hrs', header: 'Hours', value: (s) => s.hours, render: (s) => hours1(s.hours) },
    { key: 'oth', header: 'OT hrs', value: (s) => s.ot_hours, render: (s) => hours1(s.ot_hours) },
    { key: 'over', header: 'Hrs over', value: (s) => s.overHours, render: (s) => (s.overHours > 0.5 ? <span className="bad">{hours1(s.overHours)}</span> : '–') },
    { key: 'basis', header: 'Labor basis', left: true, value: (s) => (s.labor_basis === 'pay_report' ? 'Pay report' : 'Estimate'), render: (s) => <span className="neutral">{s.labor_basis === 'pay_report' ? 'Pay report' : 'Estimate'}</span> },
    { key: 'st', header: 'Status', value: (s) => s.measurePct, render: roleBadge, csv: (s) => (s.role === 'site' ? s.status : s.role) },
  ]
  const subtitle = [weekStart ? weekLabel(weekStart) : null, freshnessLine(config.data)].filter(Boolean).join('. ')
  const set = (next: Parameters<typeof navigate>[0]) => navigate(next, { replace: true })
  return <>
    <PageHeader title="Analytics" subtitle={subtitle} />
    {q.error ? <LoadError error={q.error} onRetry={q.refetch} /> : !q.data ? <Skeleton height={400} /> : !sites.length ? <Empty>No rows in the selected week.</Empty> : <>
      <div className="card">
        <div className="ct"><span>Accounts</span>{scope && <button type="button" className="linkbtn" onClick={() => set({ account: undefined, segment: undefined })}>All accounts</button>}</div>
        <SortTable caption="Accounts" rows={level1} columns={groupCols('Account')} defaultSort={{ key: 'inv', dir: -1 }} csvName="accounts"
          onRowClick={(g) => set({ account: g.key, segment: undefined })} rowLabel={(g) => `Drill into ${g.name}`} rowClass={(g) => (g.key === scope ? 'tot' : '')} />
      </div>
      {scope && <div className="card">
        <div className="ct"><span>{scope === OTHER ? 'Other: account groups' : `${scopeAccount?.name}: segments`}</span>{route.segment && <button type="button" className="linkbtn" onClick={() => set({ segment: undefined })}>All {scope === OTHER ? 'groups' : 'segments'}</button>}</div>
        <SortTable caption="Groups" rows={level2} columns={groupCols(scope === OTHER ? 'Account group' : 'Segment')} defaultSort={{ key: 'inv', dir: -1 }} csvName={`${scope}-groups`}
          onRowClick={(g) => set({ segment: g.key })} rowLabel={(g) => `Show sites in ${g.name}`} rowClass={(g) => (g.key === route.segment ? 'tot' : '')} />
      </div>}
      <div className="card">
        <div className="ct"><span>Sites{route.segment ? `: ${route.segment}` : scope ? `: ${scope === OTHER ? 'Other' : scopeAccount?.name}` : ''}</span></div>
        <Pills label="Status" value={(route.status ?? 'all') as (typeof STATUSES)[number]} onChange={(v) => set({ status: v === 'all' ? undefined : v })}
          options={STATUSES.map((s) => ({ value: s, label: s === 'all' ? 'All' : STATUS_LABEL[s] }))} />
        <SortTable caption="Sites" rows={filtered} columns={siteCols} defaultSort={{ key: 'over', dir: -1 }} csvName={`sites-${scope ?? 'all'}`}
          tools={<><label htmlFor="q" className="sr-only">Search sites</label><input id="q" type="search" placeholder="Search job, site, city" defaultValue={route.q ?? ''} onChange={(e) => set({ q: e.target.value || undefined })} /></>}
          onRowClick={(s) => navigate({ site: { company: s.company ?? '', job: s.job_number } })}
          rowLabel={(s) => `Open ${s.site_name}`} rowClass={(s) => (s.role !== 'site' ? 'dim' : '')} />
      </div>
    </>}
    {route.site && <SiteDrawer company={route.site.company} job={route.site.job} />}
  </>
}
