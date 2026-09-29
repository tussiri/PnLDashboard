import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { AllocationMonth, AllocationSettings, AllocationStatus } from '../../services/apiTypes'
import { money, pct } from '../format'
import { monthLabel } from '../routes'
import { useLeadership } from '../state'
import { Empty, LoadError, Skeleton } from '../ui'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const source = (s: string | null) => (s == null ? '–' : s === 'manual' ? 'Manual' : s === 'statement' ? 'Income statement' : `Income statement, ${monthLabel(`${s.slice(-7)}-01`)}`)
const lines = (text: string) => text.split(',').map((x) => x.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')).filter(Boolean)

function MonthRow({ m, onSaved }: { m: AllocationMonth; onSaved: (message: { ok: boolean; text: string }) => void }) {
  const { adminApi: api } = useLeadership()
  const [rate, setRate] = useState(m.manual_burden_rate == null ? '' : String(Math.round(m.manual_burden_rate * 10000) / 100))
  const [pool, setPool] = useState(m.manual_overhead_pool == null ? '' : String(m.manual_overhead_pool))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await api.updateAllocationMonth(m.month, { burden_rate: rate === '' ? null : Number(rate) / 100, overhead_pool: pool === '' ? null : Number(pool) })
      onSaved({ ok: true, text: `Saved ${monthLabel(m.month)}` })
    } catch (e) { onSaved({ ok: false, text: errorText(e) }) } finally { setBusy(false) }
  }
  const id = `alloc-${m.month}`
  return <tr>
    <td className="l">{monthLabel(m.month)}</td>
    <td className="l">{m.statement_loaded ? 'Loaded' : <span className="neutral">Not loaded</span>}</td>
    <td>{m.management_wages == null ? '–' : money(m.management_wages)}</td>
    <td>{pct(m.burden_rate)}</td><td className="l neutral">{source(m.burden_source)}</td>
    <td><label className="sr-only" htmlFor={`${id}-rate`}>Manual burden % for {monthLabel(m.month)}</label>
      <input id={`${id}-rate`} type="number" step="0.1" min="0" max="99" placeholder="%" value={rate} onChange={(e) => setRate(e.target.value)} /></td>
    <td>{m.overhead_pool == null ? '–' : money(m.overhead_pool)}</td><td className="l neutral">{source(m.overhead_source)}</td>
    <td><label className="sr-only" htmlFor={`${id}-pool`}>Manual overhead for {monthLabel(m.month)}</label>
      <input id={`${id}-pool`} type="number" step="100" min="0" placeholder="$" value={pool} onChange={(e) => setPool(e.target.value)} style={{ width: 110 }} /></td>
    <td><button type="button" className="btn sm" disabled={busy} onClick={save}>Save</button></td>
  </tr>
}

/** Admin > Allocations: which corporate allocations apply, where their numbers come from, and manual months. */
export function AllocationsTab() {
  const { adminApi: api, apiReachable } = useLeadership()
  const [status, setStatus] = useState<AllocationStatus | null>(null)
  const [draft, setDraft] = useState<AllocationSettings | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    setError(null)
    api.allocationStatus().then((s) => { setStatus(s); setDraft(s.settings) }).catch(setError)
  }, [api])
  useEffect(() => { if (apiReachable) load() }, [apiReachable, load])
  if (!apiReachable) return <Empty>API unreachable.</Empty>
  if (error) return <LoadError error={error} onRetry={load} />
  if (!status || !draft) return <Skeleton height={300} />
  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try { const r = await api.updateAllocationSettings(draft); setDraft(r.settings); setMessage({ ok: true, text: 'Saved allocation settings' }); load() }
    catch (err) { setMessage({ ok: false, text: errorText(err) }) } finally { setBusy(false) }
  }
  const toggle = (kind: keyof AllocationSettings) => setDraft({ ...draft, [kind]: { ...draft[kind], enabled: !draft[kind].enabled } })
  return <>
    <div className="card">
      <div className="ct"><span>Allocations</span></div>
      <form className="form-grid" onSubmit={save}>
        <label className="field check"><input type="checkbox" checked={draft.management_wages.enabled} onChange={() => toggle('management_wages')} />Management wages (GL 40200)</label>
        <label className="field check"><input type="checkbox" checked={draft.burden.enabled} onChange={() => toggle('burden')} />Payroll burden</label>
        <label className="field"><span>Burden lines</span><input type="text" value={draft.burden.lines.join(', ')} onChange={(e) => setDraft({ ...draft, burden: { ...draft.burden, lines: lines(e.target.value) } })} /></label>
        <label className="field check"><input type="checkbox" checked={draft.overhead.enabled} onChange={() => toggle('overhead')} />Overhead</label>
        <label className="field"><span>Overhead lines</span><input type="text" value={draft.overhead.lines.join(', ')} onChange={(e) => setDraft({ ...draft, overhead: { ...draft.overhead, lines: lines(e.target.value) } })} /></label>
        <label className="field"><span>Spread overhead by</span><select value={draft.overhead.basis} onChange={(e) => setDraft({ ...draft, overhead: { ...draft.overhead, basis: e.target.value as AllocationSettings['overhead']['basis'] } })}>
          <option value="revenue">Revenue</option><option value="labor">Labor $</option><option value="hours">Hours</option></select></label>
        <div className="field"><button type="submit" className="btn primary" disabled={busy}>Save</button></div>
      </form>
      {message && <p className={`msg ${message.ok ? 'ok' : 'bad'}`} role="status">{message.text}</p>}
    </div>
    <div className="card">
      <div className="ct"><span>By month</span></div>
      <div className="tw"><table><caption className="sr-only">Allocations by month</caption>
        <thead><tr><th className="nosort l">Month</th><th className="nosort l">Statement</th><th className="nosort">Mgmt wages</th><th className="nosort">Burden %</th><th className="nosort l">Source</th>
          <th className="nosort">Manual %</th><th className="nosort">Overhead</th><th className="nosort l">Source</th><th className="nosort">Manual $</th><th className="nosort"></th></tr></thead>
        <tbody>{[...status.months].reverse().map((m) => <MonthRow key={`${m.month}-${m.manual_burden_rate}-${m.manual_overhead_pool}`} m={m} onSaved={(r) => { setMessage(r); load() }} />)}</tbody>
      </table></div>
    </div>
  </>
}
