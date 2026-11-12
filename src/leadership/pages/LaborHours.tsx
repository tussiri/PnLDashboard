import { useMemo, useState } from 'react'
import { useApiQuery } from '../../hooks/useApiQuery'
import type { LaborHoursPunch, LaborHoursResponse } from '../../services/apiTypes'
import { queryKey } from '../../services/queryClient'
import { hours, hours1 } from '../format'
import { addDays, weekStartOf } from '../routes'
import { PageHeader } from '../Shell'
import { useLeadership } from '../state'
import { Empty, Kpi, LoadError, Pills, Skeleton, SortTable, type Column } from '../ui'

type Employee = LaborHoursResponse['employees'][number]
type Site = LaborHoursResponse['sites'][number]
type PunchRow = LaborHoursPunch & { employee_number: string; employee_name: string | null }

const DASH = '–'
const SEP = '~'
const PAGE = 50
const jobId = (company: string | null, job: string) => `${company ?? ''}${SEP}${job}`
const count = (v: number) => v.toLocaleString('en-US')
const round2 = (v: number) => Math.round(v * 100) / 100
const siteLabel = (r: { site_name: string | null; job_number: string }) => r.site_name ?? r.job_number

const PUNCH_COLUMNS: Column<LaborHoursPunch>[] = [
  { key: 'date', header: 'Date', left: true, value: (r) => r.work_date },
  { key: 'site', header: 'Site', left: true, value: siteLabel },
  { key: 'type', header: 'Hours type', left: true, value: (r) => r.hours_type },
  { key: 'in', header: 'In', value: (r) => r.in_time, render: (r) => r.in_time ?? DASH },
  { key: 'out', header: 'Out', value: (r) => r.out_time, render: (r) => r.out_time ?? DASH },
  { key: 'lunch', header: 'Lunch', value: (r) => r.lunch_hours, render: (r) => r.lunch_hours.toFixed(2) },
  { key: 'hours', header: 'Hours', value: (r) => r.hours, render: (r) => r.hours.toFixed(2) },
]

const EMPLOYEE_COLUMNS: Column<Employee>[] = [
  { key: 'number', header: 'Employee', left: true, value: (r) => r.employee_number },
  { key: 'name', header: 'Name', left: true, value: (r) => r.employee_name, render: (r) => r.employee_name ?? DASH },
  { key: 'title', header: 'Title', left: true, value: (r) => r.title, render: (r) => r.title ?? DASH },
  { key: 'company', header: 'Company', left: true, value: (r) => r.company },
  { key: 'sites', header: 'Sites', value: (r) => r.sites },
  { key: 'days', header: 'Days', value: (r) => r.days },
  { key: 'punches', header: 'Punches', value: (r) => r.punches.length },
  { key: 'lunch', header: 'Lunch', value: (r) => r.lunch_hours, render: (r) => hours1(r.lunch_hours) },
  { key: 'hours', header: 'Hours', value: (r) => r.hours, render: (r) => hours1(r.hours) },
]

const ALL_PUNCH_COLUMNS: Column<PunchRow>[] = [
  { key: 'number', header: 'Employee', left: true, value: (r) => r.employee_number },
  { key: 'name', header: 'Name', left: true, value: (r) => r.employee_name, render: (r) => r.employee_name ?? DASH },
  ...(PUNCH_COLUMNS as Column<PunchRow>[]),
]

const SITE_COLUMNS: Column<Site>[] = [
  { key: 'job', header: 'Job', left: true, value: (r) => r.job_number },
  { key: 'site', header: 'Site', left: true, value: siteLabel },
  { key: 'city', header: 'City', left: true, value: (r) => r.city },
  { key: 'company', header: 'Company', left: true, value: (r) => r.company },
  { key: 'employees', header: 'Employees', value: (r) => r.employees },
  { key: 'punches', header: 'Punches', value: (r) => r.punches },
  { key: 'hours', header: 'Hours', value: (r) => r.hours, render: (r) => hours1(r.hours) },
]

/** Each employee's punches at the states' sites in a period: the synced WinTeam timekeeping, hours only. */
export function LaborHours() {
  const { api, keyPrefix, decision, route, navigate } = useLeadership()
  const [lastWeekEnd] = useState(() => addDays(weekStartOf(new Date().toLocaleDateString('en-CA')), -1))
  const dateFrom = route.from ?? addDays(lastWeekEnd, -6)
  const dateTo = route.to ?? lastWeekEnd
  const [openEmployee, setOpenEmployee] = useState<string | null>(null)
  const q = useApiQuery<LaborHoursResponse>(decision ? queryKey(`${keyPrefix}/labor-hours`, { date_from: dateFrom, date_to: dateTo }) : null,
    (signal) => api.laborHours({ date_from: dateFrom, date_to: dateTo }, signal), [api, dateFrom, dateTo])
  const d = q.data
  const search = (route.q ?? '').trim().toLowerCase()
  const employees = useMemo(() => (d?.employees ?? []).flatMap((e) => {
    if (search && !`${e.employee_number} ${e.employee_name ?? ''} ${e.title ?? ''}`.toLowerCase().includes(search)) return []
    if (!route.job) return [e]
    const punches = e.punches.filter((p) => jobId(p.company, p.job_number) === route.job)
    if (!punches.length) return []
    return [{ ...e, punches, sites: 1, days: new Set(punches.map((p) => p.work_date)).size,
      hours: round2(punches.reduce((a, p) => a + p.hours, 0)), lunch_hours: round2(punches.reduce((a, p) => a + p.lunch_hours, 0)) }]
  }), [d, search, route.job])
  const punches = useMemo<PunchRow[]>(() => employees.flatMap((e) => e.punches.map((p) => ({ ...p, employee_number: e.employee_number, employee_name: e.employee_name }))), [employees])
  const sites = useMemo(() => (d?.sites ?? []).filter((s) => !route.job || jobId(s.company, s.job_number) === route.job), [d, route.job])
  const siteOptions = useMemo(() => [...(d?.sites ?? [])].sort((a, b) => siteLabel(a).localeCompare(siteLabel(b))), [d])
  const hoursShown = employees.reduce((a, e) => a + e.hours, 0)
  const show = route.show ?? 'employees'
  const csv = `labor-hours-${dateFrom}-to-${dateTo}`
  const employeeKey = (e: Employee) => jobId(e.company, e.employee_number)
  return <>
    <PageHeader account={false} week={false} target={false} title="Labor hours" subtitle={d?.states.length ? `State: ${d.states.join(', ')}` : undefined} extra={<>
      <label htmlFor="lh-from">From</label>
      <input id="lh-from" type="date" value={dateFrom} max={dateTo} onChange={(e) => e.target.value && navigate({ from: e.target.value }, { replace: true })} />
      <label htmlFor="lh-to">To</label>
      <input id="lh-to" type="date" value={dateTo} min={dateFrom} onChange={(e) => e.target.value && navigate({ to: e.target.value }, { replace: true })} />
    </>} />
    {q.error ? <LoadError error={q.error} onRetry={q.refetch} /> : !d ? <Skeleton height={420} /> : <>
      <div className="kpi-lg">
        <Kpi label="Employees" value={count(employees.length)} />
        <Kpi label="Sites" value={count(new Set(punches.map((p) => jobId(p.company, p.job_number))).size)} />
        <Kpi label="Hours" value={hours(hoursShown)} />
        <Kpi label="Punches through" value={d.through ?? DASH} small />
      </div>
      <div className="card">
        <div className="filters ctrl">
          <Pills label="Show" value={show} onChange={(v) => navigate({ show: v === 'employees' ? undefined : v }, { replace: true })}
            options={[{ value: 'employees', label: 'Employees' }, { value: 'punches', label: 'Punches' }, { value: 'sites', label: 'Sites' }]} />
          <label htmlFor="lh-site">Site</label>
          <select id="lh-site" value={route.job ?? ''} onChange={(e) => navigate({ job: e.target.value || undefined }, { replace: true })}>
            <option value="">All sites</option>
            {siteOptions.map((s) => <option key={jobId(s.company, s.job_number)} value={jobId(s.company, s.job_number)}>{siteLabel(s)}</option>)}
          </select>
          <label htmlFor="lh-q">Employee</label>
          <input id="lh-q" type="search" value={route.q ?? ''} onChange={(e) => navigate({ q: e.target.value || undefined }, { replace: true })} />
        </div>
        {!employees.length ? <Empty>No punches in this period.</Empty>
          : show === 'punches' ? <SortTable caption="Punches" rows={punches} columns={ALL_PUNCH_COLUMNS} defaultSort={{ key: 'date', dir: 1 }} pageSize={PAGE} csvName={`${csv}-punches`} />
          : show === 'sites' ? <SortTable caption="Hours by site" rows={sites} columns={SITE_COLUMNS} defaultSort={{ key: 'hours', dir: -1 }} pageSize={PAGE} csvName={`${csv}-sites`} />
          : <SortTable caption="Hours by employee" rows={employees} columns={EMPLOYEE_COLUMNS} defaultSort={{ key: 'hours', dir: -1 }} pageSize={PAGE} csvName={`${csv}-employees`}
              onRowClick={(e) => setOpenEmployee((k) => (k === employeeKey(e) ? null : employeeKey(e)))} rowLabel={(e) => `Punches of ${e.employee_name ?? e.employee_number}`}
              detail={(e) => (openEmployee === employeeKey(e)
                ? <SortTable caption={`Punches of ${e.employee_name ?? e.employee_number}`} rows={e.punches} columns={PUNCH_COLUMNS} defaultSort={{ key: 'date', dir: 1 }} />
                : null)} />}
      </div>
    </>}
  </>
}
