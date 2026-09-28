import { useState, type FormEvent } from 'react'
import { ApiError } from '../services/api'
import { DEV_USERS, devPassword } from './roles'
import { useAuth } from './useAuth'

export function LoginPage() {
  const { signIn, backend, apiMode } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const devNotice = backend === 'demo' || apiMode === 'dev'

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(null)
    try { await signIn(username, password) }
    catch (e) { setError(e instanceof ApiError ? (e.isNetwork ? `API unreachable: ${e.detail}` : e.detail) : e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return <main className="login" aria-labelledby="login-title">
    <form onSubmit={submit} noValidate>
      <span className="brand">Crane IFS</span>
      <h1 id="login-title">Sign in</h1>
      <label>Username<input type="text" name="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} required /></label>
      <label>Password<input type="password" name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} required /></label>
      {error && <p className="bad" role="alert">{error}</p>}
      <button type="submit" className="btn primary" disabled={busy || !username || !password}>{busy ? 'Signing in' : 'Sign in'}</button>
      {devNotice && <div className="dev" role="note">
        <b>{backend === 'demo' ? 'Demo sign-in' : 'Development sign-in'}</b>
        <ul>{DEV_USERS.map((u) => <li key={u.username}><button type="button" className="linkbtn" onClick={() => { setUsername(u.username); setPassword(devPassword(u.username)) }} disabled={busy}>{u.username}</button></li>)}</ul>
      </div>}
    </form>
  </main>
}
