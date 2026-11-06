import { useApiQuery } from '../../hooks/useApiQuery'
import type { DirectorySite, LeadershipAccount, LeadershipDirectoryResponse } from '../../services/apiTypes'
import { queryKey } from '../../services/queryClient'
import { hours } from '../format'
import { useLeadership } from '../state'
import { Empty, Kpi, LoadError, Skeleton, SortTable, type Column } from '../ui'

const DASH = '–'
const DELIVERY = { self_perform: 'Self-perform', subcontracted: 'Subcontracted' } as const
const date = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : DASH)
/** WinTeam's nine-digit ZIP as ZIP+4. */
export const zipOf = (zip: string | null) => (zip && /^\d{9}$/.test(zip) ? `${zip.slice(0, 5)}-${zip.slice(5)}` : zip)
export const addressOf = (s: DirectorySite) => [s.address_line_1, s.address_line_2].filter(Boolean).join(', ')

const COLUMNS: Column<DirectorySite>[] = [
  { key: 'code', header: 'Code', left: true, value: (s) => s.code, render: (s) => s.code ?? DASH },
  { key: 'name', header: 'Site', left: true, value: (s) => s.name, className: 'nm' },
  { key: 'job', header: 'Job', left: true, value: (s) => s.job_number },
  { key: 'company', header: 'Company', left: true, value: (s) => s.company },
  { key: 'address', header: 'Address', left: true, value: addressOf, className: 'nm' },
  { key: 'city', header: 'City', left: true, value: (s) => s.city, render: (s) => s.city ?? DASH },
  { key: 'state', header: 'State', left: true, value: (s) => s.state, render: (s) => s.state ?? DASH },
  { key: 'zip', header: 'ZIP', left: true, value: (s) => zipOf(s.postal_code), render: (s) => zipOf(s.postal_code) ?? DASH },
  { key: 'region', header: 'Region', left: true, value: (s) => s.region, render: (s) => s.region ?? DASH },
  { key: 'market', header: 'Market', left: true, value: (s) => s.market, render: (s) => s.market ?? DASH },
  { key: 'manager', header: 'Manager', left: true, value: (s) => s.manager, render: (s) => s.manager ?? DASH },
  { key: 'delivery', header: 'Delivery', left: true, value: (s) => (s.delivery ? DELIVERY[s.delivery] : null), render: (s) => (s.delivery ? DELIVERY[s.delivery] : DASH) },
  { key: 'start', header: 'Start', left: true, value: (s) => s.start_date, render: (s) => date(s.start_date) },
  { key: 'status', header: 'Status', left: true, value: (s) => (s.active ? 'Active' : 'Inactive') },
  { key: 'hours', header: 'Hours, 28d', value: (s) => s.hours_28d, render: (s) => hours(s.hours_28d) },
  { key: 'employees', header: 'Employees, 28d', value: (s) => s.employees_28d },
  { key: 'last', header: 'Last punch', left: true, value: (s) => s.last_punch, render: (s) => date(s.last_punch) },
]

/** Every site mapped to the account as WinTeam lists it, including those nobody has worked yet. */
export function Directory({ account }: { account: LeadershipAccount }) {
  const { api, keyPrefix, decision } = useLeadership()
  const q = useApiQuery<LeadershipDirectoryResponse>(decision ? queryKey(`${keyPrefix}/leadership/directory`, { account: account.slug }) : null,
    (signal) => api.leadershipDirectory(account.slug, signal), [api, account.slug])
  if (q.error) return <LoadError error={q.error} onRetry={q.refetch} />
  if (!q.data) return <Skeleton height={420} />
  const { totals: t, sites, as_of: asOf } = q.data
  if (!sites.length) return <Empty>No sites mapped to this account.</Empty>
  return <>
    <div className="kpi-lg">
      <Kpi label="Sites" value={t.sites.toLocaleString('en-US')} sub={`${t.active} active`} />
      <Kpi label="Self-perform" value={t.self_perform.toLocaleString('en-US')} />
      <Kpi label="Subcontracted" value={t.subcontracted.toLocaleString('en-US')} sub={t.unassigned ? `${t.unassigned} unassigned` : undefined} />
      <Kpi label="Sites with hours, 28d" value={t.working.toLocaleString('en-US')} />
      <Kpi label="Hours, 28d" value={hours(t.hours_28d)} sub={`${t.employees_28d} employees`} />
    </div>
    <div className="card">
      <div className="ct"><span>Directory</span>{asOf && <span className="muted">WinTeam, {new Date(asOf).toLocaleDateString('en-US')}</span>}</div>
      <SortTable caption="Directory" rows={sites} columns={COLUMNS} defaultSort={{ key: 'job', dir: 1 }} csvName={`${account.slug}-directory`} />
    </div>
  </>
}
