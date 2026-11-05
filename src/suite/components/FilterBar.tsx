import { RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import type { DimensionsResponse, PrimarySource, RangeBlock, SourceBlock, SystemStatus } from '../../services/apiTypes'
import type { DataMode, ModeDecision } from '../services/dataSource'
import { PERIODS, monthLabel, rangeLabel } from '../services/period'
import { defaultFilters, type DeliveryFilter, type GlobalFilters, type ScopeMode, type ServiceType } from '../types'
import { fmtDate, fmtDateTime, relativeTime } from '../utils'

/**
 * Which server-side source filled the marts. Prefers the `source.primary_source` seen on
 * reporting payloads; before any view has reported one, falls back to /system/status.sources
 * when exactly one source is enabled and holds records.
 */
export function primarySourceOf(source: SourceBlock | null, status: SystemStatus | null): { primary: PrimarySource | null; label: string | null; arAsOf: string | null } {
  let primary: PrimarySource | null = source?.primary_source ?? null
  if (!primary) {
    const filled = (status?.sources ?? []).filter((s) => s.enabled && (s.records ?? 0) > 0)
    if (filled.length === 1 && (filled[0].name === 'finance_reference' || filled[0].name === 'winteam_api')) primary = filled[0].name
  }
  if (primary === 'finance_reference') return { primary, label: 'WinTeam exports (Finance reference)', arAsOf: source?.ar_as_of ?? null }
  if (primary === 'winteam_api') return { primary, label: 'WinTeam API', arAsOf: null }
  return { primary, label: null, arAsOf: null }
}

/** Footer / pill copy: "Live · WinTeam exports (Finance reference) · AR as of Aug 10, 2026". */
export function sourceLine(source: SourceBlock | null, status: SystemStatus | null, prefix = 'Live'): string {
  const { label, arAsOf } = primarySourceOf(source, status)
  return [prefix, label, arAsOf ? `AR as of ${fmtDate(arAsOf)}` : null].filter(Boolean).join(' · ')
}

/** Computes the data-status pill state from mode + latest system status. */
export function dataStatus(mode: DataMode, decision: ModeDecision, status: SystemStatus | null, source: SourceBlock | null = null, now = Date.now()): { tone: 'live' | 'demo' | 'stale' | 'offline'; label: string; lines: string[] } {
  if (mode === 'demo') {
    const why = decision.reason === 'marts_empty' ? 'API is up but marts are empty (no WinTeam data synced).' : `API unreachable${decision.error ? ` — ${decision.error}` : ''}.`
    return { tone: 'demo', label: 'Demo data', lines: ['Source: seeded demo dataset (src/data/seed.ts)', why, 'Latest demo month: Aug 2026'] }
  }
  const rebuilt = status?.marts?.rebuilt_at ?? null
  const synced = source?.synced_at ?? rebuilt
  const ageHours = synced ? (now - new Date(synced).getTime()) / 3_600_000 : null
  const offline = status?.database === 'unreachable'
  const primary = primarySourceOf(source, status)
  // The reference source is a loaded snapshot, not a feed: only the server's stale flag applies, never the sync age.
  const stale = (source?.stale ?? false) || (primary.primary !== 'finance_reference' && ageHours !== null && ageHours > 24)
  const lines = [
    `Source: WinTeam marts via /api/v1${status?.winteam?.base_url_host ? ` (${status.winteam.base_url_host})` : ''}`,
    `Primary source: ${primary.label ?? (source ? 'not reported by this API build' : 'pending first reporting call')}${primary.arAsOf ? ` · AR/AP aging as of ${fmtDate(primary.arAsOf)}` : ''}`,
    `as_of: ${source?.as_of ? fmtDateTime(source.as_of) : rebuilt ? fmtDateTime(rebuilt) : '—'}`,
    `latest_month: ${source?.latest_month ?? status?.marts?.latest_month ? monthLabel((source?.latest_month ?? status?.marts?.latest_month)!) : '—'}`,
    `synced_at: ${synced ? fmtDateTime(synced) : '—'}`,
    `Marts rebuilt: ${rebuilt ? fmtDateTime(rebuilt) : '—'}`,
    `Job-month rows: ${status?.marts?.job_month_rows?.toLocaleString() ?? '—'}`,
    status?.forecast ? `Forecast run: ${status.forecast.engine_version} · closed ${status.forecast.latest_closed_month ? monthLabel(status.forecast.latest_closed_month) : '—'}` : 'Forecast run: none',
  ]
  if (offline) return { tone: 'offline', label: 'Live · status unavailable', lines }
  if (primary.primary === 'finance_reference') return { tone: stale ? 'stale' : 'live', label: sourceLine(source, status, stale ? 'Stale' : 'Live'), lines }
  const syncedLabel = `synced ${relativeTime(synced, now)}`
  if (stale) return { tone: 'stale', label: primary.label ? `Stale · ${primary.label} · ${syncedLabel}` : `Stale · ${syncedLabel}`, lines }
  return { tone: 'live', label: primary.label ? `Live · ${primary.label} · ${syncedLabel}` : `Live · ${syncedLabel}`, lines }
}

/** The date the shell reports as "as of": the reporting payload's as_of, else the mart rebuild time. */
export function asOfDate(source: SourceBlock | null, status: SystemStatus | null): string | null {
  return source?.as_of ?? status?.marts?.rebuilt_at ?? null
}

/** Secondary-row dimensions: hidden behind "More filters", each one counts when set. */
const SECONDARY_KEYS = ['region', 'branch', 'serviceType', 'vertical', 'company'] as const

/**
 * Filters shown behind "More filters": delivery plus the five dimension selects. The badge on the
 * toggle counts only these, so it always matches what opening the row reveals.
 */
export const countSecondaryFilters = (filters: GlobalFilters) => (filters.delivery === defaultFilters.delivery ? 0 : 1) + SECONDARY_KEYS.filter((key) => filters[key]).length

/**
 * Number of non-default global filters. The default scope ('key') is the starting point of every
 * view and is NOT a filter; scope 'all'/'other' and an account drill-down are. Scope and account
 * are mutually exclusive server-side, so they count once between them.
 */
export const countActiveFilters = (filters: GlobalFilters) =>
  (filters.period === defaultFilters.period ? 0 : 1)
  + (filters.month ? 1 : 0)
  + (filters.account ? 1 : filters.scope === defaultFilters.scope ? 0 : 1)
  + (filters.account && filters.subAccount ? 1 : 0)
  + countSecondaryFilters(filters)

/** One `<option>` of the grouped scope/account select. */
export interface ScopeOption { value: string; label: string }
/** One `<optgroup>` (label null = ungrouped options rendered before the first group). */
export interface ScopeOptionGroup { label: string | null; options: ScopeOption[] }

/** The select value encoding a scope mode or an account drill-down. */
export const scopeValue = (scope: ScopeMode) => `scope:${scope}`
export const accountValue = (account: string) => `account:${account}`
/** The option currently selected: an account wins over the scope, mirroring the API precedence. */
export const selectedScopeValue = (filters: Pick<GlobalFilters, 'scope' | 'account'>) => (filters.account ? accountValue(filters.account) : scopeValue(filters.scope))

/**
 * Options for the primary scope/account select: key accounts first, then everything, then the
 * long tail. Falls back to `/dimensions.accounts` on API builds without key_accounts so every
 * account stays reachable.
 */
export function scopeOptions(dimensions: DimensionsResponse | undefined): ScopeOptionGroup[] {
  const key = dimensions?.key_accounts ?? []
  const keyNames = new Set(key.map((a) => a.name))
  const other = dimensions?.other_accounts ?? (dimensions?.accounts ?? []).filter((name) => !keyNames.has(name)).map((name) => ({ name, sites: 0 }))
  const groups: ScopeOptionGroup[] = [{ label: null, options: [{ value: scopeValue('key'), label: key.length ? `Key accounts · ${key.length} accounts` : 'Key accounts' }] }]
  if (key.length) groups.push({ label: 'Key accounts', options: key.map((a) => ({ value: accountValue(a.name), label: `${a.label || a.name} · ${a.sites} sites` })) })
  groups.push({ label: 'Everything', options: [{ value: scopeValue('all'), label: 'All accounts' }, { value: scopeValue('other'), label: other.length ? `Other accounts · ${other.length}` : 'Other accounts' }] })
  if (other.length) groups.push({ label: key.length ? 'Other accounts' : 'Accounts', options: other.map((a) => ({ value: accountValue(a.name), label: a.name })) })
  return groups
}

/** Apply a scope/account selection: an account clears the scope drill-down and vice versa. */
export function applyScopeValue(filters: GlobalFilters, value: string): GlobalFilters {
  if (value.startsWith('account:')) {
    const account = value.slice('account:'.length)
    return { ...filters, account, subAccount: account === filters.account ? filters.subAccount : '' }
  }
  const scope = value.slice('scope:'.length) as ScopeMode
  return { ...filters, scope, account: '', subAccount: '' }
}

/** Sub-accounts worth choosing between: only a key account with two or more of them gets a select. */
export function subAccountOptions(dimensions: DimensionsResponse | undefined, account: string): { name: string; sites: number }[] {
  if (!account) return []
  const key = dimensions?.key_accounts?.find((a) => a.name === account)
  const subs = key?.sub_accounts ?? []
  return subs.length >= 2 ? subs : []
}

const DELIVERY_OPTIONS: { value: DeliveryFilter; label: string }[] = [
  { value: 'all', label: 'All delivery' }, { value: 'self_perform', label: 'Self-performed' }, { value: 'subcontracted', label: 'Subcontracted' },
]

interface FilterBarProps {
  filters: GlobalFilters
  onChange: (filters: GlobalFilters) => void
  onReset: () => void
  dimensions: DimensionsResponse | undefined
  range: RangeBlock | null
  verticalLabels: Record<ServiceType, string>
  latestMonth: string | null
}

export function FilterBar({ filters, onChange, onReset, dimensions, range, verticalLabels, latestMonth }: FilterBarProps) {
  const [open, setOpen] = useState(false)
  const update = <K extends keyof GlobalFilters>(key: K, value: GlobalFilters[K]) => onChange({ ...filters, [key]: value })
  const activeCount = countActiveFilters(filters)
  const secondaryCount = countSecondaryFilters(filters)
  const companies = dimensions?.companies ?? []
  const statusOf = new Map((dimensions?.month_status ?? []).map((m) => [m.month, m.status]))
  const monthOption = (m: string) => { const s = statusOf.get(m); return s === 'in_progress' ? `${monthLabel(m)} · in progress` : s === 'no_revenue' ? `${monthLabel(m)} · no revenue` : monthLabel(m) }
  const months = dimensions?.months ? [...dimensions.months].reverse() : []
  const groups = scopeOptions(dimensions)
  const subAccounts = subAccountOptions(dimensions, filters.account)
  // The account group is stored as `Education` but shown as `School districts`; the sub-account
  // control must use the same name as the scope selector above it.
  const accountLabel = (dimensions?.key_accounts ?? []).find((a) => a.name === filters.account)?.label ?? filters.account
  const select = (label: string, key: keyof GlobalFilters, options: string[], allLabel: string, labelOf?: (v: string) => string) => (
    <label><span>{label}</span><select value={filters[key] ?? ''} onChange={(e) => update(key, e.target.value as never)} aria-label={label}><option value="">{allLabel}</option>{options.map((value) => <option key={value} value={value}>{labelOf ? labelOf(value) : value}</option>)}</select></label>
  )
  return <div className="filterbar" aria-label="Portfolio filters">
    <div className="filterbar__primary">
      <div className="period-tabs" role="group" aria-label="Reporting period">{PERIODS.map((period) => <button key={period} className={filters.period === period ? 'active' : ''} aria-pressed={filters.period === period} onClick={() => update('period', period)}>{period}</button>)}</div>
      <span className="period-basis period-basis--range num" title="Resolved server-side from the period and anchor month">{range ? rangeLabel(range) : 'Resolving range…'}</span>
      <label className="scope-select"><span>Scope</span><select value={selectedScopeValue(filters)} onChange={(e) => onChange(applyScopeValue(filters, e.target.value))} aria-label="Reporting scope or account">
        {groups.map((group) => group.label === null
          ? group.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)
          : <optgroup key={group.label} label={group.label}>{group.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>)}
      </select></label>
      <label><span>Month</span><select value={filters.month ?? ''} onChange={(e) => update('month', e.target.value || null)} aria-label="Anchor month"><option value="">{latestMonth ? `Default · ${monthLabel(latestMonth)} (latest closed)` : 'Default (latest closed)'}</option>{months.map((m) => <option key={m} value={m}>{monthOption(m)}</option>)}</select></label>
      {subAccounts.length > 0 && <label className="sub-account-select"><span>Sub-account</span><select value={filters.subAccount} onChange={(e) => update('subAccount', e.target.value)} aria-label={`Sub-account of ${accountLabel}`}><option value="">{`All of ${accountLabel}`}</option>{subAccounts.map((s) => <option key={s.name} value={s.name}>{`${s.name} · ${s.sites} sites`}</option>)}</select></label>}
      <button type="button" className="filter-toggle" aria-expanded={open} aria-controls="filterbar-more" aria-label={secondaryCount > 0 ? `More filters, ${secondaryCount} applied` : 'More filters, none applied'} onClick={() => setOpen((value) => !value)}><SlidersHorizontal size={15} aria-hidden="true" /><span>More filters</span>{secondaryCount > 0 && <b aria-hidden="true">{secondaryCount}</b>}</button>
    </div>
    <div className="filter-fields" id="filterbar-more" hidden={!open}>
      <label><span>Delivery</span><select value={filters.delivery} onChange={(e) => update('delivery', e.target.value as DeliveryFilter)} aria-label="Delivery model">{DELIVERY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      {companies.length >= 2 && select('Company', 'company', companies, 'All companies')}
      {select('Region', 'region', dimensions?.regions ?? [], 'All regions')}
      {select('Branch', 'branch', dimensions?.branches ?? [], 'All branches')}
      {select('Service', 'serviceType', dimensions?.service_types ?? [], 'All services', (v) => verticalLabels[v as ServiceType] ?? v)}
      {select('Vertical', 'vertical', dimensions?.verticals ?? [], 'All verticals')}
      {activeCount > 0 && <button type="button" className="filter-reset" onClick={() => { onReset(); setOpen(false) }} aria-label={`Reset ${activeCount} active filters to key accounts`}><RotateCcw size={13} aria-hidden="true" /><span>Reset</span><b aria-hidden="true">{activeCount}</b></button>}
    </div>
  </div>
}
