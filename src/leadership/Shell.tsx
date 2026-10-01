import type { Permission } from '../auth/permissions'
import { LogOut, Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { formatRoute, monthLabel, weekEndOf, weekLabel, type View } from './routes'
import { Pills } from './ui'
import { useLeadership, type Theme } from './state'

/** admin: administrators only; every: users who see every account (not those limited to some); permission: what the user must hold. */
const NAV: { view: View; label: string; admin?: boolean; every?: boolean; permission?: Permission }[] = [
  { view: 'company', label: 'Company', every: true, permission: 'view.company' },
  { view: 'home', label: 'Home' },
  { view: 'account', label: 'Account' },
  { view: 'analytics', label: 'Analytics', every: true, permission: 'view.analytics' },
  { view: 'admin', label: 'Admin', admin: true },
]
const THEMES: { theme: Theme; label: string; icon: ReactNode }[] = [
  { theme: 'system', label: 'System theme', icon: <Monitor size={14} aria-hidden="true" /> },
  { theme: 'light', label: 'Light theme', icon: <Sun size={14} aria-hidden="true" /> },
  { theme: 'dark', label: 'Dark theme', icon: <Moon size={14} aria-hidden="true" /> },
]

type Config = ReturnType<typeof useLeadership>['config']['data']
const stamp = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** Page subtitle: when the marts were last rebuilt. */
export function updatedLine(config: Config): string {
  if (!config) return ''
  return config.status.rebuilt_at ? `Updated ${stamp(config.status.rebuilt_at)}` : 'Not built'
}

/** Admin status line: last rebuild, pay report coverage and the last Relay and PhotoValidation syncs. */
export function freshnessLine(config: Config): string {
  if (!config) return ''
  const through = config.status.pay_report_through
  const synced = (name: string, label: string) => {
    const run = config.status.syncs.find((s) => s.integration_name === name)
    return run?.completed_at ? `${label} ${stamp(run.completed_at)}` : null
  }
  return [updatedLine(config), through.length ? `Pay report through ${through.map((p) => p.through).sort().at(-1)}` : 'No pay report',
    synced('relay', 'Relay'), synced('photovalidation', 'PhotoValidation')].filter(Boolean).join('. ')
}

export function Shell({ children }: { children: ReactNode }) {
  const { route, user, signOut, theme, setTheme, decision, selectedAccount, weekStart, targetOverride, can, unlimited } = useLeadership()
  const next = THEMES[(THEMES.findIndex((t) => t.theme === theme) + 1) % THEMES.length]
  const current = THEMES.find((t) => t.theme === theme)!
  const carry = { account: selectedAccount?.slug, week: weekStart ? weekEndOf(weekStart) : undefined, target: targetOverride != null ? targetOverride * 100 : undefined }
  const hrefFor = (view: View) => formatRoute(view === 'account' ? { view, account: selectedAccount?.slug, week: carry.week, target: carry.target } : view === 'admin' ? { view } : { view, ...carry })
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="topbar">
      <div className="topbar__in">
        <span className="brand">Crane IFS</span>
        <nav className="nav" aria-label="Main">
          {NAV.filter((n) => (!n.admin || user.role === 'admin') && (!n.every || unlimited) && (!n.permission || can(n.permission))).map((n) => <a key={n.view} href={hrefFor(n.view)} aria-current={route.view === n.view ? 'page' : undefined}>{n.label}</a>)}
        </nav>
        <div className="topbar__end">
          <span className="user">{user.username}</span>
          <button type="button" className="iconbtn" onClick={() => setTheme(next.theme)} aria-label={`${current.label}; switch to ${next.label.toLowerCase()}`} title={current.label}>{current.icon}</button>
          <button type="button" className="iconbtn" onClick={signOut} aria-label="Sign out" title="Sign out"><LogOut size={14} aria-hidden="true" /></button>
        </div>
      </div>
    </div>
    {decision?.banner && <div className="demo-banner" role="status"><div>{decision.banner}</div></div>}
    <main className="shell" id="main" tabIndex={-1}>{children}</main>
  </>
}

/** Page header: title, subtitle and the shared account / week / target controls. */
export function PageHeader({ title, subtitle, account = true, week = true, target = true, period = false, extra }: { title: string; subtitle?: ReactNode; account?: boolean; week?: boolean; target?: boolean; period?: boolean; extra?: ReactNode }) {
  const { featured, selectedAccount, config, weekStart, navigate, targetOverride, route, monthMode, month, can } = useLeadership()
  const periodSwitch = period && can('data.month')
  const weeks = [...(config.data?.weeks ?? [])].reverse()
  const months = [...new Set(weeks.map((w) => w.week_start.slice(0, 7)))]
  const [draft, setDraft] = useState('')
  const accountTarget = selectedAccount ? (selectedAccount.target_labor_pct * 100).toFixed(1) : ''
  useEffect(() => { setDraft(targetOverride != null ? String(Math.round(targetOverride * 1000) / 10) : accountTarget) }, [targetOverride, accountTarget])
  const commitTarget = () => {
    const v = Number(draft)
    if (!draft || !Number.isFinite(v) || v <= 0 || v >= 200 || draft === accountTarget) navigate({ target: undefined }, { replace: true })
    else navigate({ target: v }, { replace: true })
  }
  return <header className="page">
    <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
    <div className="ctrl">
      {account && route.view !== 'analytics' && featured.length > 1 && <><label htmlFor="acct">Account</label>
        <select id="acct" value={selectedAccount?.slug ?? ''} onChange={(e) => navigate({ account: e.target.value, site: undefined })}>
          {featured.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
        </select></>}
      {periodSwitch && <Pills label="Period" value={monthMode ? 'month' : 'week'} onChange={(v) => navigate({ period: v === 'month' ? 'month' : undefined, month: undefined }, { replace: true })}
        options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />}
      {periodSwitch && monthMode && <><label htmlFor="mo">Month</label>
        <select id="mo" value={month ?? ''} onChange={(e) => navigate({ month: e.target.value }, { replace: true })}>
          {months.map((m) => <option key={m} value={m}>{monthLabel(`${m}-01`)}</option>)}
        </select></>}
      {week && !(periodSwitch && monthMode) && <><label htmlFor="wk">Week</label>
        <select id="wk" value={weekStart ?? ''} onChange={(e) => navigate({ week: weekEndOf(e.target.value) })}>
          {weeks.map((w) => <option key={w.week_start} value={w.week_start}>{weekLabel(w.week_start)}{w.in_progress ? ' (in progress)' : ''}</option>)}
        </select></>}
      {target && <><label htmlFor="tgt">Target %</label>
        <input id="tgt" type="number" step="0.5" min="30" max="120" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commitTarget} onKeyDown={(e) => { if (e.key === 'Enter') commitTarget() }}
          aria-describedby="tgt-hint" />
        <span id="tgt-hint" className="sr-only">{targetOverride != null ? 'Overrides the account and segment targets' : 'Account target'}</span>
        {targetOverride != null && <button type="button" className="linkbtn" onClick={() => navigate({ target: undefined }, { replace: true })}>Reset</button>}</>}
      {extra}
    </div>
  </header>
}
