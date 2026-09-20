import { MapPinOff, Search, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { QueryCard } from '../components/CardState'
import { OperationsMap, hasCoordinates, type MapJob } from '../components/OperationsMap'
import { useDashboard } from '../context/DashboardContext'
import type { JobRow } from '../services/apiTypes'
import { PERIODS, rangeLabel } from '../services/period'
import { defaultFilters, type GlobalFilters, type ServiceType } from '../types'
import { money, percent, sum } from '../utils'
import { DemoNotice, JobLink, ScopeLine, useJobsQuery } from './shared'

export function Geography() {
  const { filters, setFilters, dimensions, resolvedRange, openJob, verticalLabels } = useDashboard()
  const jobs = useJobsQuery()
  const [country, setCountry] = useState('All')
  const [status, setStatus] = useState('All')
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<MapJob | null>(null)
  const everyJob = useMemo(() => jobs.data?.jobs ?? [], [jobs.data])
  const all = useMemo(() => everyJob.filter(hasCoordinates), [everyJob])
  // Sites the marts could not place are counted and listed rather than silently dropped.
  const missing = useMemo(() => everyJob.filter((j) => !hasCoordinates(j)), [everyJob])
  const countries = useMemo(() => [...new Set(everyJob.map((j) => j.country_code))].sort(), [everyJob])
  const localMatch = (j: JobRow) => (country === 'All' || j.country_code === country) && (status === 'All' || j.status === status)
  const shown = useMemo(() => all.filter(localMatch), [all, country, status]) // eslint-disable-line react-hooks/exhaustive-deps
  const missingShown = useMemo(() => missing.filter(localMatch), [missing, country, status]) // eslint-disable-line react-hooks/exhaustive-deps
  const approximate = shown.filter((j) => j.geo_precision === 'city_center').length
  useEffect(() => { if (selected && !shown.some((j) => j.job_number === selected.job_number)) setSelected(null) }, [shown, selected])
  const update = <K extends keyof GlobalFilters>(key: K, value: GlobalFilters[K]) => setFilters({ ...filters, [key]: value })
  const reset = () => { setCountry('All'); setStatus('All'); setSelected(null); setFilters(defaultFilters) }
  const revenue = sum(shown, (j) => j.revenue), gp = sum(shown, (j) => j.gross_profit)
  const hasFilters = country !== 'All' || status !== 'All' || JSON.stringify({ ...filters }) !== JSON.stringify(defaultFilters)
  const companies = dimensions?.companies ?? []
  const secondaryCount = (country === 'All' ? 0 : 1) + (status === 'All' ? 0 : 1) + (filters.region ? 1 : 0) + (filters.branch ? 1 : 0) + (filters.serviceType ? 1 : 0) + (filters.vertical ? 1 : 0) + (filters.company ? 1 : 0)
  const countryName = (code: string) => (code === 'US' ? 'United States' : code === 'CA' ? 'Canada' : code)
  const select = (label: string, value: string, onChange: (v: string) => void, options: string[], allLabel: string, labelOf?: (v: string) => string) => <label><span>{label}</span><select value={value} onChange={(e) => onChange(e.target.value)}><option value="">{allLabel}</option>{options.map((o) => <option key={o} value={o}>{labelOf ? labelOf(o) : o}</option>)}</select></label>
  return <>
    <ScopeLine />
    <DemoNotice>Coordinates and site health are seeded; every fifth site is placed at its city center.</DemoNotice>
    <div className="map-filterbar" aria-label="Map filters">
      <div className="period-tabs" role="group" aria-label="Reporting period">{PERIODS.map((period) => <button key={period} className={filters.period === period ? 'active' : ''} aria-pressed={filters.period === period} onClick={() => update('period', period)}>{period}</button>)}</div>
      <span className="period-basis period-basis--range num">{resolvedRange ? rangeLabel(resolvedRange) : ''}</span>
      {select('Parent account', filters.account, (v) => update('account', v), dimensions?.accounts ?? [], 'All accounts')}
      <button className="map-filter-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}><SlidersHorizontal size={15} />More filters{secondaryCount > 0 && <b>{secondaryCount}</b>}</button>
      <div className={`map-secondary-filters ${open ? 'map-secondary-filters--open' : ''}`}>
        <label><span>Country</span><select value={country} onChange={(e) => setCountry(e.target.value)}><option value="All">All countries</option>{countries.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}</select></label>
        {select('Region', filters.region, (v) => update('region', v), dimensions?.regions ?? [], 'All regions')}
        {select('Branch', filters.branch, (v) => update('branch', v), dimensions?.branches ?? [], 'All branches')}
        {select('Service', filters.serviceType, (v) => update('serviceType', v), dimensions?.service_types ?? [], 'All services', (v) => verticalLabels[v as ServiceType] ?? v)}
        {select('Vertical', filters.vertical, (v) => update('vertical', v), dimensions?.verticals ?? [], 'All verticals')}
        {companies.length >= 2 && select('Company', filters.company, (v) => update('company', v), companies, 'All companies')}
        <label><span>Site health</span><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="All">All statuses</option><option>Healthy</option><option>Watch</option><option>Critical</option></select></label>
      </div>
      <div className="map-filterbar__result"><strong>{shown.length}</strong><span>of {all.length} sites shown</span>{hasFilters && <button onClick={reset}>Clear all</button>}</div>
    </div>
    <div className="map-page-summary map-page-summary--5"><div><strong className="num">{shown.length}</strong><span>visible locations{approximate ? ` · ${approximate} at approx. city center` : ''}</span></div><div><strong className="num">{shown.filter((j) => j.status === 'Critical').length}</strong><span>critical sites</span></div><div><strong className="num">{money(revenue)}</strong><span>revenue · {resolvedRange ? rangeLabel(resolvedRange).split(' · ')[0] : ''}</span></div><div><strong className="num">{revenue ? percent((gp / revenue) * 100) : '—'}</strong><span>portfolio margin</span></div><div><strong className={`num ${missingShown.length ? 'text-warn' : ''}`}>{missingShown.length}</strong><span>sites without coordinates</span></div></div>
    <QueryCard title="Site map" subtitle="Clusters and heat layers · click a site for detail" className="geography-map-card" query={jobs} isEmpty={() => !all.length} emptyTitle="No sites with coordinates" emptyHint={missing.length ? `${missing.length} sites match the filters but the marts have no latitude/longitude for them; they are listed below.` : 'The marts have no latitude/longitude for these filters.'}>{() => (shown.length ? <OperationsMap jobs={shown} selected={selected} onSelect={setSelected} onOpenDetail={(j) => openJob(j.job_number)} /> : <div className="map-empty"><Search size={24} /><strong>No sites match these map filters</strong><span>Clear one or more filters to restore locations.</span><button className="secondary-button" onClick={reset}>Clear map filters</button></div>)}</QueryCard>
    {missingShown.length > 0 && <details className="map-missing"><summary><MapPinOff size={13} aria-hidden="true" />{missingShown.length} site{missingShown.length === 1 ? '' : 's'} without coordinates · not on the map · {money(sum(missingShown, (j) => j.revenue))} revenue in range</summary><ul>{missingShown.map((j) => <li key={j.job_number}><JobLink job={j}>{j.job_name}</JobLink><small>{j.city || '—'}, {j.state_province || '—'} · {j.parent_account}</small></li>)}</ul></details>}
  </>
}
