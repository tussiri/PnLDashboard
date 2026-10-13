import { useEffect, useMemo, useState } from 'react'
import { useApiQuery } from '../../hooks/useApiQuery'
import { ApiError } from '../../services/api'
import type { SchoolCalendarResponse, SchoolDay, SchoolDayType, SchoolDistrict } from '../../services/apiTypes'
import { queryClient, queryKey } from '../../services/queryClient'
import { SCHOOL_DAY_LABEL, SCHOOL_DAY_TYPES as TYPES } from '../data'
import { useLeadership } from '../state'
import { Empty, LoadError, Skeleton, SortTable, type Column } from '../ui'

const TONE: Record<SchoolDayType, string> = { school: '', early_release: 'neutral', staff_only: 'warn', holiday: 'bad', summer: 'neutral' }
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const dayName = (iso: string) => WEEKDAY[new Date(`${iso}T00:00:00Z`).getUTCDay()]
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Admin > School calendars: each district's calendar link and last read, and day overrides that survive re-reads. */
export function SchoolCalendarsAdmin() {
  const { adminApi: api, adminKeyPrefix: keyPrefix, decision } = useLeadership()
  const list = useApiQuery<{ districts: SchoolDistrict[] }>(decision ? queryKey(`${keyPrefix}/leadership/school-calendars`) : null, (signal) => api.schoolCalendars(signal), [api])
  const districts = list.data?.districts ?? []
  const [slug, setSlug] = useState('')
  const account = slug || districts[0]?.account || ''
  const district = districts.find((d) => d.account === account)
  const q = useApiQuery<SchoolCalendarResponse>(decision && account ? queryKey(`${keyPrefix}/leadership/school-calendar`, { account }) : null,
    (signal) => api.schoolCalendar(account, signal), [api, account])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [url, setUrl] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [all, setAll] = useState(false)
  const [draft, setDraft] = useState<{ date: string; day_type: SchoolDayType; label: string }>({ date: '', day_type: 'holiday', label: '' })
  useEffect(() => { setUrl(district?.url && district.url !== district.default_url ? district.url : ''); setEnabled(district?.enabled ?? true) }, [district])
  /** A refresh refused by the weekly refresh pause (423) asks once whether to run it anyway. */
  const run = async (done: (r: unknown) => string, fn: (overridePause: boolean) => Promise<unknown>) => {
    setBusy(true); setMessage(null)
    try {
      let result: unknown
      try { result = await fn(false) }
      catch (e) {
        if (!(e instanceof ApiError && e.status === 423)) throw e
        if (!window.confirm(`${e.detail}\n\nRun it anyway?`)) { setMessage({ ok: false, text: e.detail }); return }
        result = await fn(true)
      }
      setMessage({ ok: true, text: done(result) }); queryClient.invalidate(); list.refetch(); q.refetch()
    }
    catch (e) { setMessage({ ok: false, text: errorText(e) }); list.refetch() }
    finally { setBusy(false) }
  }
  const loaded = (r: unknown) => {
    const x = r as { status: string; school_year: number | null; days: number | null; days_off?: number }
    const year = x.school_year ? `${x.school_year}-${String((x.school_year + 1) % 100).padStart(2, '0')}` : ''
    return x.status === 'unchanged' ? `${year} calendar unchanged` : `${year} calendar read: ${x.days} weekdays, ${x.days_off ?? 0} closed or staff only`
  }
  const days = q.data?.days ?? []
  const shown = useMemo(() => (all ? days : days.filter((d) => d.source === 'manual' || (d.day_type !== 'school' && d.day_type !== 'summer'))), [days, all])
  const cols: Column<SchoolDay>[] = [
    { key: 'd', header: 'Date', left: true, value: (d) => d.date, render: (d) => `${dayName(d.date)} ${d.date}` },
    { key: 't', header: 'Day', left: true, value: (d) => d.day_type, render: (d) => <span className={TONE[d.day_type]}>{SCHOOL_DAY_LABEL[d.day_type]}</span> },
    { key: 'l', header: 'Calendar', left: true, value: (d) => d.label ?? '', className: 'nm' },
    { key: 's', header: 'Source', left: true, value: (d) => d.source,
      render: (d) => (d.source === 'manual' ? `Override${d.updated_by ? `, ${d.updated_by}` : ''}${d.scraped ? `; calendar says ${SCHOOL_DAY_LABEL[d.scraped.day_type].toLowerCase()}` : ''}` : 'District calendar'), className: 'neutral' },
    { key: 'a', header: '', left: true, value: () => '',
      render: (d) => (d.source === 'manual'
        ? <button type="button" className="linkbtn" disabled={busy} onClick={() => void run(() => `${d.date} back to the district calendar`, () => api.revertSchoolDay(account, d.date))}>Revert</button>
        : <button type="button" className="linkbtn" disabled={busy} onClick={() => setDraft({ date: d.date, day_type: d.day_type, label: d.label ?? '' })}>Override</button>) },
  ]
  if (list.error) return <LoadError error={list.error} onRetry={list.refetch} />
  if (!list.data) return <Skeleton height={240} />
  if (!districts.length) return <Empty>No school district accounts.</Empty>
  const src = q.data?.source ?? district
  const year = src?.school_year ? `${src.school_year}-${String((src.school_year + 1) % 100).padStart(2, '0')}` : null
  return <>
    <div className="card">
      <div className="ct"><span>School calendar</span><span className="ks">{src?.last_checked_at ? `Checked ${when(src.last_checked_at)}` : 'Not read yet'}{src?.last_changed_at ? `; changed ${when(src.last_changed_at)}` : ''}</span></div>
      <div className="form-grid">
        <label className="field"><span>District</span><select value={account} onChange={(e) => { setSlug(e.target.value); setMessage(null) }}>
          {districts.map((d) => <option key={d.account} value={d.account}>{d.name}</option>)}</select></label>
        <label className="field wide"><span>Calendar link (PDF or page)</span>
          <input type="url" value={url} placeholder={district?.default_url ?? ''} onChange={(e) => setUrl(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Read nightly</label>
      </div>
      <div className="ctrl">
        <button type="button" className="btn" disabled={busy} onClick={() => void run(() => 'Calendar link saved', () => api.saveSchoolSource(account, { url: url.trim() || null, enabled }))}>Save link</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void run(loaded, (o) => api.refreshSchoolCalendar(account, undefined, { overridePause: o }))}>Read calendar now</button>
        <label className="btn"><input type="file" accept=".pdf,.html,.htm,.txt" hidden disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run(loaded, (o) => api.uploadSchoolCalendar(account, f, undefined, { overridePause: o })) }} />Upload calendar file</label>
        <span className="ks">{year ? `${year}, ${src?.days_found ?? 0} weekdays` : ''}</span>
        {src?.last_status === 'failed' && <span className="bad ks">{src.last_error}</span>}
      </div>
      {message && <p className={`msg ${message.ok ? 'ok' : 'bad'}`} role="status">{message.text}</p>}
    </div>
    <div className="card">
      <div className="ct"><span>Override a day</span></div>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (draft.date) void run(() => `${draft.date} saved as ${SCHOOL_DAY_LABEL[draft.day_type].toLowerCase()}`, () => api.saveSchoolDays(account, [{ date: draft.date, day_type: draft.day_type, label: draft.label.trim() || null }])) }}>
        <label className="field"><span>Date</span><input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} /></label>
        <label className="field"><span>Day</span><select value={draft.day_type} onChange={(e) => setDraft({ ...draft, day_type: e.target.value as SchoolDayType })}>
          {TYPES.map((t) => <option key={t} value={t}>{SCHOOL_DAY_LABEL[t]}</option>)}</select></label>
        <label className="field wide"><span>Label</span><input value={draft.label} maxLength={120} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
        <div className="field"><button type="submit" className="btn primary" disabled={busy || !draft.date}>Save override</button></div>
      </form>
    </div>
    <div className="card">
      <div className="ct"><span>{district?.name ?? account}{year ? `, ${year}` : ''}</span>
        <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />All weekdays</label></div>
      {q.error ? <LoadError error={q.error} onRetry={q.refetch} /> : !q.data ? <Skeleton height={200} /> : !shown.length ? <Empty>No calendar loaded.</Empty>
        : <SortTable caption="School calendar days" rows={shown} columns={cols} defaultSort={{ key: 'd', dir: 1 }} pageSize={all ? 25 : 60} csvName={`${account}-school-calendar`} />}
    </div>
  </>
}
