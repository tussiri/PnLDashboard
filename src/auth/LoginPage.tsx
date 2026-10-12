import { useEffect, useState, type FormEvent } from 'react'
import { ApiError } from '../services/api'
import { authApi, MICROSOFT_SIGN_IN_PATH } from './authApi'
import { DEV_USERS, devPassword } from './roles'
import { useAuth } from './useAuth'

const MIN_PASSWORD = 10
const errorText = (e: unknown) => (e instanceof ApiError ? (e.isNetwork ? `API unreachable: ${e.detail}` : e.detail) : e instanceof Error ? e.message : String(e))

/** Why a Microsoft sign-in came back without a session (`?signin_error=` from /auth/callback/entra). */
const MICROSOFT_ERRORS: Record<string, string> = {
  cancelled: 'Microsoft sign-in was cancelled.',
  expired: 'The Microsoft sign-in took too long or was started in another window. Try again.',
  not_provisioned: 'Your Microsoft account cannot use this dashboard: it has been disabled, or its email cannot be a username. Ask an administrator.',
  off: 'Microsoft sign-in is not set up on this dashboard.',
  failed: 'Microsoft sign-in could not be completed. Try again, or ask an administrator.',
}

function readMicrosoftError(): string | null {
  if (typeof window === 'undefined') return null
  const code = new URLSearchParams(window.location.search).get('signin_error')
  return code ? MICROSOFT_ERRORS[code] ?? MICROSOFT_ERRORS.failed : null
}

/** Drop `?signin_error=` from the address so a reload does not show it again. */
function clearMicrosoftError() {
  const params = new URLSearchParams(window.location.search)
  if (!params.has('signin_error')) return
  params.delete('signin_error')
  const query = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
}

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
  const { signIn, backend, apiMode, signInOptions } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [microsoftError] = useState(readMicrosoftError)
  useEffect(clearMicrosoftError, [])
  const microsoft = backend === 'api' && signInOptions.microsoft
  // Microsoft for everyone; the password form stays for administrators, folded away.
  const adminsOnly = microsoft && signInOptions.password === 'admins'
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

  const fields = <>
    <label>Username<input type="text" name="username" autoComplete="username" autoFocus={!microsoft} value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} required /></label>
    <label>Password<input type="password" name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} required /></label>
    {error && <p className="bad" role="alert">{error}</p>}
    <button type="submit" className={`btn${microsoft ? '' : ' primary'}`} disabled={busy || !username || !password}>{busy ? 'Signing in' : microsoft ? 'Sign in with password' : 'Sign in'}</button>
  </>

  return <main className="login" aria-labelledby="login-title">
    <form onSubmit={submit} noValidate>
      <span className="brand">Crane IFS</span>
      <h1 id="login-title">Sign in</h1>
      {microsoftError && <p className="bad" role="alert">{microsoftError}</p>}
      {microsoft && <a className="btn primary ms" href={MICROSOFT_SIGN_IN_PATH}>Sign in with Microsoft</a>}
      {microsoft && !adminsOnly && <span className="or">or with a username and password</span>}
      {adminsOnly ? <details className="admin-pw"><summary>Administrator sign-in</summary><div className="admin-pw__fields">{fields}</div></details> : fields}
      {devNotice && <div className="dev" role="note">
        <b>{backend === 'demo' ? 'Demo sign-in' : 'Development sign-in'}</b>
        <ul>{DEV_USERS.map((u) => <li key={u.username}><button type="button" className="linkbtn" onClick={() => { setUsername(u.username); setPassword(devPassword(u.username)) }} disabled={busy}>{u.username}</button></li>)}</ul>
      </div>}
    </form>
  </main>
}
