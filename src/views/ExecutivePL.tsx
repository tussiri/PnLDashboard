/**
 * Executive Overview = the executive team's "Labor P&L Dashboard", for every account.
 * Self-contained like the original HTML: its own header (title, week span, account → sub-account →
 * delivery → week selects), tabs (BU Overview, one per business unit, OT Analysis) and footer.
 * Business units, colours and targets come from GET /executive/labor-pl; sites are derived from its
 * rows. Sub-accounts (school districts, FedEx Express / Ground) come from GET /executive/accounts and
 * the delivery filter (self-performed vs subcontracted) is applied by the API.
 */
import { useMemo, useState } from 'react'
import { primarySourceOf } from '../components/AppShell'
import { BuOverviewTab } from '../components/executive/BuOverviewTab'
import { BuSiteTab } from '../components/executive/BuSiteTab'
import { OtAnalysisTab } from '../components/executive/OtAnalysisTab'
import { BASIS_LABEL, DELIVERY_OPTIONS, NONE_LABEL, WeekIndex, estimateSummary, freshnessLine, updatedLabel, weekOptionLabel } from '../components/executive/model'
import { useDashboard } from '../context/DashboardContext'
import { ApiError } from '../services/api'
import type { ExecutiveAccountsResponse, ExecutiveDelivery, ExecutiveLaborPl } from '../services/apiTypes'
import '../styles/executive.css'
import { errorMessage, fmtDate } from '../utils'
import { useReportQuery } from './shared'

const ALL = 'All'
const WEEKS = 18

export function ExecutivePL() {
  const { filters, mode, systemStatus } = useDashboard()
  const [account, setAccount] = useState<string>(() => filters.account || ALL)
  const [subAccount, setSubAccount] = useState<string | null>(null)
  const [delivery, setDelivery] = useState<ExecutiveDelivery>('all')
  const [weekChoice, setWeekChoice] = useState<string | null>(null)
  const [tab, setTab] = useState('bu')
  const accounts = useReportQuery<ExecutiveAccountsResponse>('executive/accounts', (api, signal) => api.executiveAccounts(signal))
  // `delivery=all` is the API default and `sub_account` only applies under an account, so neither is sent unless set.
  const params = useMemo(() => ({ account, weeks: WEEKS, ...(account !== ALL && subAccount ? { sub_account: subAccount } : {}), ...(delivery !== 'all' ? { delivery } : {}) }), [account, subAccount, delivery])
  const pl = useReportQuery<ExecutiveLaborPl>('executive/labor-pl', (api, signal) => api.executiveLaborPl(params, signal), params)
  const data = pl.data
  const idx = useMemo(() => (data ? new WeekIndex(data) : null), [data])
  const weeks = data?.weeks ?? []
  const week = weekChoice && weeks.includes(weekChoice) ? weekChoice : data?.selected_week && weeks.includes(data.selected_week) ? data.selected_week : weeks[weeks.length - 1] ?? null
  // Only business units with rows for this account/window (API order); an empty BU never gets a card or tab.
  const bus = idx?.bus ?? []
  const activeTab = tab === 'bu' || tab === 'ot' || bus.some((b) => b.key === tab) ? tab : 'bu'
  const activeBu = bus.find((b) => b.key === activeTab)
  const accountList = useMemo(() => (accounts.data?.accounts ?? []).filter((a) => a.name !== ALL), [accounts.data])
  const accountOptions = useMemo(() => { const names = accountList.map((a) => a.name); return account !== ALL && !names.includes(account) ? [account, ...names] : names }, [accountList, account])
  const labelFor = (name: string) => accountList.find((a) => a.name === name)?.label ?? name
  const allLabel = accounts.data?.accounts.find((a) => a.name === ALL)?.label ?? 'All key accounts'
  const accountLabel = account === ALL ? allLabel : labelFor(account)
  // The sub-account select appears only when the selected account has a real second level (>= 2 sub-accounts).
  const subAccounts = useMemo(() => { const list = account === ALL ? [] : accountList.find((a) => a.name === account)?.sub_accounts ?? []; return list.length >= 2 ? list : [] }, [accountList, account])
  const subAccountOptions = useMemo(() => (subAccount && !subAccounts.some((s) => s.name === subAccount) ? [{ name: subAccount, sites: 0 }, ...subAccounts] : subAccounts), [subAccounts, subAccount])
  const title = `${accountLabel}${subAccount ? ` · ${subAccount}` : ''} Labor P&L Dashboard`
  const partialWeeks = idx?.partialWeeks ?? new Set<string>()
  const asOfLabel = data?.as_of ? fmtDate(data.as_of) : null
  const freshness = idx && data?.rows.length ? freshnessLine(asOfLabel, idx, week) : asOfLabel ? `Data through ${asOfLabel}` : null
  const updated = updatedLabel(data?.source.synced_at)
  const source = data?.source
  const sourceLabel = source?.mode === 'empty' || (!source && mode === 'demo') ? 'Demo data (seeded dataset, not customer data)' : primarySourceOf(source ?? null, systemStatus).label ?? 'Crane IFS reporting marts'
  const est = idx && week ? estimateSummary(idx.rows(week)) : null
  const basisLine = (family: keyof typeof NONE_LABEL, label: string, m: Map<string, number> | undefined) => (m && m.size ? `${label}: ${[...m.entries()].map(([k, n]) => `${k === 'none' ? NONE_LABEL[family] : BASIS_LABEL[k] ?? k} (${n} sites)`).join(', ')}` : null)
  const deliveryLabel = DELIVERY_OPTIONS.find((o) => o.value === delivery)?.label ?? delivery
  const scopeLabel = `${subAccount ?? accountLabel}${delivery !== 'all' ? ` (${deliveryLabel.toLowerCase()} sites)` : ''}`
  const changeAccount = (name: string) => { setAccount(name); setSubAccount(null); setWeekChoice(null) }

  let body
  if (pl.loading) body = <div aria-busy="true" aria-label="Loading the labor P&L"><div className="bu-grid"><div className="skel" style={{ height: 190 }} /><div className="skel" style={{ height: 190 }} /></div><div className="chart-grid"><div className="skel" style={{ height: 340 }} /><div className="skel" style={{ height: 340 }} /></div><div className="skel" style={{ height: 220 }} /></div>
  else if (!data || !idx) body = <div className="state" role="alert"><strong>Couldn’t load the labor P&L</strong>{pl.error instanceof ApiError ? (pl.error.isNetwork ? `API unreachable · ${pl.error.detail}` : `${pl.error.status} · ${pl.error.detail}`) : errorMessage(pl.error)}<div><button type="button" onClick={pl.refetch}>Retry</button></div></div>
  else if (!data.rows.length || !week) body = <div className="state" role="status"><strong>No weekly labor rows</strong>{account === ALL && delivery === 'all' ? 'The reporting marts have no timekeeping hours for any site in the last 18 weeks.' : `${scopeLabel} has no weekly labor or vendor cost in the last 18 weeks. Pick another ${delivery !== 'all' ? 'delivery model or ' : ''}${subAccount ? 'sub-account' : 'account'}.`}</div>
  else if (activeBu) body = <BuSiteTab key={activeBu.key} idx={idx} week={week} bu={activeBu} delivery={delivery} onDelivery={setDelivery} />
  else if (activeTab === 'ot') body = <OtAnalysisTab idx={idx} week={week} />
  else body = <BuOverviewTab idx={idx} week={week} qa={data.qa} delivery={delivery} subAccounts={subAccounts.length && !subAccount ? subAccounts : null} onSelectSubAccount={(name) => { setSubAccount(name); setTab('bu') }} vendor={data.vendor ?? null} />

  return <div className="exec-pl">
    <div className="shell">
      {mode === 'demo' && <div className="notice" role="status"><strong>Demo data</strong> — seeded sites grouped into business units by geography (Crane West / Crane IFS / Sarus) with synthesized sub-accounts (school districts, divisions, funds) and a few subcontracted sites; values follow the contract rules but none of it is customer data.</div>}
      <div className="hdr">
        <div>
          <h1>{title}</h1>
          <p>Weekly labor cost, vendor cost, hours &amp; OT by site &amp; business unit{freshness ? <> — {freshness}</> : null}{updated && <span className="updated" title={data?.source.synced_at ?? undefined}> · {updated}</span>}</p>
        </div>
        <div className="hdr-controls">
          <select aria-label="Account" value={account} onChange={(e) => changeAccount(e.target.value)}>
            <option value={ALL}>{allLabel}</option>
            {accountOptions.map((name) => <option key={name} value={name}>{labelFor(name)}</option>)}
          </select>
          {subAccountOptions.length > 0 && <select aria-label="Sub-account" value={subAccount ?? ''} onChange={(e) => { setSubAccount(e.target.value || null); setWeekChoice(null) }}>
            <option value="">All {labelFor(account)}</option>
            {subAccountOptions.map((s) => <option key={s.name} value={s.name}>{s.name}{s.sites ? ` (${s.sites} ${s.sites === 1 ? 'site' : 'sites'})` : ''}</option>)}
          </select>}
          <select aria-label="Delivery" value={delivery} onChange={(e) => setDelivery(e.target.value as ExecutiveDelivery)}>
            {DELIVERY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select aria-label="Week" value={week ?? ''} onChange={(e) => setWeekChoice(e.target.value)} disabled={!weeks.length}>
            {weeks.length ? weeks.map((w) => <option key={w} value={w}>{weekOptionLabel(w, partialWeeks.has(w), idx?.daysLoaded(w) ?? 0)}</option>) : <option value="">{pl.loading ? 'Loading weeks…' : 'No weeks'}</option>}
          </select>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label="Labor P&L sections">
        <button type="button" role="tab" className={`tab ${activeTab === 'bu' ? 'active' : ''}`} aria-selected={activeTab === 'bu'} onClick={() => setTab('bu')}>BU Overview</button>
        {bus.map((bu) => <button key={bu.key} type="button" role="tab" className={`tab ${activeTab === bu.key ? 'active' : ''}`} aria-selected={activeTab === bu.key} onClick={() => setTab(bu.key)}>{bu.name}</button>)}
        <button type="button" role="tab" className={`tab ${activeTab === 'ot' ? 'active' : ''}`} aria-selected={activeTab === 'ot'} onClick={() => setTab('ot')}>OT Analysis</button>
      </div>
      {body}
      <footer className="ftr">
        <p>{scopeLabel} Labor P&amp;L — Source: {sourceLabel}{data?.as_of ? ` — as of ${fmtDate(data.as_of)}` : ''} — ~ = estimated</p>
        {est && <p>Selected week — {[basisLine('invoicing', 'invoicing', est.invoicing), basisLine('labor', 'labor cost', est.labor), basisLine('budget', 'budget', est.budget)].filter(Boolean).join(' · ')}{est.invoicingEstimated ? ` · invoicing ~ carried forward for ${est.invoicingEstimated} sites` : ''}{est.subEstimated ? ` · vendor cost ~ estimated for ${est.subEstimated} sites (month not closed)` : ''}{est.partialWeek ? ' · some sites have fewer than 7 days of labor in this week' : ''}</p>}
        <p>Direct labor is all-in payroll (priced at the job's trailing payroll rate, OT premium included). Labor % = self-performed labor (direct + agency sub) ÷ self-performed invoicing, measured against the BU target; subcontracted sites are excluded from it. Total cost = direct + agency sub + vendor; Cost % = total cost ÷ all invoicing; Margin = invoicing − total cost. Subcontracted sites carry vendor cost and invoicing but no hours.</p>
        <p>OT cost is the full OT pay (OT hrs × rate × 1.5, DT hrs × rate × 2), estimated as the OT premium plus the OT hours at each site's average payroll rate; it is included in labor cost, not added to it. OT hrs include double-time hours.{partialWeeks.size ? ' Weeks marked "in progress" have fewer than 7 days of labor; the trend charts draw them as hollow points on a dashed segment.' : ''}</p>
        {data?.notes.map((note, i) => <p key={i}>{note}</p>)}
      </footer>
    </div>
  </div>
}
