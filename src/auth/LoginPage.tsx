import { Building2, LogIn } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ApiError } from '../services/api'
import { errorMessage } from '../utils'
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
    catch (e) { setError(e instanceof ApiError ? (e.isNetwork ? `API unreachable: ${e.detail}` : e.detail) : errorMessage(e)) }
    finally { setBusy(false) }
  }

  return <main className="login" aria-labelledby="login-title">
    <form className="login__card" onSubmit={submit} noValidate>
      <div className="login__brand"><span className="brand__mark"><Building2 size={20} aria-hidden="true" /></span><strong>Crane IFS</strong></div>
      <h1 id="login-title">Sign in</h1>
      <label><span>Username</span><input name="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} required /></label>
      <label><span>Password</span><input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} required /></label>
      {error && <p className="login__error" role="alert">{error}</p>}
      <button type="submit" className="primary-button" disabled={busy || !username || !password}><LogIn size={14} aria-hidden="true" />{busy ? 'Signing in' : 'Sign in'}</button>
      {devNotice && <div className="login__notice" role="note">
        <strong>{backend === 'demo' ? 'Demo sign-in' : 'Development sign-in'}</strong>
        <span>{backend === 'demo' ? 'No API is reachable; the demo dataset opens with a development user.' : 'APP_AUTH_MODE=dev: development users are enabled on this API.'}</span>
        <ul>{DEV_USERS.map((u) => <li key={u.username}><button type="button" className="text-button" onClick={() => { setUsername(u.username); setPassword(devPassword(u.username)) }} disabled={busy}>{u.username}</button><small>password {devPassword(u.username)}</small></li>)}</ul>
      </div>}
    </form>
  </main>
}
