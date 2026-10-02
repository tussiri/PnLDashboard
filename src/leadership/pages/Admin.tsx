import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useApiQuery } from '../../hooks/useApiQuery'
import type { LeadershipAccount, LeadershipAccountJob, LeadershipAccountPatch, LeadershipImportFile, LeadershipImportKind, LeadershipRole, SyncRunsResponse, MailInboxStatus, MailRule } from '../../services/apiTypes'
import { queryClient, queryKey } from '../../services/queryClient'
import { inSentence } from '../data'
import { ADMIN_TABS, type AdminTab } from '../routes'
import { freshnessLine, PageHeader } from '../Shell'
import { useLeadership } from '../state'
import { Empty, LoadError, Pills, Skeleton, SortTable, type Column } from '../ui'
import { UsersTab } from './Users'
import { AllocationsTab } from './Allocations'

const TAB_LABEL: Record<AdminTab, string> = { accounts: 'Accounts', jobs: 'Job mapping', allocations: 'Allocations', imports: 'Imports', mailbox: 'Mailbox', data: 'Data and sync', users: 'Users' }
const ROLE_LABEL: Record<LeadershipRole, string> = { site: 'Site', catch_all: 'Catch-all', non_billed: 'Non-billed', pallet: 'Pallet' }
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Refresh every cached query after a change (configuration applies at read time). */
const refreshAll = () => queryClient.invalidate()

const FEED_NAME: Record<string, string> = { pay_report: 'Labor', job_cost: 'Job cost', income_statement: 'Income statement', service_feedback: 'Feedback' }

function useAction() {
  const { decision, redetect } = useLeadership()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  /** `done` is the success message; a failure shows the error. */
  const run = async (done: string, fn: () => Promise<unknown>) => {
    setBusy(true); setMessage(null)
    try { await fn(); setMessage({ ok: true, text: done }); refreshAll(); if (decision?.mode === 'demo') redetect() }
    catch (e) { setMessage({ ok: false, text: errorText(e) }) }
    finally { setBusy(false) }
  }
  const view = message && <p className={`msg ${message.ok ? 'ok' : 'bad'}`} role="status">{message.text}</p>
  return { busy, run, view }
}

function AccountEditor({ account }: { account: LeadershipAccount }) {
  const { adminApi: api } = useLeadership()
  const { busy, run, view } = useAction()
  const [draft, setDraft] = useState(account)
  const [segments, setSegments] = useState(account.segments.map((s) => ({ name: s.name, target: s.target_labor_pct == null ? '' : String(s.target_labor_pct * 100) })))
  useEffect(() => { setDraft(account); setSegments(account.segments.map((s) => ({ name: s.name, target: s.target_labor_pct == null ? '' : String(s.target_labor_pct * 100) }))) }, [account])
  const save = (e: FormEvent) => {
    e.preventDefault()
    const patch: LeadershipAccountPatch = {
      name: draft.name, featured: draft.featured, sort: draft.sort, target_labor_pct: draft.target_labor_pct, watch_band: draft.watch_band,
      revenue_method: draft.revenue_method, revenue_divisor: draft.revenue_divisor, budget_reliability_ratio: draft.budget_reliability_ratio,
      cost_basis: draft.cost_basis, revenue_allocation: draft.revenue_allocation, fallback_segment: draft.fallback_segment,
      segment_label: draft.segment_label.trim() || 'Segment', vendor_label: draft.vendor_label.trim() || 'Vendor',
      vocabulary: draft.vocabulary, vendor_factor: draft.vendor_factor, invoice_basis: draft.invoice_basis, group_by: draft.group_by, split_subcontracted: draft.split_subcontracted,
    }
    void run(`Saved ${draft.name}`, () => api.leadershipUpdateAccount(account.slug, patch))
  }
  const saveSegments = () => void run(`Saved ${account.name} ${inSentence(account.segment_label)}s`, () => api.leadershipReplaceSegments(account.slug,
    segments.filter((s) => s.name.trim()).map((s) => ({ name: s.name.trim(), target_labor_pct: s.target ? Number(s.target) / 100 : null }))))
  const num = (v: string) => Number(v)
  return <div className="card">
    <div className="ct"><span>{account.name}</span><span className="ks">{account.sites} sites, {account.needs_review} to review</span></div>
    <form className="form-grid" onSubmit={save}>
      <label className="field"><span>Name</span><input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="field"><span>Target %</span><input type="number" step="0.5" value={(draft.target_labor_pct * 100).toFixed(1)} onChange={(e) => setDraft({ ...draft, target_labor_pct: num(e.target.value) / 100 })} /></label>
      <label className="field"><span>Watch band (pts)</span><input type="number" step="0.5" value={(draft.watch_band * 100).toFixed(1)} onChange={(e) => setDraft({ ...draft, watch_band: num(e.target.value) / 100 })} /></label>
      <label className="field"><span>Labor %</span><select value={draft.cost_basis} onChange={(e) => setDraft({ ...draft, cost_basis: e.target.value as LeadershipAccount['cost_basis'] })}>
        <option value="labor">Direct labor</option><option value="labor_plus_vendor">Direct labor + {inSentence(draft.vendor_label)}</option></select></label>
      <label className="field"><span>Group name</span><input type="text" maxLength={30} value={draft.segment_label} onChange={(e) => setDraft({ ...draft, segment_label: e.target.value })} /></label>
      <label className="field"><span>Non-payroll labor name</span><input type="text" maxLength={30} value={draft.vendor_label} onChange={(e) => setDraft({ ...draft, vendor_label: e.target.value })} /></label>
      <label className="field"><span>{draft.vendor_label} counted (%)</span><input type="number" step="5" min="0" max="100" value={Math.round(draft.vendor_factor * 100)} onChange={(e) => setDraft({ ...draft, vendor_factor: num(e.target.value) / 100 })} /></label>
      <label className="field"><span>Report wording</span><select value={draft.vocabulary} onChange={(e) => setDraft({ ...draft, vocabulary: e.target.value as LeadershipAccount['vocabulary'] })}>
        <option value="amazon">Amazon report</option><option value="fedex">FedEx report</option></select></label>
      <label className="field"><span>Invoice basis</span><select value={draft.invoice_basis} onChange={(e) => setDraft({ ...draft, invoice_basis: e.target.value as LeadershipAccount['invoice_basis'] })}>
        <option value="last_month">Last closed month</option><option value="run_rate_3m">3-month run rate</option></select></label>
      <label className="field"><span>Groups</span><select value={draft.group_by} onChange={(e) => setDraft({ ...draft, group_by: e.target.value as LeadershipAccount['group_by'] })}>
        <option value="segment">{draft.segment_label}s</option><option value="pallet">Pallet sites / Janitorial only</option></select></label>
      <label className="field"><span>Subcontracted sites</span><select value={draft.split_subcontracted ? 'split' : 'in'} onChange={(e) => setDraft({ ...draft, split_subcontracted: e.target.value === 'split' })}>
        <option value="in">In the labor views</option><option value="split">Own tab (AR vs AP)</option></select></label>
      <label className="field"><span>Revenue method</span><select value={draft.revenue_method} onChange={(e) => setDraft({ ...draft, revenue_method: e.target.value as LeadershipAccount['revenue_method'] })}>
        <option value="monthly_div">Monthly invoicing ÷ divisor</option><option value="weekly_billing">Weekly billing</option><option value="per_visit">Per visit</option></select></label>
      <label className="field"><span>Divisor</span><input type="number" step="0.01" value={draft.revenue_divisor} onChange={(e) => setDraft({ ...draft, revenue_divisor: num(e.target.value) })} /></label>
      <label className="field"><span>Parent billing</span><select value={draft.revenue_allocation} onChange={(e) => setDraft({ ...draft, revenue_allocation: e.target.value as LeadershipAccount['revenue_allocation'] })}>
        <option value="none">Keep on parent</option><option value="budget_hours">Spread by budget hours</option></select></label>
      <label className="field"><span>Budget reliability ratio</span><input type="number" step="0.05" value={draft.budget_reliability_ratio} onChange={(e) => setDraft({ ...draft, budget_reliability_ratio: num(e.target.value) })} /></label>
      <label className="field"><span>Fallback {inSentence(account.segment_label)}</span><select value={draft.fallback_segment} onChange={(e) => setDraft({ ...draft, fallback_segment: e.target.value })}>
        {account.segments.map((s) => <option key={s.name}>{s.name}</option>)}</select></label>
      <label className="field"><span>Sort</span><input type="number" value={draft.sort} onChange={(e) => setDraft({ ...draft, sort: num(e.target.value) })} /></label>
      <label className="field"><span>Featured</span><select value={draft.featured ? 'yes' : 'no'} onChange={(e) => setDraft({ ...draft, featured: e.target.value === 'yes' })}><option value="yes">Yes</option><option value="no">No</option></select></label>
      <div className="field"><button type="submit" className="btn primary" disabled={busy}>Save account</button></div>
    </form>
    <div className="ct" style={{ marginTop: 14 }}><span>{account.segment_label}s</span></div>
    <div className="tw"><table><caption className="sr-only">{account.name} segments</caption>
      <thead><tr><th className="nosort l">{account.segment_label}</th><th className="nosort">Target %</th><th className="nosort"></th></tr></thead>
      <tbody>{segments.map((s, i) => <tr key={i}>
        <td className="l"><label className="sr-only" htmlFor={`seg-${account.slug}-${i}`}>Segment name</label><input id={`seg-${account.slug}-${i}`} type="text" value={s.name} onChange={(e) => setSegments(segments.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></td>
        <td><label className="sr-only" htmlFor={`segt-${account.slug}-${i}`}>Target override</label><input id={`segt-${account.slug}-${i}`} type="number" step="0.5" placeholder="Account" value={s.target} onChange={(e) => setSegments(segments.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))} /></td>
        <td><button type="button" className="btn sm" onClick={() => setSegments(segments.filter((_, j) => j !== i))} disabled={s.name === account.fallback_segment}>Remove</button></td>
      </tr>)}</tbody></table></div>
    <div className="ctrl" style={{ marginTop: 8 }}><button type="button" className="btn sm" onClick={() => setSegments([...segments, { name: '', target: '' }])}>Add {inSentence(account.segment_label)}</button><button type="button" className="btn sm primary" onClick={saveSegments} disabled={busy}>Save {inSentence(account.segment_label)}s</button></div>
    {view}
  </div>
}

function AccountsTab() {
  const { adminConfig: config, adminApi: api } = useLeadership()
  const { busy, run, view } = useAction()
  const accounts = config.data?.accounts ?? []
  return <>
    <div className="ctrl" style={{ marginBottom: 12 }}><button type="button" className="btn" disabled={busy} onClick={() => run('Seed reloaded', () => api.leadershipReloadSeed())}>Reload seed</button>{view}</div>
    {accounts.map((a) => <AccountEditor key={a.slug} account={a} />)}
  </>
}

function JobRow({ job, accounts, onSaved }: { job: LeadershipAccountJob; accounts: LeadershipAccount[]; onSaved: () => void }) {
  const { adminApi: api } = useLeadership()
  const [slug, setSlug] = useState(job.account_slug ?? '')
  const [segment, setSegment] = useState(job.segment ?? '')
  const [role, setRole] = useState<LeadershipRole>(job.role ?? 'site')
  const [cc, setCc] = useState(job.companycam_project_id ?? '')
  const [state, setState] = useState<string | null>(null)
  const account = accounts.find((a) => a.slug === slug)
  const save = async () => {
    setState('Saving')
    try { await api.leadershipMapJob(job.company, job.job_number, { account_slug: slug || null, segment: segment || null, role, companycam_project_id: cc || null }); setState('Saved'); onSaved() }
    catch (e) { setState(errorText(e)) }
  }
  const id = `${job.company}-${job.job_number}`
  return <tr>
    <td className="l">{job.job_number}</td>
    <td className="l nm">{job.job_name ?? ''}<br /><span className="neutral">{job.company}{job.parent_account ? `, ${job.parent_account}` : ''}</span></td>
    <td className="l"><label className="sr-only" htmlFor={`a-${id}`}>Account</label><select id={`a-${id}`} value={slug} onChange={(e) => { setSlug(e.target.value); setSegment('') }}><option value="">Other</option>{accounts.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}</select></td>
    <td className="l"><label className="sr-only" htmlFor={`r-${id}`}>Role</label><select id={`r-${id}`} value={role} onChange={(e) => setRole(e.target.value as LeadershipRole)} disabled={!slug}>{(Object.keys(ROLE_LABEL) as LeadershipRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></td>
    <td className="l"><label className="sr-only" htmlFor={`s-${id}`}>Segment</label><select id={`s-${id}`} value={segment} onChange={(e) => setSegment(e.target.value)} disabled={!slug || role !== 'site'}><option value="">{account ? `Fallback (${account.fallback_segment})` : ''}</option>{account?.segments.map((s) => <option key={s.name}>{s.name}</option>)}</select></td>
    <td className="l"><label className="sr-only" htmlFor={`c-${id}`}>CompanyCam project</label><input id={`c-${id}`} type="text" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Project id" disabled={!slug} style={{ width: 110 }} /></td>
    <td className="l"><button type="button" className="btn sm primary" onClick={save}>{job.needs_review && slug === job.account_slug ? 'Confirm' : 'Save'}</button> <span className="ks">{state}</span></td>
  </tr>
}

function JobsTab() {
  const { adminApi: api, adminConfig: config, adminKeyPrefix: keyPrefix, decision } = useLeadership()
  const [view, setView] = useState<'review' | 'mapped' | 'unmapped'>('review')
  const [account, setAccount] = useState('')
  const [filter, setFilter] = useState('')
  const query = view === 'unmapped' ? { unmapped: true } : { account: account || undefined, needs_review: view === 'review' ? true : undefined }
  const q = useApiQuery(decision ? queryKey(`${keyPrefix}/leadership/account-jobs`, query) : null, (signal) => api.leadershipAccountJobs(query, signal), [api, view, account])
  const accounts = config.data?.accounts ?? []
  const jobs = useMemo(() => (q.data?.jobs ?? []).filter((j) => !filter || `${j.job_number} ${j.job_name ?? ''} ${j.parent_account ?? ''}`.toLowerCase().includes(filter.toLowerCase())), [q.data, filter])
  return <>
    <Pills label="Jobs" value={view} onChange={setView} options={[{ value: 'review', label: 'To review' }, { value: 'mapped', label: 'Mapped' }, { value: 'unmapped', label: 'Unmapped' }]} />
    <div className="ctrl" style={{ marginBottom: 10 }}>
      {view !== 'unmapped' && <><label htmlFor="ja">Account</label><select id="ja" value={account} onChange={(e) => setAccount(e.target.value)}><option value="">All</option>{accounts.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}</select></>}
      <label htmlFor="jf" className="sr-only">Search jobs</label><input id="jf" type="search" placeholder="Search job or name" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <span className="ks">{jobs.length} jobs{jobs.length > 300 ? ', first 300 shown' : ''}</span>
    </div>
    {q.error ? <LoadError error={q.error} onRetry={q.refetch} /> : !q.data ? <Skeleton height={300} /> : !jobs.length ? <Empty>No jobs.</Empty> :
      <div className="card"><div className="tw"><table><caption className="sr-only">Job mapping</caption>
        <thead><tr><th className="nosort l">Job</th><th className="nosort l">Name</th><th className="nosort l">Account</th><th className="nosort l">Role</th><th className="nosort l">Segment</th><th className="nosort l">CompanyCam</th><th className="nosort l"></th></tr></thead>
        <tbody>{jobs.slice(0, 300).map((j) => <JobRow key={`${j.company}-${j.job_number}`} job={j} accounts={accounts} onSaved={refreshAll} />)}</tbody>
      </table></div></div>}
  </>
}

const MAIL_TONE: Record<string, string> = { loaded: 'ok', failed: 'bad', duplicate: 'neutral', ignored: 'neutral' }

const RULE_FIELDS: { key: Exclude<keyof MailRule, 'name'>; label: string; hint: string }[] = [
  { key: 'senders', label: 'Senders', hint: 'reports@smcraneifs.com, @winteam.com' },
  { key: 'subjects', label: 'Subject contains', hint: '[Dashboard]' },
  { key: 'exclude_subjects', label: 'Ignore subjects containing', hint: 'Power BI' },
  { key: 'files', label: 'File names', hint: '*_timekeeping_recent_*.csv' },
]
type RuleDraft = { id: number; name: string } & Record<Exclude<keyof MailRule, 'name'>, string>
const listOf = (text: string) => text.split(',').map((x) => x.trim()).filter(Boolean)
let nextRuleId = 1
const draftOf = (r?: MailRule): RuleDraft => ({ id: nextRuleId++, name: r?.name ?? '', senders: r?.senders.join(', ') ?? '', subjects: r?.subjects.join(', ') ?? '',
  exclude_subjects: r?.exclude_subjects.join(', ') ?? '', files: r?.files.join(', ') ?? '' })

/** Mail rules: which mail in the shared inbox is the dashboard's. Mail matching any rule is; with no rules, all mail goes on to the column check. */
function MailRules({ status, onSaved }: { status: MailInboxStatus; onSaved: () => void }) {
  const { adminApi: api } = useLeadership()
  const { busy, run, view } = useAction()
  const [drafts, setDrafts] = useState<RuleDraft[]>(() => status.schedule.rules.map(draftOf))
  const set = (id: number, patch: Partial<RuleDraft>) => setDrafts(drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)))
  const save = (e: FormEvent) => {
    e.preventDefault()
    const rules: MailRule[] = drafts.map((d) => ({ name: d.name.trim(), senders: listOf(d.senders), subjects: listOf(d.subjects), exclude_subjects: listOf(d.exclude_subjects), files: listOf(d.files) }))
    void run(`Saved ${rules.length} mail rule${rules.length === 1 ? '' : 's'}`, async () => { await api.updateMailSetting({ ...status.schedule, rules }); onSaved() })
  }
  return <div className="card">
    <div className="ct"><span>Mail rules</span><span className="ks">{drafts.length ? 'Mail matching any rule is loaded' : 'No rules: every report-shaped attachment is loaded'}</span></div>
    <form onSubmit={save}>
      {drafts.map((d, i) => <fieldset key={d.id} className="rule">
        <legend className="sr-only">Rule {i + 1}</legend>
        <div className="form-grid">
          <label className="field"><span>Rule name</span><input type="text" maxLength={80} placeholder={`Rule ${i + 1}`} value={d.name} onChange={(e) => set(d.id, { name: e.target.value })} /></label>
          {RULE_FIELDS.map((f) => <label key={f.key} className="field"><span>{f.label}</span>
            <input type="text" placeholder={f.hint} value={d[f.key]} onChange={(e) => set(d.id, { [f.key]: e.target.value })} /></label>)}
          <div className="field"><button type="button" className="btn" onClick={() => setDrafts(drafts.filter((x) => x.id !== d.id))}>Remove</button></div>
        </div>
      </fieldset>)}
      <div className="ctrl">
        <button type="button" className="btn" onClick={() => setDrafts([...drafts, draftOf()])}>Add rule</button>
        <button type="submit" className="btn primary" disabled={busy}>Save rules</button>
      </div>
      {view}
    </form>
  </div>
}

/** The reports mailbox: what arrived and what the poller did with each attachment. */
function MailInbox() {
  const { adminApi: api, adminKeyPrefix: keyPrefix, decision } = useLeadership()
  const { busy, run, view } = useAction()
  const q = useApiQuery<MailInboxStatus>(decision ? queryKey(`${keyPrefix}/integrations/mail`) : null, (signal) => api.mailStatus(signal), [api])
  const s = q.data
  type Recent = MailInboxStatus['recent'][number]
  const cols: Column<Recent>[] = [
    { key: 'at', header: 'Received', left: true, value: (r) => r.received_at, render: (r) => new Date(r.received_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) },
    { key: 'from', header: 'From', left: true, value: (r) => r.sender ?? '', className: 'nm' },
    { key: 'subject', header: 'Subject', left: true, value: (r) => r.subject ?? '', className: 'nm' },
    { key: 'file', header: 'File', left: true, value: (r) => r.file_name, className: 'nm' },
    { key: 'status', header: 'Status', left: true, value: (r) => r.status, render: (r) => <span className={MAIL_TONE[r.status]}>{cap(r.status)}{r.kind ? `, ${FEED_NAME[r.kind]?.toLowerCase() ?? r.kind}` : ''}</span> },
    { key: 'reason', header: 'Detail', left: true, value: (r) => r.reason ?? (r.rows_loaded != null ? `${r.rows_loaded.toLocaleString('en-US')} rows` : ''), className: 'nm' },
  ]
  const last = s?.last_run
  return <div className="card">
    <div className="ct"><span>Reports inbox</span><span className="ks">{s?.mailbox ?? ''}</span></div>
    {q.error ? <LoadError error={q.error} onRetry={q.refetch} /> : !s ? <Skeleton height={80} /> : !s.configured ? <Empty>Not connected. Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and GRAPH_MAILBOX (docs/mail-inbox.md).</Empty> : <>
      <div className="ctrl">
        <button type="button" className="btn" disabled={busy} onClick={() => run('Inbox checked', async () => { const r = await api.mailPoll(); if (r.status === 'failed') throw new Error(r.error ?? 'Mailbox check failed'); q.refetch() })}>Check inbox now</button>
        <span className="ks">{s.schedule.enabled ? `Every ${s.schedule.every_minutes} min` : 'Automatic checks off'}{last ? `; last ${new Date(last.started_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, ${last.status}` : '; not checked yet'}</span>
        {last?.error_message && <span className="bad ks">{last.error_message}</span>}
      </div>
      {view}
      {s.recent.length ? <SortTable caption="Recent attachments" rows={s.recent} columns={cols} defaultSort={{ key: 'at', dir: -1 }} pageSize={25} /> : <Empty>No attachments yet.</Empty>}
    </>}
  </div>
}

/** Admin > Mailbox: the reports inbox and the rules for which of its mail is the dashboard's. */
function MailboxTab() {
  const { adminApi: api, adminKeyPrefix: keyPrefix, decision } = useLeadership()
  const q = useApiQuery<MailInboxStatus>(decision ? queryKey(`${keyPrefix}/integrations/mail`) : null, (signal) => api.mailStatus(signal), [api])
  return <>
    <MailInbox />
    {q.error ? <LoadError error={q.error} onRetry={q.refetch} /> : !q.data ? <Skeleton height={160} />
      : <MailRules key={JSON.stringify(q.data.schedule.rules)} status={q.data} onSaved={() => { q.refetch(); queryClient.invalidate() }} />}
  </>
}

function ImportsTab() {
  const { adminApi: api, adminKeyPrefix: keyPrefix, decision } = useLeadership()
  const { busy, run, view } = useAction()
  const [file, setFile] = useState<File | null>(null)
  const [kind, setKind] = useState<'' | LeadershipImportKind>('')
  const q = useApiQuery(decision ? queryKey(`${keyPrefix}/leadership/imports`) : null, (signal) => api.leadershipImports(50, signal), [api])
  const cols: Column<LeadershipImportFile>[] = [
    { key: 'at', header: 'Loaded', left: true, value: (f) => f.loaded_at, render: (f) => new Date(f.loaded_at).toLocaleString('en-US') },
    { key: 'kind', header: 'Feed', left: true, value: (f) => FEED_NAME[f.kind] ?? f.kind },
    { key: 'file', header: 'File', left: true, value: (f) => f.file_name, className: 'nm' },
    { key: 'status', header: 'Status', left: true, value: (f) => f.status, render: (f) => <span className={f.status === 'loaded' ? 'ok' : f.status === 'failed' ? 'bad' : 'neutral'}>{cap(f.status)}</span> },
    { key: 'rows', header: 'Rows', value: (f) => f.rows_loaded, render: (f) => `${f.rows_loaded.toLocaleString('en-US')} of ${f.rows_read.toLocaleString('en-US')}` },
    { key: 'period', header: 'Period', left: true, value: (f) => f.period_from, render: (f) => (f.period_from ? `${f.period_from} to ${f.period_to}` : '–') },
    { key: 'co', header: 'Companies', left: true, value: (f) => f.companies.join(', ') },
    { key: 'err', header: 'Errors', left: true, value: (f) => f.errors.length, render: (f) => (f.errors.length ? <details><summary>{f.errors.length}</summary><ul className="errors">{f.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></details> : '0') },
  ]
  return <>
    <div className="card">
      <div className="ct"><span>Upload</span></div>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (file) void run(`Imported ${file.name}`, () => api.leadershipUpload(file, kind || undefined)) }}>
        <label className="field"><span>File (CSV or XLSX)</span><input type="file" accept=".csv,.xlsx,.xlsm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <label className="field"><span>Feed</span><select value={kind} onChange={(e) => setKind(e.target.value as '' | LeadershipImportKind)}><option value="">Auto-detect</option><option value="pay_report">Timekeeping labor (Pay Report or labor summary)</option><option value="job_cost">Job Cost Analysis</option><option value="income_statement">Trend Income Statement</option><option value="service_feedback">Feedback and star ratings</option></select></label>
        <div className="field"><button type="submit" className="btn primary" disabled={!file || busy}>{busy ? 'Importing' : 'Import'}</button></div>
      </form>
      {view}
    </div>
    <div className="card">{q.error ? <LoadError error={q.error} onRetry={q.refetch} /> : !q.data ? <Skeleton height={200} /> : !q.data.files.length ? <Empty>No files imported yet.</Empty>
      : <SortTable caption="Imported files" rows={q.data.files} columns={cols} defaultSort={{ key: 'at', dir: -1 }} />}</div>
  </>
}

function DataTab() {
  const { adminApi: api, adminKeyPrefix: keyPrefix, decision, config, apiReachable } = useLeadership()
  const { busy, run, view } = useAction()
  const q = useApiQuery<SyncRunsResponse>(decision ? queryKey(`${keyPrefix}/integrations/runs`) : null, (signal) => api.syncRuns(40, signal), [api])
  type Run = SyncRunsResponse['runs'][number]
  const cols: Column<Run>[] = [
    { key: 'at', header: 'Started', left: true, value: (r) => r.started_at, render: (r) => new Date(r.started_at).toLocaleString('en-US') },
    { key: 'res', header: 'Feed', left: true, value: (r) => r.resource_name },
    { key: 'st', header: 'Status', left: true, value: (r) => r.status, render: (r) => <span className={r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'bad' : 'neutral'}>{cap(r.status)}</span> },
    { key: 'f', header: 'Fetched', value: (r) => r.records_fetched },
    { key: 'i', header: 'Inserted', value: (r) => r.records_inserted },
    { key: 'e', header: 'Error', left: true, value: (r) => r.error_message ?? '', className: 'nm' },
  ]
  return <>
    <div className="card">
      <div className="ct"><span>Status</span><span className="ks">{decision?.mode === 'live' ? freshnessLine(config.data) : apiReachable ? 'No data loaded' : ''}</span></div>
      <div className="ctrl">
        <button type="button" className="btn" disabled={busy} onClick={() => run('WinTeam synced', () => api.syncAll())}>Sync WinTeam</button>
        <button type="button" className="btn" disabled={busy} onClick={() => run('Sarus synced', () => api.syncSarus())}>Sync Sarus</button>
        <button type="button" className="btn" disabled={busy} onClick={() => run('PhotoValidation synced', () => api.syncPhotoValidation())}>Sync PhotoValidation</button>
        <button type="button" className="btn" disabled={busy} onClick={() => run('Marts rebuilt', () => api.rebuildMarts())}>Rebuild marts</button>
        {busy && <span className="ks">Running</span>}
      </div>
      {view}
    </div>
    <div className="card"><div className="ct"><span>Sync runs</span></div>
      {q.error ? <LoadError error={q.error} onRetry={q.refetch} /> : !q.data ? <Skeleton height={200} /> : <SortTable caption="Sync runs" rows={q.data.runs} columns={cols} defaultSort={{ key: 'at', dir: -1 }} />}</div>
  </>
}

export function Admin() {
  const { route, navigate, user } = useLeadership()
  const tab = route.adminTab ?? 'accounts'
  if (user.role !== 'admin') return <Empty>Admin only.</Empty>
  return <>
    <PageHeader title="Admin" account={false} week={false} target={false} />
    <nav className="tabs" role="tablist" aria-label="Admin">
      {ADMIN_TABS.map((t) => <button key={t} type="button" role="tab" className="tab" aria-selected={tab === t} onClick={() => navigate({ view: 'admin', adminTab: t })}>{TAB_LABEL[t]}</button>)}
    </nav>
    <section role="tabpanel" aria-label={TAB_LABEL[tab]}>
      {tab === 'accounts' ? <AccountsTab /> : tab === 'jobs' ? <JobsTab /> : tab === 'imports' ? <ImportsTab /> : tab === 'mailbox' ? <MailboxTab /> : tab === 'users' ? <UsersTab /> : tab === 'allocations' ? <AllocationsTab /> : <DataTab />}
    </section>
  </>
}
