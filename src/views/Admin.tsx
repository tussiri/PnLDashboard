import { CheckCircle2, DatabaseZap, KeyRound, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { QueryCard } from '../components/CardState'
import { DataGrid, type Column } from '../components/DataGrid'
import { useDashboard } from '../context/DashboardContext'
import { useAuth } from '../auth/useAuth'
import { hasAdminToken, setAdminToken } from '../services/api'
import type { AppSetting, FinanceReferenceStatus, FullSyncResult, IntegrationStatus, SarusStatus, SettingsResponse, SyncRun, SyncRunsResponse } from '../services/apiTypes'
import { LiveApi } from '../services/dataSource'
import { monthLabel } from '../services/period'
import { queryClient } from '../services/queryClient'
import type { ServiceType } from '../types'
import { errorMessage, fmtDate, fmtDateTime, number, relativeTime, sum } from '../utils'
import { DemoNotice, Note, useReportQuery } from './shared'

const syncSummary = (r: FullSyncResult) => {
  const skipped = r.runs.filter((run) => run.status === 'skipped').length
  const failed = r.runs.filter((run) => run.status === 'failed').length
  return [`${r.runs.length - skipped} synced`, skipped ? `${skipped} skipped` : '', failed ? `${failed} failed` : '', r.marts ? `${number(r.marts.job_month_rows)} job-month rows · ${r.marts.seconds.toFixed(1)}s` : 'marts unchanged'].filter(Boolean).join(' · ')
}

const isRunning = (run: SyncRun) => /running|started|pending|in_progress/i.test(run.status) || (!run.completed_at && !run.error_message)

export function Admin() {
  const { api, mode, decision, toast, verticalLabels, setVerticalLabels, refreshStatus, redetectMode } = useDashboard()
  const { user, backend } = useAuth()
  // An administrator session satisfies the API on its own; the token is only needed for other roles or scripts.
  const adminSession = backend === 'api' && user?.role === 'admin'
  // When the API is up but the marts are empty the app runs on demo data, yet admin calls must still reach the real API
  // (that is exactly when "Load real data" is needed). Reporting stays on the demo adapter until redetectMode() flips it.
  const apiReachable = mode === 'live' || decision.reason === 'marts_empty'
  const adminApi = mode === 'live' ? api : LiveApi
  const [token, setToken] = useState('')
  const [armed, setArmed] = useState(hasAdminToken())
  const [busy, setBusy] = useState<string | null>(null)
  const [resource, setResource] = useState('')
  const [deep, setDeep] = useState(false)
  const [force, setForce] = useState(false)
  const integration = useReportQuery<IntegrationStatus>('integrations/winteam', (api, signal) => api.integrationStatus(signal))
  const sarus = useReportQuery<SarusStatus>('integrations/winteam/sarus', (api, signal) => api.sarusStatus(signal))
  const finance = useReportQuery<FinanceReferenceStatus>('integrations/finance-reference', (api, signal) => (apiReachable ? adminApi : api).financeReference(signal))
  const runs = useReportQuery<SyncRunsResponse>('integrations/winteam/runs', (api, signal) => api.syncRuns(25, signal))
  const settings = useReportQuery<SettingsResponse>('settings', (api, signal) => api.settings(signal))
  const anyRunning = useMemo(() => (runs.data?.runs ?? []).some(isRunning), [runs.data])
  useEffect(() => {
    if (!anyRunning && !busy) return
    const timer = window.setInterval(() => runs.refetch(), 15_000)
    return () => window.clearInterval(timer)
  }, [anyRunning, busy, runs])
  const canAct = apiReachable && (armed || adminSession)
  const arm = () => { setAdminToken(token); setArmed(hasAdminToken()); setToken(''); toast('info', hasAdminToken() ? 'Admin token set for this tab' : 'Admin token cleared', 'Held in memory only; it is never stored.') }
  const act = async (name: string, run: () => Promise<string>) => {
    setBusy(name)
    try { const detail = await run(); toast('success', `${name} finished`, detail); queryClient.invalidate(); if (mode === 'live') refreshStatus(); else await redetectMode() }
    catch (error) { toast('error', `${name} failed`, errorMessage(error)) }
    finally { setBusy(null) }
  }
  const runColumns: Column<SyncRun>[] = [
    { key: 'id', header: 'Run', render: (r) => <span className="num">{String(r.id)}</span> },
    { key: 'resource_name', header: 'Resource', render: (r) => <strong>{r.resource_name}</strong> },
    { key: 'status', header: 'Status', render: (r) => <span className={`source-state source-state--${isRunning(r) ? 'running' : /fail|error/i.test(r.status) ? 'failed' : 'ready'}`}>{isRunning(r) && <RefreshCw size={10} className="spin" />}{r.status}</span> },
    { key: 'started_at', header: 'Started', render: (r) => <>{fmtDateTime(r.started_at)}<span className="muted"> · {relativeTime(r.started_at)}</span></>, csv: (r) => r.started_at },
    { key: 'completed_at', header: 'Completed', render: (r) => fmtDateTime(r.completed_at), csv: (r) => r.completed_at },
    { key: 'records_fetched', header: 'Fetched', numeric: true, render: (r) => number(r.records_fetched) },
    { key: 'records_inserted', header: 'Inserted', numeric: true, render: (r) => number(r.records_inserted) },
    { key: 'error_message', header: 'Error', render: (r) => (r.error_message ? <span className="text-bad">{r.error_message}</span> : <span className="muted">—</span>) },
  ]
  return <>
    <DemoNotice>{decision.reason === 'marts_empty' ? 'API reachable, marts empty: views show demo data; admin actions call the real API.' : 'API unreachable: admin actions are disabled.'}</DemoNotice>
    <div className="dashboard-grid">
      <QueryCard title="WinTeam integration" subtitle="Server-side connector status · credentials never reach the browser" className="span-7" query={integration} skeleton="text" isEmpty={() => false}>{(s) => <div className="integration-status"><div className="integration-status__flags"><span className={`source-state source-state--${s.enabled ? 'ready' : 'mocked'}`}>{s.enabled ? 'Enabled' : 'Disabled'}</span><span className={`source-state source-state--${s.configured ? 'ready' : 'mocked'}`}>{s.configured ? 'Configured' : 'Not configured'}</span><span className="muted">Host: <b className="num">{s.base_url_host ?? '—'}</b></span><span className="muted">Sync: <b>on demand</b></span><span className={`source-state source-state--${sarus.data?.ingestion ? 'ready' : 'mocked'}`}>Sarus {sarus.data?.ingestion ? 'enabled' : 'disabled'}</span></div><table className="mini-table"><thead><tr><th>Resource</th><th>Kind</th><th>Enabled</th><th>Entitled</th><th>Last status</th><th>Completed</th><th className="align-right">Records</th><th>Watermark</th></tr></thead><tbody>{s.resources.map((r) => <tr key={r.name}><td><strong>{r.name}</strong></td><td>{r.kind}</td><td>{r.enabled ? 'yes' : 'no'}</td><td>{r.entitled === false ? 'no (403)' : r.entitled ? 'yes' : '—'}</td><td>{r.last_status ?? '—'}</td><td>{fmtDateTime(r.last_completed_at)}</td><td className="align-right num">{number(r.records_fetched)}</td><td className="num">{r.watermark ?? '—'}</td></tr>)}{!s.resources.length && <tr><td colSpan={8} className="muted">No resources configured (WINTEAM_RESOURCES is empty).</td></tr>}</tbody></table></div>}</QueryCard>
      <section className="chart-card span-5 admin-panel" aria-label="Admin operations">
        <header className="chart-card__header"><div className="chart-card__heading"><h2>Protected operations</h2><p>X-Admin-Token · in-memory only</p></div>{armed && <span className="admin-armed"><CheckCircle2 size={13} />Token set</span>}</header>
        <div className="chart-card__body admin-ops">
          <form className="token-form" onSubmit={(e) => { e.preventDefault(); arm() }}><label><KeyRound size={14} aria-hidden="true" /><input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={armed ? 'Replace token…' : 'Ingestion admin token'} autoComplete="off" aria-label="Admin token" /></label><button type="submit" className="secondary-button" disabled={!apiReachable}>{armed && !token ? 'Clear' : 'Use token'}</button></form>
          <div className="admin-buttons">
            <button className="secondary-button" disabled={!canAct || !!busy} onClick={() => act('Connection test', async () => { const r = await adminApi.testConnection(); return `${r.ok ? 'OK' : 'Failed'} · ${r.resource} · ${r.records_in_probe} records in probe${r.total_count !== null ? ` of ${r.total_count}` : ''}` })}>{busy === 'Connection test' && <RefreshCw size={13} className="spin" />}Test connection</button>
            <button className="primary-button" disabled={!canAct || !!busy} onClick={() => act('Full sync', async () => syncSummary(await adminApi.syncAll({ deep, force })))}>{busy === 'Full sync' && <RefreshCw size={13} className="spin" />}Sync all</button>
            <button className="secondary-button" disabled={!canAct || !!busy || !sarus.data?.ingestion} onClick={() => act('Sarus sync', async () => syncSummary(await adminApi.syncSarus({ deep, force })))}>{busy === 'Sarus sync' && <RefreshCw size={13} className="spin" />}Sync Sarus</button>
            <label className="admin-check"><input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} disabled={!canAct} />Re-read 35 days</label>
            <label className="admin-check"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} disabled={!canAct} />Refresh daily resources</label>
            <div className="admin-resource"><select value={resource} onChange={(e) => setResource(e.target.value)} aria-label="Resource to sync" disabled={!canAct}><option value="">Resource…</option>{(integration.data?.resources ?? []).map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}</select><button className="secondary-button" disabled={!canAct || !resource || !!busy} onClick={() => act(`Sync ${resource}`, async () => { const r = await adminApi.syncResource(resource); return `${r.status} · fetched ${r.fetched} · inserted ${r.inserted} · normalized ${r.normalized}` })}>Sync resource</button><button className="text-button" title="Forget the incremental watermark so the next sync backfills the full history (raw records are kept; replays are idempotent)" disabled={!canAct || !resource || !!busy} onClick={() => { if (window.confirm(`Reset the ${resource} watermark? The next sync re-pulls its full backfill window.`)) act(`Reset ${resource} watermark`, async () => { const r = await adminApi.resetWatermark(resource); return r.watermark_removed ? 'Watermark removed · next sync backfills' : 'No watermark existed · next sync backfills' }) }}>Reset watermark</button></div>
            <button className="secondary-button" disabled={!canAct || !!busy} onClick={() => act('Mart rebuild', async () => { const r = await adminApi.rebuildMarts(); return `${r.job_month_rows} job-month rows · ${r.portfolio_month_rows} portfolio rows · ${r.seconds.toFixed(1)}s` })}>{busy === 'Mart rebuild' && <RefreshCw size={13} className="spin" />}Rebuild marts</button>
            <button className="secondary-button" disabled={!canAct || !!busy} onClick={() => act('Forecast rebuild', async () => { const r = await adminApi.rebuildForecasts(); return `${r.sites_forecast} sites forecast · ${r.forecast_rows} rows · run ${r.run_id}` })}>{busy === 'Forecast rebuild' && <RefreshCw size={13} className="spin" />}Rebuild forecasts</button>
          </div>
          <Note>{apiReachable ? (canAct ? (armed ? 'Actions call the API with your token; results appear as toasts.' : 'Actions run with your administrator session; results appear as toasts.') : 'Enter the INGESTION_ADMIN_TOKEN to enable these actions.') : 'Unavailable while the API is unreachable.'}</Note>
        </div>
      </section>
    </div>
    <div className="dashboard-grid">
      <QueryCard title="Finance reference (WinTeam exports)" subtitle="Real historical report exports restored into the finance_reference database · read-only source" className="span-7" query={finance} skeleton="text" isEmpty={() => false}>{(f) => <div className="integration-status">
        <div className="integration-status__flags"><span className={`source-state source-state--${f.configured ? 'ready' : 'mocked'}`}>{f.configured ? 'Configured' : 'Not configured'}</span><span className="muted">Database host: <b className="num">{f.database_host ?? '—'}</b></span>{f.last_load && <span className={`source-state source-state--${/fail|error/i.test(f.last_load.status) ? 'failed' : /run|pending/i.test(f.last_load.status) ? 'running' : 'ready'}`}>Last load {f.last_load.status}</span>}</div>
        {f.reference ? <dl className="finance-ref__coverage"><div><dt>Job-cost P&L months</dt><dd className="num">{f.reference.job_cost_months?.[0] ? monthLabel(f.reference.job_cost_months[0]) : '—'} – {f.reference.job_cost_months?.[1] ? monthLabel(f.reference.job_cost_months[1]) : '—'}</dd></div><div><dt>Timekeeping through</dt><dd className="num">{fmtDate(f.reference.timekeeping_max_date)}</dd></div><div><dt>AR aging snapshot</dt><dd className="num">{fmtDate(f.reference.ar_snapshot_date)}</dd></div><div><dt>AP aging snapshot</dt><dd className="num">{fmtDate(f.reference.ap_snapshot_date)}</dd></div></dl> : <Note>{f.configured ? 'Reference coverage is not available (the reference database has not been probed yet).' : 'Set FINANCE_REFERENCE_DATABASE_URL on the API to enable this source.'}</Note>}
        {f.last_load ? <table className="mini-table"><thead><tr><th>Last load</th><th>Started</th><th>Completed</th><th>Table</th><th className="align-right">Rows</th></tr></thead><tbody>{(f.last_load.tables.length ? f.last_load.tables : [{ name: '—', rows: 0 }]).map((t, i) => <tr key={t.name}>{i === 0 ? <><td rowSpan={Math.max(1, f.last_load!.tables.length)} className="num">run {String(f.last_load!.run_id)}</td><td rowSpan={Math.max(1, f.last_load!.tables.length)}>{fmtDateTime(f.last_load!.started_at)}</td><td rowSpan={Math.max(1, f.last_load!.tables.length)}>{fmtDateTime(f.last_load!.completed_at)}</td></> : null}<td>{t.name}</td><td className="align-right num">{number(t.rows)}</td></tr>)}</tbody></table> : <Note>No load has run yet.</Note>}
      </div>}</QueryCard>
      <section className="chart-card span-5 admin-panel" aria-label="Load real data">
        <header className="chart-card__header"><div className="chart-card__heading"><h2>Load real data</h2><p>POST /integrations/finance-reference/load · full replace</p></div></header>
        <div className="chart-card__body admin-ops">
          <p className="inline-note"><span>Copies the restored WinTeam exports (job master, job-cost P&L, timekeeping, AR and AP aging) into the warehouse and rebuilds the marts. It first clears any data from other sources, the WinTeam API sync and the synthetic simulator included, so the warehouse holds one coherent source. Settings are kept. Expect several minutes.</span></p>
          <div className="admin-buttons">
            <button className="primary-button" disabled={!canAct || !!busy || finance.data?.configured === false} onClick={() => { if (window.confirm('Load real data from the finance reference database?\n\nThis REPLACES any other source\'s data in the warehouse (WinTeam API syncs and simulator data included) and rebuilds the marts. Settings are kept. The load can take several minutes.')) act('Finance reference load', async () => { const r = await adminApi.loadFinanceReference(); return `run ${r.run_id} · ${r.tables.length} tables · ${number(sum(r.tables, (t) => t.rows))} rows · ${number(r.marts.job_month_rows)} job-month rows · ${r.seconds.toFixed(0)}s` }) }}>{busy === 'Finance reference load' ? <RefreshCw size={13} className="spin" /> : <DatabaseZap size={13} />}Load real data</button>
            <button className="text-button" onClick={() => finance.refetch()}><RefreshCw size={13} className={finance.fetching ? 'spin' : ''} />Refresh status</button>
          </div>
          <Note>{finance.data?.configured === false ? 'The finance reference source is not configured on the API.' : canAct ? 'The request waits up to 15 minutes and reports the loaded tables as a toast.' : 'Requires the admin token' + (apiReachable ? '.' : ' and a reachable API.')}</Note>
        </div>
      </section>
    </div>
    <QueryCard title="Sync runs" subtitle={`Last 25 · ${anyRunning ? 'auto-refreshing every 15s while a run is active' : 'refreshes on demand'}`} query={runs} skeleton="table" isEmpty={(r) => !r.runs.length} emptyTitle="No sync runs" emptyHint="Nothing has been synced yet." action={<button type="button" className="text-button" onClick={() => runs.refetch()}><RefreshCw size={13} className={runs.fetching ? 'spin' : ''} />Refresh</button>}>{(r) => <DataGrid rows={r.runs} columns={runColumns} rowKey={(row) => String(row.id)} defaultSort={{ key: 'started_at', dir: 'desc' }} csvName="sync-runs" dense maxHeight={420} />}</QueryCard>
    <QueryCard title="Operational settings" subtitle="ops.app_setting · PUT /settings/{key} · confirm before saving" query={settings} skeleton="table" isEmpty={(s) => !s.settings.length} emptyTitle="No settings">{(s) => <SettingsEditor settings={s.settings} canEdit={canAct} onSave={async (key, value) => { await adminApi.updateSetting(key, value); queryClient.invalidate(`${mode}/settings`); toast('success', `Saved ${key}`, `New value: ${String(value)}`) }} />}</QueryCard>
    <VerticalLabelsEditor labels={verticalLabels} onSave={setVerticalLabels} />
  </>
}

function SettingsEditor({ settings, canEdit, onSave }: { settings: AppSetting[]; canEdit: boolean; onSave: (key: string, value: AppSetting['value']) => Promise<void> }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const parse = (setting: AppSetting, raw: string): AppSetting['value'] => (typeof setting.value === 'number' ? Number(raw) : typeof setting.value === 'boolean' ? raw === 'true' : raw)
  const structured = (s: AppSetting) => s.value !== null && typeof s.value === 'object'
  const save = async (setting: AppSetting) => {
    setSaving(setting.key); setError(null)
    try { await onSave(setting.key, parse(setting, drafts[setting.key])); setDrafts((d) => { const next = { ...d }; delete next[setting.key]; return next }); setConfirm(null) }
    catch (e) { setError(errorMessage(e)) }
    finally { setSaving(null) }
  }
  return <div className="settings-editor">
    {error && <div className="card-state card-state--error card-state--compact" role="alert"><strong>Save failed</strong><span>{error}</span></div>}
    <table className="mini-table"><thead><tr><th>Key</th><th>Value</th><th>Description</th><th>Updated</th><th /></tr></thead><tbody>{settings.map((s) => { const draft = drafts[s.key]; const dirty = draft !== undefined && draft !== String(s.value ?? ''); const type = typeof s.value; return <tr key={s.key}><td><strong className="num">{s.key}</strong></td><td>{structured(s) ? <code className="json-cell" title="Structured setting · edit through the API">{JSON.stringify(s.value)}</code> : type === 'boolean' ? <select value={draft ?? String(s.value)} disabled={!canEdit} onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))}><option value="true">true</option><option value="false">false</option></select> : <input className="num" type={type === 'number' ? 'number' : 'text'} step={type === 'number' ? 'any' : undefined} value={draft ?? String(s.value ?? '')} disabled={!canEdit} onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))} aria-label={s.key} />}</td><td className="muted">{s.description ?? ''}</td><td className="muted">{fmtDateTime(s.updated_at)}</td><td className="align-right">{confirm === s.key ? <span className="confirm-inline"><span>Save <b className="num">{draft}</b>?</span><button type="button" className="primary-button" disabled={saving === s.key} onClick={() => save(s)}>Confirm</button><button type="button" className="text-button" onClick={() => setConfirm(null)}>Cancel</button></span> : <button type="button" className="text-button" disabled={!dirty || !canEdit || structured(s)} onClick={() => setConfirm(s.key)}>Save</button>}</td></tr> })}</tbody></table>
    {!canEdit && <Note>Editing requires live mode and an administrator session or the admin token.</Note>}
  </div>
}

function VerticalLabelsEditor({ labels, onSave }: { labels: Record<ServiceType, string>; onSave: (labels: Record<ServiceType, string>) => void }) {
  const [draft, setDraft] = useState(labels)
  const [saved, setSaved] = useState(false)
  useEffect(() => setDraft(labels), [labels])
  const dirty = (Object.keys(labels) as ServiceType[]).some((key) => draft[key] !== labels[key])
  return <section className="chart-card" aria-label="Service type labels">
    <header className="chart-card__header"><div className="chart-card__heading"><h2>Service type display labels</h2><p>Browser preference used in filters and charts · does not change mart values</p></div><div className="admin-actions">{saved && <span role="status"><CheckCircle2 size={13} />Saved in this browser</span>}<button className="secondary-button" disabled={!dirty} onClick={() => setDraft(labels)}>Cancel</button><button className="primary-button" disabled={!dirty} onClick={() => { onSave(draft); setSaved(true) }}>Save labels</button></div></header>
    <div className="chart-card__body"><div className="vertical-editor">{(Object.keys(draft) as ServiceType[]).map((key) => <label key={key}><span>{key}</span><input value={draft[key]} onChange={(e) => { setDraft({ ...draft, [key]: e.target.value }); setSaved(false) }} /></label>)}</div><div className="admin-audit-note">Local preference · stored in this browser · no production audit record</div></div>
  </section>
}
