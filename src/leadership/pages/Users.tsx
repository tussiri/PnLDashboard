import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { usersApi, type AppUser } from '../../auth/authApi'
import { ROLES, type Role } from '../../auth/roles'
import { useLeadership } from '../state'
import { Empty, LoadError, Skeleton } from '../ui'

const MIN_PASSWORD = 10
const ROLE_NAME: Record<Role, string> = { executive: 'Executive', analyst: 'Analyst', admin: 'Admin' }
const SOURCE_NAME: Record<AppUser['source'], string> = { database: 'Dashboard', environment: 'APP_USERS_JSON', development: 'Development' }
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–')

type AccountOption = { slug: string; name: string }

/** Which accounts a user may see: every account (nothing ticked) or the ticked ones. Administrators always see every account. */
function AccountPicker({ value, onChange, options, disabled }: { value: string[]; onChange: (next: string[]) => void; options: AccountOption[]; disabled?: boolean }) {
  const toggle = (slug: string) => onChange(value.includes(slug) ? value.filter((s) => s !== slug) : [...value, slug])
  return <fieldset className="picker" disabled={disabled}>
    <legend className="sr-only">Accounts</legend>
    <label className="check"><input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} />All accounts</label>
    {options.map((a) => <label key={a.slug} className="check"><input type="checkbox" checked={value.includes(a.slug)} onChange={() => toggle(a.slug)} />{a.name}</label>)}
  </fieldset>
}

function AddUser({ onAdded, accounts }: { onAdded: (username: string) => void; accounts: AccountOption[] }) {
  const [username, setUsername] = useState('')
  const [scope, setScope] = useState<string[]>([])
  const [role, setRole] = useState<Role>('executive')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try { await usersApi.create(username.trim(), role, password, role === 'admin' ? [] : scope); onAdded(username.trim()); setUsername(''); setPassword(''); setScope([]) }
    catch (err) { setError(errorText(err)) }
    finally { setBusy(false) }
  }
  return <div className="card">
    <div className="ct"><span>Add user</span></div>
    <form className="form-grid" onSubmit={submit}>
      <label className="field"><span>Username</span><input type="text" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
      <label className="field"><span>Role</span><select value={role} onChange={(e) => setRole(e.target.value as Role)}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}</select></label>
      <label className="field"><span>Password, {MIN_PASSWORD}+ characters</span><input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <div className="field"><button type="submit" className="btn primary" disabled={busy || !username.trim() || password.length < MIN_PASSWORD}>{busy ? 'Adding' : 'Add user'}</button></div>
      <div className="field wide"><span>Accounts{role === 'admin' ? ': administrators see every account' : ''}</span><AccountPicker value={scope} onChange={setScope} options={accounts} disabled={role === 'admin'} /></div>
    </form>
    {error && <p className="msg bad" role="alert">{error}</p>}
  </div>
}

function UserRow({ user, self, onChanged, accounts }: { user: AppUser; self: boolean; onChanged: (message: { ok: boolean; text: string }) => void; accounts: AccountOption[] }) {
  const [password, setPassword] = useState('')
  const [scoping, setScoping] = useState(false)
  const [scope, setScope] = useState<string[]>(user.accounts ?? [])
  const [resetting, setResetting] = useState(false)
  const [busy, setBusy] = useState(false)
  const editable = user.source === 'database'
  const change = async (patch: Parameters<typeof usersApi.update>[1], done: string) => {
    setBusy(true)
    try { await usersApi.update(user.username, patch); onChanged({ ok: true, text: done }); setResetting(false); setScoping(false); setPassword('') }
    catch (e) { onChanged({ ok: false, text: errorText(e) }) }
    finally { setBusy(false) }
  }
  const names = (slugs: string[]) => slugs.map((slug) => accounts.find((a) => a.slug === slug)?.name ?? slug).join(', ')
  const id = `u-${user.username}`
  return <tr className={user.active ? '' : 'dim'}>
    <td className="l nm">{user.username}{self && <span className="neutral"> (you)</span>}</td>
    <td className="l">{editable
      ? <><label className="sr-only" htmlFor={`${id}-role`}>Role for {user.username}</label>
        <select id={`${id}-role`} value={user.role} disabled={busy} onChange={(e) => change({ role: e.target.value as Role }, `${user.username} is now ${ROLE_NAME[e.target.value as Role]}`)}>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}</select></>
      : ROLE_NAME[user.role]}</td>
    <td className="l">{user.role === 'admin' ? <span className="neutral">All accounts</span> : scoping
      ? <><AccountPicker value={scope} onChange={setScope} options={accounts} disabled={busy} />
        <span className="ctrl"><button type="button" className="btn sm primary" disabled={busy} onClick={() => change({ accounts: scope }, `${user.username} can see ${scope.length ? names(scope) : 'every account'}`)}>Save</button>
          <button type="button" className="btn sm" onClick={() => { setScoping(false); setScope(user.accounts ?? []) }}>Cancel</button></span></>
      : <span className="ctrl">{user.accounts?.length ? names(user.accounts) : 'All accounts'}{editable && <button type="button" className="linkbtn" onClick={() => setScoping(true)}>Change</button>}</span>}</td>
    <td className="l">{user.active ? 'Active' : 'Disabled'}</td>
    <td className="l neutral">{SOURCE_NAME[user.source]}</td>
    <td className="l">{when(user.last_login_at)}</td>
    <td className="l">{editable && (resetting
      ? <span className="ctrl"><label className="sr-only" htmlFor={`${id}-pw`}>New password for {user.username}</label>
        <input id={`${id}-pw`} type="password" autoComplete="new-password" placeholder={`${MIN_PASSWORD}+ characters`} value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="button" className="btn sm primary" disabled={busy || password.length < MIN_PASSWORD} onClick={() => change({ password }, `Password reset for ${user.username}`)}>Save</button>
        <button type="button" className="btn sm" onClick={() => { setResetting(false); setPassword('') }}>Cancel</button></span>
      : <span className="ctrl">
        <button type="button" className="btn sm" disabled={busy} onClick={() => setResetting(true)}>Reset password</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => change({ active: !user.active }, `${user.username} ${user.active ? 'disabled' : 'enabled'}`)}>{user.active ? 'Disable' : 'Enable'}</button>
      </span>)}</td>
  </tr>
}

/** Admin > Users: sign-in users created in the dashboard, plus read-only APP_USERS_JSON entries. */
export function UsersTab() {
  const { apiReachable, user: me, adminConfig } = useLeadership()
  const accounts: AccountOption[] = (adminConfig.data?.accounts ?? []).map((a) => ({ slug: a.slug, name: a.name }))
  const [users, setUsers] = useState<AppUser[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const load = useCallback(() => {
    setError(null)
    usersApi.list().then((r) => setUsers(r.users)).catch(setError)
  }, [])
  useEffect(() => { if (apiReachable) load() }, [apiReachable, load])
  if (!apiReachable) return <Empty>API unreachable.</Empty>
  if (error) return <LoadError error={error} onRetry={load} />
  if (!users) return <Skeleton height={240} />
  const changed = (m: { ok: boolean; text: string }) => { setMessage(m); load() }
  return <>
    <AddUser onAdded={(name) => changed({ ok: true, text: `Added ${name}` })} accounts={accounts} />
    <div className="card">
      <div className="ct"><span>Users</span><span className="ks">{users.filter((u) => u.active).length} active</span></div>
      <div className="tw"><table><caption className="sr-only">Sign-in users</caption>
        <thead><tr><th className="nosort l">Username</th><th className="nosort l">Role</th><th className="nosort l">Accounts</th><th className="nosort l">Status</th><th className="nosort l">Source</th><th className="nosort l">Last sign-in</th><th className="nosort l"></th></tr></thead>
        <tbody>{users.map((u) => <UserRow key={u.username} user={u} self={u.username.toLowerCase() === me.username.toLowerCase()} onChanged={changed} accounts={accounts} />)}</tbody>
      </table></div>
      {message && <p className={`msg ${message.ok ? 'ok' : 'bad'}`} role="status">{message.text}</p>}
    </div>
  </>
}
