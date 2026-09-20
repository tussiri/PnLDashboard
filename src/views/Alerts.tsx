import { AlertTriangle, ArrowUpRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { QueryCard } from '../components/CardState'
import { useDashboard } from '../context/DashboardContext'
import type { AlertRow, AlertsResponse } from '../services/apiTypes'
import { DemoNotice, rangeSubtitle, ScopeLine, useReportingParams, useReportQuery } from './shared'

export function Alerts() {
  const { query, params } = useReportingParams()
  const { openJob } = useDashboard()
  const alerts = useReportQuery<AlertsResponse>('alerts', (api, signal) => api.alerts(query, signal), params)
  const [severity, setSeverity] = useState<'all' | 'critical' | 'watch'>('all')
  const [type, setType] = useState('')
  const rows = alerts.data?.alerts ?? []
  const types = useMemo(() => [...new Set(rows.map((a) => a.type))].sort(), [rows])
  const filtered = rows.filter((a) => (severity === 'all' || a.severity === severity) && (!type || a.type === type))
  const groups: { key: AlertRow['severity']; label: string; rows: AlertRow[] }[] = [
    { key: 'critical', label: 'Critical', rows: filtered.filter((a) => a.severity === 'critical') },
    { key: 'watch', label: 'Watch', rows: filtered.filter((a) => a.severity === 'watch') },
  ]
  const counts = { critical: rows.filter((a) => a.severity === 'critical').length, watch: rows.filter((a) => a.severity === 'watch').length }
  return <>
    <ScopeLine />
    <DemoNotice>Exceptions are computed from seeded rows with the live thresholds.</DemoNotice>
    <div className="toolbar-row">
      <div className="segmented" role="group" aria-label="Severity"><button className={severity === 'all' ? 'active' : ''} onClick={() => setSeverity('all')}>All <b>{rows.length}</b></button><button className={severity === 'critical' ? 'active' : ''} onClick={() => setSeverity('critical')}>Critical <b>{counts.critical}</b></button><button className={severity === 'watch' ? 'active' : ''} onClick={() => setSeverity('watch')}>Watch <b>{counts.watch}</b></button></div>
      <label className="inline-select"><span>Type</span><select value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{types.map((t) => <option key={t}>{t}</option>)}</select></label>
    </div>
    {groups.map((group) => (severity === 'all' || severity === group.key) && (
      <QueryCard key={group.key} title={`${group.label} · ${group.rows.length}`} subtitle={rangeSubtitle(alerts.data?.range, 'click to open the site')} query={alerts} skeleton="text" isEmpty={() => !group.rows.length} emptyTitle={`No ${group.label.toLowerCase()} exceptions`} emptyHint="No thresholds tripped for the current filters.">{() => <div className="alert-list">{group.rows.map((a) => <button key={String(a.id)} onClick={() => openJob(a.job_number)}><span className={`alert-icon alert-icon--${a.severity}`}><AlertTriangle size={16} /></span><div><strong>{a.type}</strong><span>{a.job_name} · {a.parent_account} · {a.detail}</span></div><small>{a.branch}</small><ArrowUpRight size={15} /></button>)}</div>}</QueryCard>
    ))}
  </>
}
