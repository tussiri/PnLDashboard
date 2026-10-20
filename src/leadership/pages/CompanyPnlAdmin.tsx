import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { CompanyPnlSettings, CompanyPnlSettingsResponse, PnlAccrualSuggestion, PnlAdjustment, PnlAdjustmentIn, PnlAdjustmentLine, PnlGroupSetting } from '../../services/apiTypes'
import { queryClient } from '../../services/queryClient'
import { money } from '../format'
import { monthLabel } from '../routes'
import { useLeadership } from '../state'
import { Empty, LoadError, Skeleton, SortTable, type Column } from '../ui'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const list = (text: string) => text.split(',').map((x) => x.trim()).filter(Boolean)
const LINES: { value: PnlAdjustmentLine; label: string }[] = [
  { value: 'subcontractors', label: 'Subcontractors' }, { value: 'revenue', label: 'Revenue' }, { value: 'labor', label: 'Labor' },
  { value: 'payroll_taxes', label: 'Payroll taxes' }, { value: 'supplies', label: 'Supplies' }, { value: 'other', label: 'Other' },
]
const STATUS: Record<PnlAdjustment['status'], string> = { active: 'Active', posted: 'Invoice posted', reversed: 'Reversed' }
type Message = { ok: boolean; text: string } | null

function GroupRow({ g, onChange, onRemove }: { g: PnlGroupSetting; onChange: (g: PnlGroupSetting) => void; onRemove: () => void }) {
  return <tr>
    <td className="l"><input aria-label="Group name" value={g.name} onChange={(e) => onChange({ ...g, name: e.target.value })} /></td>
    <td className="l"><input aria-label={`${g.name} accounts`} value={g.accounts.join(', ')} disabled={g.default} placeholder={g.default ? 'Everything else' : 'account slugs'}
      onChange={(e) => onChange({ ...g, accounts: list(e.target.value) })} /></td>
    <td className="l"><select aria-label={`${g.name} delivery model`} value={g.delivery_model ?? ''} disabled={g.default}
      onChange={(e) => onChange({ ...g, delivery_model: (e.target.value || null) as PnlGroupSetting['delivery_model'] })}>
      <option value="">Any</option><option value="subcontracted">Subcontracted</option><option value="self_perform">Self-performed</option></select></td>
    <td><input aria-label={`${g.name} fixed charge`} type="number" min="0" step="1000" value={g.fixed_charge} style={{ width: 100 }} onChange={(e) => onChange({ ...g, fixed_charge: Number(e.target.value) })} /></td>
    <td><input aria-label={`${g.name} account staff`} type="number" min="0" step="1000" value={g.direct_staff} style={{ width: 100 }} onChange={(e) => onChange({ ...g, direct_staff: Number(e.target.value) })} /></td>
    <td><input aria-label={`${g.name} shares the pool`} type="checkbox" checked={g.shares_pool} onChange={(e) => onChange({ ...g, shares_pool: e.target.checked })} /></td>
    <td>{g.default ? <span className="neutral">Default</span> : <button type="button" className="btn sm" onClick={onRemove}>Remove</button>}</td>
  </tr>
}

function MonthOverrides({ data, onSaved }: { data: CompanyPnlSettingsResponse; onSaved: (m: Message) => void }) {
  const { adminApi: api } = useLeadership()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const key = (month: string, group: string, field: string) => `${month}|${group}|${field}`
  const value = (month: string, group: string, field: 'fixed_charge' | 'direct_staff') => {
    const k = key(month, group, field)
    if (k in drafts) return drafts[k]
    const v = data.months.find((m) => m.month === month)?.groups[group]?.[field]
    return v == null ? '' : String(v)
  }
  const save = async (month: string, group: string) => {
    const num = (f: 'fixed_charge' | 'direct_staff') => { const v = value(month, group, f); return v === '' ? null : Number(v) }
    try { await api.updatePnlGroupMonth(month, group, { fixed_charge: num('fixed_charge'), direct_staff: num('direct_staff') }); onSaved({ ok: true, text: `Saved ${monthLabel(month)}` }) }
    catch (e) { onSaved({ ok: false, text: errorText(e) }) }
  }
  return <div className="tw"><table><caption className="sr-only">Overhead by month and group</caption>
    <thead><tr><th className="nosort l">Month</th><th className="nosort l">Group</th><th className="nosort" title="Blank uses the group setting">Fixed charge</th>
      <th className="nosort" title="Account managers' pay this month; blank uses the group setting">Account staff</th><th className="nosort"></th></tr></thead>
    <tbody>{[...data.months].reverse().flatMap((m) => data.settings.groups.map((g) => <tr key={`${m.month}-${g.key}`}>
      <td className="l">{monthLabel(m.month)}</td><td className="l">{g.name}</td>
      {(['fixed_charge', 'direct_staff'] as const).map((f) => <td key={f}><input aria-label={`${g.name} ${f} ${m.month}`} type="number" min="0" step="100" style={{ width: 110 }}
        placeholder={money(g[f])} value={value(m.month, g.key, f)} onChange={(e) => setDrafts({ ...drafts, [key(m.month, g.key, f)]: e.target.value })} /></td>)}
      <td><button type="button" className="btn sm" onClick={() => void save(m.month, g.key)}>Save</button></td>
    </tr>))}</tbody></table></div>
}

const blank = (month: string): PnlAdjustmentIn => ({ month, kind: 'accrual', line: 'subcontractors', company: 'Crane IFS', job_number: '', amount: 0, auto_reverse: true, note: '' })

function Adjustments({ months }: { months: string[] }) {
  const { adminApi: api } = useLeadership()
  const [month, setMonth] = useState(months.at(-1) ?? '')
  const [rows, setRows] = useState<PnlAdjustment[] | null>(null)
  const [suggestions, setSuggestions] = useState<PnlAccrualSuggestion[] | null>(null)
  const [draft, setDraft] = useState<PnlAdjustmentIn>(blank(month))
  const [message, setMessage] = useState<Message>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    if (!month) return
    setRows(null); setSuggestions(null)
    api.pnlAdjustments(month).then((r) => setRows(r.adjustments)).catch((e) => setMessage({ ok: false, text: errorText(e) }))
  }, [api, month])
  useEffect(load, [load])
  const act = async (done: string, fn: () => Promise<unknown>) => {
    setBusy(true); setMessage(null)
    try { await fn(); setMessage({ ok: true, text: done }); load(); queryClient.invalidate() }
    catch (e) { setMessage({ ok: false, text: errorText(e) }) } finally { setBusy(false) }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void act('Saved the adjustment', () => api.createPnlAdjustment({ ...draft, month }).then(() => setDraft(blank(month))))
  }
  const cols: Column<PnlAdjustment>[] = [
    { key: 'kind', header: 'Type', left: true, value: (a) => a.kind, render: (a) => (a.kind === 'accrual' ? 'Accrual' : 'Reclass') },
    { key: 'line', header: 'Line', left: true, value: (a) => a.line, render: (a) => LINES.find((l) => l.value === a.line)?.label ?? a.line },
    { key: 'job', header: 'Job', left: true, value: (a) => a.job_number, render: (a) => (a.kind === 'reclass' ? `${a.job_number} to ${a.to_job_number}` : a.job_number) },
    { key: 'amt', header: 'Amount', value: (a) => a.amount, render: (a) => money(a.amount) },
    { key: 'st', header: 'Status', left: true, value: (a) => a.status,
      render: (a) => <span className={a.status === 'active' ? '' : 'neutral'} title={a.status === 'posted' ? 'The invoice came in, so the accrual no longer counts' : a.reversed_by ? `Reversed by ${a.reversed_by}` : undefined}>{STATUS[a.status]}</span> },
    { key: 'note', header: 'Note', left: true, value: (a) => a.note ?? '' },
    { key: 'by', header: 'By', left: true, value: (a) => a.created_by ?? '' },
    { key: 'x', header: '', sortable: false, value: () => null,
      render: (a) => (a.status === 'active' ? <button type="button" className="btn sm" disabled={busy} onClick={() => void act('Reversed', () => api.reversePnlAdjustment(a.adjustment_id))}>Reverse</button> : null) },
  ]
  const sugCols: Column<PnlAccrualSuggestion>[] = [
    { key: 'job', header: 'Site', left: true, value: (s) => s.job_number, render: (s) => `${s.job_number} ${s.job_name ?? ''}` },
    { key: 'rev', header: 'Billed', value: (s) => s.revenue, render: (s) => money(s.revenue) },
    { key: 'sub', header: 'Sub cost in', value: (s) => s.subcontractors, render: (s) => money(s.subcontractors) },
    { key: 'prior', header: 'Prior month', value: (s) => s.prior_subcontractors, render: (s) => money(s.prior_subcontractors) },
    { key: 'amt', header: 'Accrue', value: (s) => s.amount, render: (s) => money(s.amount) },
  ]
  return <div className="card">
    <div className="ct"><span>Accruals and reclasses</span>
      <select aria-label="Month" value={month} onChange={(e) => { setMonth(e.target.value); setDraft(blank(e.target.value)) }}>
        {[...months].reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select></div>
    {message && <p className={`msg ${message.ok ? 'ok' : 'bad'}`} role="status">{message.text}</p>}
    {rows == null ? <Skeleton height={120} /> : rows.length ? <SortTable caption="Adjustments" rows={rows} columns={cols} defaultSort={{ key: 'amt', dir: -1 }} csvName={`adjustments-${month.slice(0, 7)}`} />
      : <Empty>No adjustments for {monthLabel(month)}.</Empty>}
    <form className="form-grid" onSubmit={submit}>
      <label className="field"><span>Type</span><select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as PnlAdjustmentIn['kind'] })}>
        <option value="accrual">Accrual</option><option value="reclass">Reclass</option></select></label>
      <label className="field"><span>Line</span><select value={draft.line} onChange={(e) => setDraft({ ...draft, line: e.target.value as PnlAdjustmentLine })}>
        {LINES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</select></label>
      <label className="field"><span>Company</span><input value={draft.company} onChange={(e) => setDraft({ ...draft, company: e.target.value })} /></label>
      <label className="field"><span>{draft.kind === 'reclass' ? 'From job' : 'Job'}</span><input required value={draft.job_number} onChange={(e) => setDraft({ ...draft, job_number: e.target.value })} /></label>
      {draft.kind === 'reclass' && <label className="field"><span>To job</span><input required value={draft.to_job_number ?? ''} onChange={(e) => setDraft({ ...draft, to_job_number: e.target.value })} /></label>}
      <label className="field"><span>Amount</span><input required type="number" step="0.01" value={draft.amount || ''} onChange={(e) => setDraft({ ...draft, amount: Number(e.target.value) })} /></label>
      {draft.kind === 'accrual' && <label className="field check" title="Stops counting once the job's actual amount on the line comes in"><input type="checkbox" checked={draft.auto_reverse} onChange={(e) => setDraft({ ...draft, auto_reverse: e.target.checked })} />Reverse when posted</label>}
      <label className="field"><span>Note</span><input value={draft.note ?? ''} maxLength={500} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></label>
      <div className="field"><button type="submit" className="btn primary" disabled={busy}>Add</button></div>
    </form>
    <div className="form-grid">
      <div className="field"><button type="button" className="btn" disabled={busy}
        title="Subcontracted sites billed this month whose sub invoices are short of last month"
        onClick={() => api.pnlAccrualSuggestions(month).then((r) => setSuggestions(r.suggestions)).catch((e) => setMessage({ ok: false, text: errorText(e) }))}>Find missing sub invoices</button></div>
    </div>
    {suggestions && (suggestions.length ? <>
      <SortTable caption="Suggested accruals" rows={suggestions} columns={sugCols} defaultSort={{ key: 'amt', dir: -1 }} csvName={`suggested-accruals-${month.slice(0, 7)}`} />
      <div className="form-grid"><div className="field"><button type="button" className="btn primary" disabled={busy}
        onClick={() => void act(`Accrued ${money(suggestions.reduce((a, s) => a + s.amount, 0))}`, () => api.acceptPnlAccruals(month, suggestions.map((s) => ({ company: s.company, job_number: s.job_number, amount: s.amount }))))}>
        Accrue all {money(suggestions.reduce((a, s) => a + s.amount, 0))}</button></div></div>
    </> : <Empty>No missing sub invoices for {monthLabel(month)}.</Empty>)}
  </div>
}

/** Admin > Company P&L: the groups and overhead rule, month overrides, and accruals and reclasses. */
export function CompanyPnlAdmin() {
  const { adminApi: api, apiReachable } = useLeadership()
  const [data, setData] = useState<CompanyPnlSettingsResponse | null>(null)
  const [draft, setDraft] = useState<CompanyPnlSettings | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [message, setMessage] = useState<Message>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    setError(null)
    api.companyPnlSettings().then((r) => { setData(r); setDraft(r.settings) }).catch(setError)
  }, [api])
  useEffect(() => { if (apiReachable) load() }, [apiReachable, load])
  if (!apiReachable) return <Empty>API unreachable.</Empty>
  if (error) return <LoadError error={error} onRetry={load} />
  if (!data || !draft) return <Skeleton height={300} />
  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try { const r = await api.updateCompanyPnlSettings(draft); setDraft(r.settings); setMessage({ ok: true, text: 'Saved the company P&L settings' }); load(); queryClient.invalidate() }
    catch (err) { setMessage({ ok: false, text: errorText(err) }) } finally { setBusy(false) }
  }
  const setGroup = (i: number, g: PnlGroupSetting) => setDraft({ ...draft, groups: draft.groups.map((x, j) => (j === i ? g : x)) })
  const addGroup = () => setDraft({ ...draft, groups: [...draft.groups.slice(0, -1), { key: `group_${draft.groups.length}`, name: 'New group', accounts: [], delivery_model: null, fixed_charge: 0, direct_staff: 0, shares_pool: true, default: false }, ...draft.groups.slice(-1)] })
  return <>
    <div className="card">
      <div className="ct"><span>Groups and overhead</span></div>
      <form onSubmit={save}>
        <div className="form-grid">
          <label className="field" title="Their net cost is corporate overhead"><span>Overhead jobs</span>
            <input value={draft.overhead_jobs.join(', ')} onChange={(e) => setDraft({ ...draft, overhead_jobs: list(e.target.value) })} /></label>
        </div>
        <div className="tw"><table><caption className="sr-only">Company P&L groups</caption>
          <thead><tr><th className="nosort l">Group</th><th className="nosort l" title="Account slugs; a job joins the first group listing its account">Accounts</th>
            <th className="nosort l">Sites</th><th className="nosort" title="Charged every month whatever the size">Fixed charge</th>
            <th className="nosort" title="Account managers' pay charged to the group">Account staff</th>
            <th className="nosort" title="Takes a share of the rest of overhead, by revenue">Shares pool</th><th className="nosort"></th></tr></thead>
          <tbody>{draft.groups.map((g, i) => <GroupRow key={g.key} g={g} onChange={(x) => setGroup(i, x)} onRemove={() => setDraft({ ...draft, groups: draft.groups.filter((_, j) => j !== i) })} />)}</tbody>
        </table></div>
        <div className="form-grid">
          <div className="field"><button type="button" className="btn" onClick={addGroup}>Add group</button></div>
          <div className="field"><button type="submit" className="btn primary" disabled={busy}>Save</button></div>
        </div>
      </form>
      {message && <p className={`msg ${message.ok ? 'ok' : 'bad'}`} role="status">{message.text}</p>}
    </div>
    <div className="card"><div className="ct"><span>By month</span></div>
      <MonthOverrides data={data} onSaved={(m) => { setMessage(m); load(); queryClient.invalidate() }} />
    </div>
    <Adjustments months={data.months.map((m) => m.month)} />
  </>
}
