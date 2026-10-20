import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { AdjustmentKind, CompanyPlGroupSetting, CompanyPlSettings, JobContract, PlAdjustment, PlAdjustmentInput, PlAdjustmentsResponse, PlCategory } from '../../services/apiTypes'
import { money } from '../format'
import { monthLabel } from '../routes'
import { useLeadership } from '../state'
import { Empty, LoadError, Skeleton } from '../ui'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const list = (text: string) => text.split(',').map((x) => x.trim()).filter(Boolean)

export const CATEGORY_LABEL: Record<PlCategory, string> = {
  revenue: 'Revenue', direct_labor: 'Direct labor', payroll_taxes_insurance: 'Payroll taxes and insurance', subcontractors: 'Subcontractors',
  supplies: 'Supplies', other_direct: 'Other direct', operating_expense: 'Operating expense',
}
export const KIND_LABEL: Record<AdjustmentKind, string> = { accrual: 'Accrual', reclass: 'Reclass', staff: 'Direct staff' }
const CATEGORIES = Object.keys(CATEGORY_LABEL) as PlCategory[]
const thisMonth = () => new Date().toISOString().slice(0, 7)

type Message = { ok: boolean; text: string } | null

/** Admin > Overhead rule: the overhead jobs, the P&L groups and how the overhead pool is spread (setting company_pl). */
export function OverheadRuleTab() {
  const { adminApi: api, apiReachable } = useLeadership()
  const [draft, setDraft] = useState<CompanyPlSettings | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [message, setMessage] = useState<Message>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => { setError(null); api.companyPlSettings().then((r) => setDraft(r.settings)).catch(setError) }, [api])
  useEffect(() => { if (apiReachable) load() }, [apiReachable, load])
  if (!apiReachable) return <Empty>API unreachable.</Empty>
  if (error) return <LoadError error={error} onRetry={load} />
  if (!draft) return <Skeleton height={300} />
  const setGroup = (i: number, patch: Partial<CompanyPlGroupSetting>) => setDraft({ ...draft, groups: draft.groups.map((g, j) => (j === i ? { ...g, ...patch } : g)) })
  const setRest = (i: number) => setDraft({ ...draft, groups: draft.groups.map((g, j) => ({ ...g, rest: j === i })) })
  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try { const r = await api.updateCompanyPlSettings(draft); setDraft(r.settings); setMessage({ ok: true, text: 'Saved overhead rule' }) }
    catch (err) { setMessage({ ok: false, text: errorText(err) }) } finally { setBusy(false) }
  }
  return <form onSubmit={save}>
    <div className="card">
      <div className="ct"><span>Corporate overhead</span></div>
      <div className="form-grid">
        <label className="field"><span>Overhead jobs</span><input type="text" value={draft.overhead_jobs.join(', ')} onChange={(e) => setDraft({ ...draft, overhead_jobs: list(e.target.value) })} /></label>
        <label className="field"><span>Spread pool by</span><select value={draft.pool_basis} onChange={() => undefined}><option value="revenue">Revenue</option></select></label>
      </div>
    </div>
    <div className="card">
      <div className="ct"><span>P&amp;L groups</span><button type="button" className="btn sm" onClick={() => setDraft({ ...draft, groups: [...draft.groups, { key: `group_${draft.groups.length + 1}`, name: 'New group', accounts: [], delivery_model: null, fixed_monthly: 0, shares_pool: true, rest: false }] })}>Add group</button></div>
      <div className="tw"><table><caption className="sr-only">P&amp;L groups</caption>
        <thead><tr><th className="nosort l">Key</th><th className="nosort l">Name</th><th className="nosort l">Accounts</th><th className="nosort l">Delivery</th><th className="nosort">Fixed charge / month</th>
          <th className="nosort">Shares pool</th><th className="nosort">All other jobs</th><th className="nosort"></th></tr></thead>
        <tbody>{draft.groups.map((g, i) => <tr key={i}>
          <td className="l"><label className="sr-only" htmlFor={`g${i}k`}>Key</label><input id={`g${i}k`} type="text" value={g.key} onChange={(e) => setGroup(i, { key: e.target.value.replace(/[^a-z0-9_]/gi, '_').toLowerCase() })} style={{ width: 110 }} /></td>
          <td className="l"><label className="sr-only" htmlFor={`g${i}n`}>Name</label><input id={`g${i}n`} type="text" value={g.name} onChange={(e) => setGroup(i, { name: e.target.value })} /></td>
          <td className="l"><label className="sr-only" htmlFor={`g${i}a`}>Account slugs</label><input id={`g${i}a`} type="text" value={g.accounts.join(', ')} disabled={g.rest} onChange={(e) => setGroup(i, { accounts: list(e.target.value) })} /></td>
          <td className="l"><label className="sr-only" htmlFor={`g${i}d`}>Delivery model</label>
            <select id={`g${i}d`} value={g.delivery_model ?? ''} disabled={g.rest} onChange={(e) => setGroup(i, { delivery_model: (e.target.value || null) as CompanyPlGroupSetting['delivery_model'] })}>
              <option value="">Any</option><option value="self_perform">Self-perform</option><option value="subcontracted">Subcontracted</option></select></td>
          <td><label className="sr-only" htmlFor={`g${i}f`}>Fixed charge</label><input id={`g${i}f`} type="number" min="0" step="1000" value={g.fixed_monthly} onChange={(e) => setGroup(i, { fixed_monthly: Number(e.target.value) })} style={{ width: 110 }} /></td>
          <td><input type="checkbox" aria-label={`${g.name} shares the pool`} checked={g.shares_pool} onChange={() => setGroup(i, { shares_pool: !g.shares_pool })} /></td>
          <td><input type="radio" name="rest" aria-label={`${g.name} takes all other jobs`} checked={g.rest} onChange={() => setRest(i)} /></td>
          <td><button type="button" className="btn sm" disabled={g.rest} onClick={() => setDraft({ ...draft, groups: draft.groups.filter((_, j) => j !== i) })}>Remove</button></td>
        </tr>)}</tbody>
      </table></div>
    </div>
    <div className="card">
      <div className="ct"><span>GL account ranges</span><button type="button" className="btn sm" onClick={() => setDraft({ ...draft, gl_categories: [...draft.gl_categories, { from: '', to: '', category: 'operating_expense' }] })}>Add range</button></div>
      {draft.gl_categories.length === 0 ? <p className="neutral">Lines classified by name.</p> : <div className="tw"><table><caption className="sr-only">GL account ranges</caption>
        <thead><tr><th className="nosort l">From</th><th className="nosort l">To</th><th className="nosort l">Category</th><th className="nosort"></th></tr></thead>
        <tbody>{draft.gl_categories.map((r, i) => {
          const set = (patch: Partial<typeof r>) => setDraft({ ...draft, gl_categories: draft.gl_categories.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
          return <tr key={i}>
            <td className="l"><input aria-label="From GL account" type="text" inputMode="numeric" value={r.from} onChange={(e) => set({ from: e.target.value.replace(/\D/g, '') })} style={{ width: 100 }} /></td>
            <td className="l"><input aria-label="To GL account" type="text" inputMode="numeric" value={r.to} onChange={(e) => set({ to: e.target.value.replace(/\D/g, '') })} style={{ width: 100 }} /></td>
            <td className="l"><select aria-label="Category" value={r.category} onChange={(e) => set({ category: e.target.value as PlCategory })}>{CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select></td>
            <td><button type="button" className="btn sm" onClick={() => setDraft({ ...draft, gl_categories: draft.gl_categories.filter((_, j) => j !== i) })}>Remove</button></td>
          </tr>
        })}</tbody></table></div>}
    </div>
    <div className="field"><button type="submit" className="btn primary" disabled={busy}>Save</button></div>
    {message && <p className={`msg ${message.ok ? 'ok' : 'bad'}`} role="status">{message.text}</p>}
  </form>
}

const EMPTY: PlAdjustmentInput = { month: thisMonth(), kind: 'accrual', category: 'subcontractors', amount: 0, description: '', to_job: '', to_company: '', from_job: '', from_company: '', group_key: '', reverse_month: '' }

function AdjustmentForm({ groups, initial, onDone, onCancel }: { groups: PlAdjustmentsResponse['groups']; initial: PlAdjustmentInput & { id?: number }; onDone: (m: Message) => void; onCancel?: () => void }) {
  const { adminApi: api } = useLeadership()
  const [d, setD] = useState(initial)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const body: PlAdjustmentInput = { ...d, reverse_month: d.reverse_month || null, group_key: d.group_key || null }
    try {
      if (initial.id) await api.updatePlAdjustment(initial.id, body)
      else await api.createPlAdjustment(body)
      onDone({ ok: true, text: initial.id ? 'Saved adjustment' : 'Added adjustment' })
      if (!initial.id) setD({ ...EMPTY, month: d.month })
    } catch (err) { onDone({ ok: false, text: errorText(err) }) } finally { setBusy(false) }
  }
  const set = (patch: Partial<PlAdjustmentInput>) => setD({ ...d, ...patch })
  return <form className="form-grid" onSubmit={submit}>
    <label className="field"><span>Month</span><input type="month" required value={d.month.slice(0, 7)} onChange={(e) => set({ month: e.target.value })} /></label>
    <label className="field"><span>Type</span><select value={d.kind} onChange={(e) => set({ kind: e.target.value as AdjustmentKind, category: e.target.value === 'staff' ? 'operating_expense' : d.category })}>
      <option value="accrual">Accrual</option><option value="reclass">Reclass</option><option value="staff">Direct staff</option></select></label>
    {d.kind !== 'staff' && <label className="field"><span>Line</span><select value={d.category} onChange={(e) => set({ category: e.target.value as PlCategory })}>
      {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select></label>}
    <label className="field"><span>Amount</span><input type="number" step="0.01" required value={d.amount} onChange={(e) => set({ amount: Number(e.target.value) })} /></label>
    {d.kind === 'reclass' && <>
      <label className="field"><span>From job</span><input type="text" required value={d.from_job ?? ''} onChange={(e) => set({ from_job: e.target.value })} /></label>
      <label className="field"><span>From company</span><input type="text" value={d.from_company ?? ''} onChange={(e) => set({ from_company: e.target.value })} /></label>
    </>}
    {d.kind !== 'staff' && <>
      <label className="field"><span>{d.kind === 'reclass' ? 'To job' : 'Job'}</span><input type="text" required value={d.to_job ?? ''} onChange={(e) => set({ to_job: e.target.value })} /></label>
      <label className="field"><span>{d.kind === 'reclass' ? 'To company' : 'Company'}</span><input type="text" value={d.to_company ?? ''} onChange={(e) => set({ to_company: e.target.value })} /></label>
    </>}
    {d.kind === 'staff' && <label className="field"><span>Group</span><select required value={d.group_key ?? ''} onChange={(e) => set({ group_key: e.target.value })}>
      <option value="" disabled>Select</option>{groups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}</select></label>}
    {d.kind === 'accrual' && <label className="field"><span>Reverses in</span><input type="month" value={(d.reverse_month ?? '').slice(0, 7)} onChange={(e) => set({ reverse_month: e.target.value })} /></label>}
    <label className="field wide"><span>Description</span><input type="text" required maxLength={500} value={d.description} onChange={(e) => set({ description: e.target.value })} /></label>
    <div className="field"><button type="submit" className="btn primary" disabled={busy}>{initial.id ? 'Save' : 'Add'}</button>{onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}</div>
  </form>
}

const target = (a: PlAdjustment, groups: PlAdjustmentsResponse['groups']) => a.kind === 'staff' ? groups.find((g) => g.key === a.group_key)?.name ?? a.group_key
  : a.kind === 'reclass' ? `${a.from_job} to ${a.to_job}` : `Job ${a.to_job}`

/** Admin > Adjustments: Finance's accruals, reclasses and direct staff charges on top of the GL. */
export function AdjustmentsTab() {
  const { adminApi: api, apiReachable } = useLeadership()
  const [data, setData] = useState<PlAdjustmentsResponse | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [message, setMessage] = useState<Message>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const load = useCallback(() => { setError(null); api.plAdjustments(24).then(setData).catch(setError) }, [api])
  useEffect(() => { if (apiReachable) load() }, [apiReachable, load])
  if (!apiReachable) return <Empty>API unreachable.</Empty>
  if (error) return <LoadError error={error} onRetry={load} />
  if (!data) return <Skeleton height={300} />
  const done = (m: Message) => { setMessage(m); if (m?.ok) { setEditing(null); load() } }
  const act = async (f: () => Promise<unknown>, text: string) => { try { await f(); done({ ok: true, text }) } catch (err) { done({ ok: false, text: errorText(err) }) } }
  return <>
    <div className="card"><div className="ct"><span>New adjustment</span></div><AdjustmentForm groups={data.groups} initial={EMPTY} onDone={done} /></div>
    {message && <p className={`msg ${message.ok ? 'ok' : 'bad'}`} role="status">{message.text}</p>}
    <div className="card"><div className="ct"><span>Adjustments</span></div>
      {data.adjustments.length === 0 ? <Empty>No adjustments.</Empty> : <div className="tw"><table><caption className="sr-only">Adjustments</caption>
        <thead><tr><th className="nosort l">Month</th><th className="nosort l">Type</th><th className="nosort l">Line</th><th className="nosort l">Applies to</th><th className="nosort">Amount</th>
          <th className="nosort l">Status</th><th className="nosort l">Description</th><th className="nosort l">By</th><th className="nosort"></th></tr></thead>
        <tbody>{[...data.adjustments].reverse().map((a) => editing === a.adjustment_id
          ? <tr key={a.adjustment_id}><td colSpan={9}><AdjustmentForm groups={data.groups} initial={{ ...a, id: a.adjustment_id, from_job: a.from_job ?? '', to_job: a.to_job ?? '', from_company: a.from_company ?? '', to_company: a.to_company ?? '', group_key: a.group_key ?? '', reverse_month: a.reverse_month ?? '' }} onDone={done} onCancel={() => setEditing(null)} /></td></tr>
          : <tr key={a.adjustment_id} className={a.cleared_at ? 'dim' : ''}>
            <td className="l">{monthLabel(a.month)}</td><td className="l">{KIND_LABEL[a.kind]}</td><td className="l">{CATEGORY_LABEL[a.category]}</td>
            <td className="l">{target(a, data.groups)}</td><td>{money(a.amount)}</td>
            <td className="l">{a.kind !== 'accrual' ? '–' : a.cleared_at ? `Cleared ${a.cleared_at.slice(0, 10)}` : a.reverse_month ? `Reverses ${monthLabel(a.reverse_month)}` : 'Open'}</td>
            <td className="l">{a.description}</td><td className="l neutral">{a.updated_by ?? a.created_by ?? ''}</td>
            <td className="actions">
              <button type="button" className="btn sm" onClick={() => setEditing(a.adjustment_id)}>Edit</button>
              {a.kind === 'accrual' && <button type="button" className="btn sm" onClick={() => act(() => api.clearPlAdjustment(a.adjustment_id, !a.cleared_at), a.cleared_at ? 'Reopened accrual' : 'Cleared accrual')}>{a.cleared_at ? 'Reopen' : 'Clear'}</button>}
              <button type="button" className="btn sm" onClick={() => { if (window.confirm(`Delete "${a.description}"?`)) void act(() => api.deletePlAdjustment(a.adjustment_id), 'Deleted adjustment') }}>Delete</button>
            </td>
          </tr>)}</tbody></table></div>}
    </div>
  </>
}

/** Admin > Contracts: monthly contract billing per job from an effective date (the contract invoice basis). */
export function ContractsTab() {
  const { adminApi: api, apiReachable, featured } = useLeadership()
  const [account, setAccount] = useState('')
  const [rows, setRows] = useState<JobContract[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [message, setMessage] = useState<Message>(null)
  const [d, setD] = useState({ company: '', job_number: '', effective_from: `${thisMonth()}-01`, monthly_amount: 0, note: '' })
  const load = useCallback(() => { setError(null); api.jobContracts(account || undefined).then((r) => setRows(r.contracts)).catch(setError) }, [api, account])
  useEffect(() => { if (apiReachable) load() }, [apiReachable, load])
  if (!apiReachable) return <Empty>API unreachable.</Empty>
  if (error) return <LoadError error={error} onRetry={load} />
  const save = async (e: FormEvent) => {
    e.preventDefault()
    try { await api.saveJobContract(d.company, d.job_number, { effective_from: d.effective_from, monthly_amount: d.monthly_amount, note: d.note || null }); setMessage({ ok: true, text: `Saved job ${d.job_number}` }); load() }
    catch (err) { setMessage({ ok: false, text: errorText(err) }) }
  }
  const remove = async (c: JobContract) => {
    try { await api.deleteJobContract(c.company, c.job_number, c.effective_from); setMessage({ ok: true, text: `Removed job ${c.job_number} from ${c.effective_from}` }); load() }
    catch (err) { setMessage({ ok: false, text: errorText(err) }) }
  }
  return <>
    <div className="card"><div className="ct"><span>Contract</span></div>
      <form className="form-grid" onSubmit={save}>
        <label className="field"><span>Job</span><input type="text" required value={d.job_number} onChange={(e) => setD({ ...d, job_number: e.target.value })} /></label>
        <label className="field"><span>Company</span><input type="text" value={d.company} placeholder="Any" onChange={(e) => setD({ ...d, company: e.target.value })} /></label>
        <label className="field"><span>Effective from</span><input type="date" required value={d.effective_from} onChange={(e) => setD({ ...d, effective_from: e.target.value })} /></label>
        <label className="field"><span>Monthly amount</span><input type="number" min="0" step="0.01" required value={d.monthly_amount} onChange={(e) => setD({ ...d, monthly_amount: Number(e.target.value) })} /></label>
        <label className="field wide"><span>Note</span><input type="text" value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} /></label>
        <div className="field"><button type="submit" className="btn primary">Save</button></div>
      </form>
      {message && <p className={`msg ${message.ok ? 'ok' : 'bad'}`} role="status">{message.text}</p>}
    </div>
    <div className="card"><div className="ct"><span>Contracts</span>
      <label className="field inline"><span className="sr-only">Account</span><select value={account} onChange={(e) => setAccount(e.target.value)}><option value="">All accounts</option>{featured.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}</select></label></div>
      {!rows ? <Skeleton height={200} /> : rows.length === 0 ? <Empty>No contracts.</Empty> : <div className="tw"><table><caption className="sr-only">Contracts</caption>
        <thead><tr><th className="nosort l">Job</th><th className="nosort l">Name</th><th className="nosort l">Company</th><th className="nosort l">Effective from</th><th className="nosort">Monthly</th><th className="nosort">Weekly</th><th className="nosort l">Note</th><th className="nosort"></th></tr></thead>
        <tbody>{rows.map((c) => <tr key={`${c.company}|${c.job_number}|${c.effective_from}`}>
          <td className="l">{c.job_number}</td><td className="l">{c.job_name ?? ''}</td><td className="l">{c.company || 'Any'}</td><td className="l">{c.effective_from}</td>
          <td>{money(c.monthly_amount)}</td><td className="neutral">{money(c.monthly_amount / 4.33)}</td><td className="l">{c.note ?? ''}</td>
          <td><button type="button" className="btn sm" onClick={() => remove(c)}>Remove</button></td>
        </tr>)}</tbody></table></div>}
    </div>
  </>
}
