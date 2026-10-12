import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { rolesApi, usersApi, type AppRole, type AppUser } from '../../auth/authApi'
import { effective, overridesOf, PERMISSIONS, roleDefaults, type Permission, type RoleDefaults } from '../../auth/permissions'
import { NO_ACCESS } from '../../auth/roles'
import { useLeadership } from '../state'
import { Empty, LoadError, Skeleton } from '../ui'

const MIN_PASSWORD = 10
const SOURCE_NAME: Record<AppUser['source'], string> = { database: 'Dashboard', environment: 'APP_USERS_JSON', development: 'Development' }
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–')

type AccountOption = { slug: string; name: string }
type Message = { ok: boolean; text: string }
const roleName = (roles: AppRole[], slug: string) => roles.find((r) => r.slug === slug)?.name ?? slug
const PERMISSION_GROUPS = [...new Set(PERMISSIONS.map((p) => p.group))]

/** The two header rows every permission matrix shares: groups, then each permission's label (vertical). */
function MatrixHead({ lead, trail = 1 }: { lead: string[]; trail?: number }) {
  return <thead>
    <tr>{lead.map((h) => <th key={h} className="nosort l" rowSpan={2}>{h}</th>)}{PERMISSION_GROUPS.map((g) => <th key={g} className="nosort grp" colSpan={PERMISSIONS.filter((p) => p.group === g).length}>{g}</th>)}{trail > 0 && <th className="nosort" rowSpan={2}></th>}</tr>
    <tr>{PERMISSIONS.map((p) => <th key={p.key} className="nosort"><span>{p.label}</span></th>)}</tr>
  </thead>
}

function RoleSelect({ id, value, roles, onChange, disabled, label }: { id?: string; value: string; roles: AppRole[]; onChange: (slug: string) => void; disabled?: boolean; label?: string }) {
  return <select id={id} aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
    {!roles.some((r) => r.slug === value) && <option value={value}>{value}</option>}
    {roles.map((r) => <option key={r.slug} value={r.slug}>{r.name}</option>)}
  </select>
}

/** Admin > Users > Roles: one row per role, one column per permission. Ticking a box changes that role for
 * everyone holding it (their own overrides still apply on top). Administrator holds everything and No access
 * holds nothing; both are fixed. Executive and Analyst can be edited and reset; other roles can be deleted
 * once nobody holds them. */
function RolesMatrix({ roles, onChanged }: { roles: AppRole[]; onChanged: (message: Message) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [copyFrom, setCopyFrom] = useState('')
  const [renaming, setRenaming] = useState<{ slug: string; name: string } | null>(null)
  const run = async (key: string, work: () => Promise<unknown>, done: string) => {
    setBusy(key)
    try { await work(); onChanged({ ok: true, text: done }); return true }
    catch (e) { onChanged({ ok: false, text: errorText(e) }); return false }
    finally { setBusy(null) }
  }
  const add = async (e: FormEvent) => {
    e.preventDefault()
    const clean = name.trim()
    if (await run('new', () => rolesApi.create(clean, copyFrom || undefined), `Added the ${clean} role${copyFrom ? `, starting from ${roleName(roles, copyFrom)}` : ''}`)) { setName(''); setCopyFrom('') }
  }
  const rename = async (e: FormEvent) => {
    e.preventDefault()
    if (!renaming) return
    const from = roleName(roles, renaming.slug)
    if (await run(renaming.slug, () => rolesApi.update(renaming.slug, { name: renaming.name.trim() }), `${from} is now ${renaming.name.trim()}`)) setRenaming(null)
  }
  return <div className="card">
    <div className="ct"><span>Roles</span><span className="ks">A change applies to everyone holding the role</span></div>
    <form className="form-grid" onSubmit={add}>
      <label className="field"><span>New role</span><input type="text" autoComplete="off" placeholder="Regional manager" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>Start from</span><select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
        <option value="">Nothing ticked</option>
        {roles.filter((r) => r.slug !== NO_ACCESS && r.slug !== 'admin').map((r) => <option key={r.slug} value={r.slug}>{r.name}</option>)}
      </select></label>
      <div className="field"><button type="submit" className="btn primary" disabled={busy === 'new' || name.trim().length < 2}>{busy === 'new' ? 'Adding' : 'Add role'}</button></div>
    </form>
    <div className="tw"><table className="matrix"><caption className="sr-only">Permissions by role</caption>
      <MatrixHead lead={['Role', 'Users']} />
      <tbody>{roles.map((r) => <tr key={r.slug}>
        <td className="l nm">{renaming?.slug === r.slug
          ? <form className="ctrl" onSubmit={rename}>
            <label className="sr-only" htmlFor={`role-${r.slug}-name`}>New name for {r.name}</label>
            <input id={`role-${r.slug}-name`} type="text" autoComplete="off" value={renaming.name} onChange={(e) => setRenaming({ slug: r.slug, name: e.target.value })} />
            <button type="submit" className="btn sm primary" disabled={busy === r.slug || renaming.name.trim().length < 2}>Save</button>
            <button type="button" className="btn sm" onClick={() => setRenaming(null)}>Cancel</button></form>
          : <span className="ctrl">{r.name}{!r.editable && <span className="neutral">(fixed)</span>}{r.editable && <button type="button" className="linkbtn" onClick={() => setRenaming({ slug: r.slug, name: r.name })}>Rename</button>}</span>}</td>
        <td className="l">{r.users}</td>
        {PERMISSIONS.map((p) => <td key={p.key}>
          <input type="checkbox" checked={r.permissions[p.key]} disabled={!r.editable || busy === r.slug} aria-label={`${p.label} for the ${r.name} role`}
            onChange={(e) => void run(r.slug, () => rolesApi.update(r.slug, { permissions: { [p.key]: e.target.checked } }), `${r.name}: ${p.label} ${e.target.checked ? 'on' : 'off'}`)} />
        </td>)}
        <td><span className="ctrl">
          {r.built_in && r.editable && <button type="button" className="btn sm" disabled={busy === r.slug} onClick={() => void run(r.slug, () => rolesApi.reset(r.slug), `${r.name} is back to its defaults`)}>Reset</button>}
          {!r.built_in && <button type="button" className="btn sm" disabled={busy === r.slug || !r.deletable} title={r.deletable ? undefined : 'Give its users another role first'}
            onClick={() => { if (window.confirm(`Delete the ${r.name} role?`)) void run(r.slug, () => rolesApi.remove(r.slug), `Deleted the ${r.name} role`) }}>Delete</button>}
        </span></td>
      </tr>)}</tbody>
    </table></div>
  </div>
}

/** Which accounts a user may see: every account (nothing ticked) or the ticked ones. Administrators always see every account. */
function AccountPicker({ value, onChange, options, disabled }: { value: string[]; onChange: (next: string[]) => void; options: AccountOption[]; disabled?: boolean }) {
  const toggle = (slug: string) => onChange(value.includes(slug) ? value.filter((s) => s !== slug) : [...value, slug])
  return <fieldset className="picker" disabled={disabled}>
    <legend className="sr-only">Accounts</legend>
    <label className="check"><input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} />All accounts</label>
    {options.map((a) => <label key={a.slug} className="check"><input type="checkbox" checked={value.includes(a.slug)} onChange={() => toggle(a.slug)} />{a.name}</label>)}
  </fieldset>
}

function AddUser({ onAdded, accounts, roles }: { onAdded: (username: string) => void; accounts: AccountOption[]; roles: AppRole[] }) {
  const [username, setUsername] = useState('')
  const [scope, setScope] = useState<string[]>([])
  const [role, setRole] = useState('executive')
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
      <label className="field"><span>Role</span><RoleSelect value={role} roles={roles} onChange={setRole} /></label>
      <label className="field"><span>Password, {MIN_PASSWORD}+ characters</span><input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <div className="field"><button type="submit" className="btn primary" disabled={busy || !username.trim() || password.length < MIN_PASSWORD}>{busy ? 'Adding' : 'Add user'}</button></div>
      <div className="field wide"><span>Accounts{role === 'admin' ? ': administrators see every account' : ''}</span><AccountPicker value={scope} onChange={setScope} options={accounts} disabled={role === 'admin'} /></div>
    </form>
    {error && <p className="msg bad" role="alert">{error}</p>}
  </div>
}

function UserRow({ user, self, onChanged, accounts, roles }: { user: AppUser; self: boolean; onChanged: (message: Message) => void; accounts: AccountOption[]; roles: AppRole[] }) {
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
        <RoleSelect id={`${id}-role`} value={user.role} roles={roles} disabled={busy} onChange={(slug) => change({ role: slug }, `${user.username} is now ${roleName(roles, slug)}`)} /></>
      : user.role_name ?? roleName(roles, user.role)}</td>
    <td className="l">{user.role === 'admin' ? <span className="neutral">All accounts</span> : scoping
      ? <><AccountPicker value={scope} onChange={setScope} options={accounts} disabled={busy} />
        <span className="ctrl"><button type="button" className="btn sm primary" disabled={busy} onClick={() => change({ accounts: scope }, `${user.username} can see ${scope.length ? names(scope) : 'every account'}`)}>Save</button>
          <button type="button" className="btn sm" onClick={() => { setScoping(false); setScope(user.accounts ?? []) }}>Cancel</button></span></>
      : <span className="ctrl">{user.accounts?.length ? names(user.accounts) : 'All accounts'}{editable && <button type="button" className="linkbtn" onClick={() => setScoping(true)}>Change</button>}</span>}</td>
    <td className="l">{!user.active ? 'Disabled' : user.role === NO_ACCESS ? <span className="warn">Waiting for a role</span> : 'Active'}</td>
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

/** Admin > Users > Permissions: one row per user, one column per permission. A tick differing from the role's
 * default is an override (marked); Reset returns a user to the role's defaults. Administrators hold everything. */
function PermissionMatrix({ users, roles, onChanged }: { users: AppUser[]; roles: AppRole[]; onChanged: (message: Message) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const sets: RoleDefaults = Object.fromEntries(roles.map((r) => [r.slug, r.permissions]))
  const save = async (u: AppUser, values: Record<Permission, boolean>, done: string) => {
    setBusy(u.username)
    try { await usersApi.update(u.username, { permissions: overridesOf(u.role, values, sets) }); onChanged({ ok: true, text: done }) }
    catch (e) { onChanged({ ok: false, text: errorText(e) }) }
    finally { setBusy(null) }
  }
  return <div className="card">
    <div className="ct"><span>Permissions by user</span><span className="ks">Ticks that differ from the role are marked</span></div>
    <div className="tw"><table className="matrix"><caption className="sr-only">Permissions by user</caption>
      <MatrixHead lead={['User', 'Role']} />
      <tbody>{users.map((u) => {
        // No access holds nothing whatever the overrides: pick a role first.
        const editable = u.source === 'database' && u.role !== 'admin' && u.role !== NO_ACCESS
        const base = roleDefaults(u.role, sets)
        const values = u.effective_permissions ?? effective(u.role, u.permissions, sets)
        const overridden = Object.keys(overridesOf(u.role, values, sets)).length
        return <tr key={u.username} className={u.active ? '' : 'dim'}>
          <td className="l nm">{u.username}</td>
          <td className="l">{u.role_name ?? roleName(roles, u.role)}</td>
          {PERMISSIONS.map((p) => {
            const off = values[p.key] !== base[p.key]
            return <td key={p.key} className={off ? 'over' : ''}>
              <input type="checkbox" checked={values[p.key]} disabled={!editable || busy === u.username} aria-label={`${p.label} for ${u.username}`}
                onChange={(e) => void save(u, { ...values, [p.key]: e.target.checked }, `${u.username}: ${p.label} ${e.target.checked ? 'on' : 'off'}`)} />
            </td>
          })}
          <td>{editable && overridden > 0 && <button type="button" className="btn sm" disabled={busy === u.username} onClick={() => void save(u, base, `${u.username} reset to ${u.role_name ?? roleName(roles, u.role)} defaults`)}>Reset</button>}</td>
        </tr>
      })}</tbody>
    </table></div>
  </div>
}

/** Admin > Users: sign-in users created in the dashboard, plus read-only APP_USERS_JSON entries. */
export function UsersTab() {
  const { apiReachable, user: me, adminConfig } = useLeadership()
  const accounts: AccountOption[] = (adminConfig.data?.accounts ?? []).map((a) => ({ slug: a.slug, name: a.name }))
  const [users, setUsers] = useState<AppUser[] | null>(null)
  const [roles, setRoles] = useState<AppRole[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const load = useCallback(() => {
    setError(null)
    Promise.all([usersApi.list(), rolesApi.list()]).then(([u, r]) => { setUsers(u.users); setRoles(r.roles) }).catch(setError)
  }, [])
  useEffect(() => { if (apiReachable) load() }, [apiReachable, load])
  if (!apiReachable) return <Empty>API unreachable.</Empty>
  if (error) return <LoadError error={error} onRetry={load} />
  if (!users || !roles) return <Skeleton height={240} />
  const changed = (m: Message) => { setMessage(m); load() }
  const waiting = users.filter((u) => u.active && u.role === NO_ACCESS).length
  return <>
    <AddUser onAdded={(name) => changed({ ok: true, text: `Added ${name}` })} accounts={accounts} roles={roles} />
    <div className="card">
      <div className="ct"><span>Users</span><span className="ks">{users.filter((u) => u.active).length} active{waiting > 0 && `, ${waiting} waiting for a role`}</span></div>
      <div className="tw"><table><caption className="sr-only">Sign-in users</caption>
        <thead><tr><th className="nosort l">Username</th><th className="nosort l">Role</th><th className="nosort l">Accounts</th><th className="nosort l">Status</th><th className="nosort l">Source</th><th className="nosort l">Last sign-in</th><th className="nosort l"></th></tr></thead>
        <tbody>{users.map((u) => <UserRow key={u.username} user={u} self={u.username.toLowerCase() === me.username.toLowerCase()} onChanged={changed} accounts={accounts} roles={roles} />)}</tbody>
      </table></div>
      {message && <p className={`msg ${message.ok ? 'ok' : 'bad'}`} role="status">{message.text}</p>}
    </div>
    <RolesMatrix roles={roles} onChanged={changed} />
    <PermissionMatrix users={users} roles={roles} onChanged={changed} />
  </>
}
