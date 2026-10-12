import { KeyRound } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../services/api'
import { authApi } from './authApi'

const MIN_PASSWORD = 10

/** Top-bar button and dialog: the signed-in user, any role, changes their own password. */
export function ChangePassword() {
  const dialog = useRef<HTMLDialogElement>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const reset = () => { setCurrent(''); setNext(''); setConfirm(''); setMessage(null) }
  const open = () => { reset(); dialog.current?.showModal() }
  const close = () => { dialog.current?.close(); reset() }
  const mismatch = confirm.length > 0 && confirm !== next
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await authApi.changePassword(current, next)
      setCurrent(''); setNext(''); setConfirm('')
      setMessage({ ok: true, text: 'Password changed. Other devices are signed out.' })
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError && err.status !== 0 ? err.detail : 'Could not reach the server. Try again.' })
    } finally {
      setBusy(false)
    }
  }
  return <>
    <button type="button" className="navbtn" onClick={open}><KeyRound size={14} aria-hidden="true" />Password</button>
    <dialog ref={dialog} className="pw-dialog" aria-labelledby="pw-title" onClose={reset}>
      <form onSubmit={submit}>
        <h2 id="pw-title">Change password</h2>
        <label className="field"><span>Current password</span><input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label className="field"><span>New password, {MIN_PASSWORD}+ characters</span><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <label className="field"><span>New password again</span><input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch || undefined} /></label>
        {mismatch && <p className="msg bad">The new passwords do not match.</p>}
        {message && <p className={`msg ${message.ok ? 'ok' : 'bad'}`} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
        <div className="pw-dialog__actions">
          <button type="button" className="btn" onClick={close}>{message?.ok ? 'Close' : 'Cancel'}</button>
          <button type="submit" className="btn primary" disabled={busy || !current || next.length < MIN_PASSWORD || confirm !== next}>{busy ? 'Saving' : 'Change password'}</button>
        </div>
      </form>
    </dialog>
  </>
}
