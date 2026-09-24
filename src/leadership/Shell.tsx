import { LogOut, Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { formatRoute, weekEndOf, weekLabel, type View } from './routes'
import { useLeadership, type Theme } from './state'

const NAV: { view: View; label: string; admin?: boolean }[] = [
  { view: 'home', label: 'Home' },
  { view: 'account', label: 'Account' },
  { view: 'analytics', label: 'Analytics' },
  { view: 'admin', label: 'Admin', admin: true },
]
const THEMES: { theme: Theme; label: string; icon: ReactNode }[] = [
  { theme: 'system', label: 'System theme', icon: <Monitor size={14} aria-hidden="true" /> },
  { theme: 'light', label: 'Light theme', icon: <Sun size={14} aria-hidden="true" /> },
  { theme: 'dark', label: 'Dark theme', icon: <Moon size={14} aria-hidden="true" /> },
]

/** "Data as of" line: last mart rebuild and the pay report's last covered day. */
export function freshnessLine(config: ReturnType<typeof useLeadership>['config']['data']): string {
  if (!config) return ''
  const rebuilt = config.status.rebuilt_at ? `Data as of ${new Date(config.status.rebuilt_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Data not built'
  const through = config.status.pay_report_through
  const pay = through.length ? `pay report through ${through.map((p) => p.through).sort().at(-1)}` : 'no pay report loaded'
  const relay = config.status.syncs.find((s) => s.integration_name === 'relay')
  const relayText = relay?.completed_at ? `; Relay synced ${new Date(relay.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''
  return `${rebuilt}; ${pay}${relayText}`
}

export function Shell({ children }: { children: ReactNode }) {
  const { route, user, signOut, theme, setTheme, decision, selectedAccount, weekStart, targetOverride } = useLeadership()
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
          {NAV.filter((n) => !n.admin || user.role === 'admin').map((n) => <a key={n.view} href={hrefFor(n.view)} aria-current={route.view === n.view ? 'page' : undefined}>{n.label}</a>)}
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
export function PageHeader({ title, subtitle, account = true, week = true, target = true, extra }: { title: string; subtitle?: ReactNode; account?: boolean; week?: boolean; target?: boolean; extra?: ReactNode }) {
  const { featured, selectedAccount, config, weekStart, navigate, targetOverride, route } = useLeadership()
  const weeks = [...(config.data?.weeks ?? [])].reverse()
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
      {extra}
      {account && route.view !== 'analytics' && <><label htmlFor="acct">Account</label>
        <select id="acct" value={selectedAccount?.slug ?? ''} onChange={(e) => navigate({ account: e.target.value, site: undefined })}>
          {featured.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
        </select></>}
      {week && <><label htmlFor="wk">Week</label>
        <select id="wk" value={weekStart ?? ''} onChange={(e) => navigate({ week: weekEndOf(e.target.value) })}>
          {weeks.map((w) => <option key={w.week_start} value={w.week_start}>{weekLabel(w.week_start)}{w.in_progress ? ' (in progress)' : ''}</option>)}
        </select></>}
      {target && <><label htmlFor="tgt">Target %</label>
        <input id="tgt" type="number" step="0.5" min="30" max="120" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commitTarget} onKeyDown={(e) => { if (e.key === 'Enter') commitTarget() }}
          aria-describedby="tgt-hint" />
        <span id="tgt-hint" className="sr-only">{targetOverride != null ? 'Overrides the account and segment targets' : 'Account target'}</span>
        {targetOverride != null && <button type="button" className="linkbtn" onClick={() => navigate({ target: undefined }, { replace: true })}>Reset</button>}</>}
    </div>
  </header>
}
