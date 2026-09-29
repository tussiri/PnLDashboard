import { useEffect, useState, type FormEvent } from 'react'
import { ApiError } from '../services/api'
import { authApi } from './authApi'
import { DEV_USERS, devPassword } from './roles'
import { useAuth } from './useAuth'

const MIN_PASSWORD = 10
const errorText = (e: unknown) => (e instanceof ApiError ? (e.isNetwork ? `API unreachable: ${e.detail}` : e.detail) : e instanceof Error ? e.message : String(e))

/** First administrator: shown while the API reports setup is open (no user exists yet). */
function SetupForm({ onDone }: { onDone: (username: string, password: string) => Promise<void> }) {
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mismatch = confirm !== '' && confirm !== password
  const ready = token && username && password.length >= MIN_PASSWORD && password === confirm

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !ready) return
    setBusy(true); setError(null)
    try { await authApi.setup(token.trim(), username.trim(), password); await onDone(username.trim(), password) }
    catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  return <form onSubmit={submit} noValidate>
    <span className="brand">Crane IFS</span>
    <h1 id="login-title">Create administrator</h1>
    <label>Setup code<input type="password" name="setup-code" autoComplete="off" autoFocus value={token} onChange={(e) => setToken(e.target.value)} disabled={busy} required /></label>
    <label>Username<input type="text" name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} required /></label>
    <label>Password<input type="password" name="new-password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} required aria-describedby="pw-rule" /></label>
    <span id="pw-rule" className="hint">At least {MIN_PASSWORD} characters</span>
    <label>Confirm password<input type="password" name="confirm-password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} required aria-invalid={mismatch} /></label>
    {mismatch && <p className="bad" role="alert">Passwords do not match</p>}
    {error && <p className="bad" role="alert">{error}</p>}
    <button type="submit" className="btn primary" disabled={busy || !ready}>{busy ? 'Creating' : 'Create administrator'}</button>
  </form>
}

export function LoginPage() {
  const { signIn, backend, apiMode } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [setup, setSetup] = useState(false)
  const devNotice = backend === 'demo' || apiMode === 'dev'

  useEffect(() => {
    if (backend !== 'api') return
    const controller = new AbortController()
    authApi.setupStatus(controller.signal).then((r) => setSetup(r.needed)).catch(() => setSetup(false))
    return () => controller.abort()
  }, [backend])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(null)
    try { await signIn(username, password) }
    catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  if (setup) return <main className="login" aria-labelledby="login-title"><SetupForm onDone={signIn} /></main>

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
