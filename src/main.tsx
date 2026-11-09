import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './leadership/leadership.css'

// A tab opened before a deploy still runs the old bundle, whose lazy chunks the deploy removed: loading one
// fails. Reload once to pick up the new build; the timestamp stops a loop if the chunk is truly missing.
window.addEventListener('vite:preloadError', (event) => {
  const key = 'chunk-reload-at'
  let last = 0
  try { last = Number(sessionStorage.getItem(key)) || 0 } catch { /* storage blocked */ }
  if (Date.now() - last < 30_000) return
  try { sessionStorage.setItem(key, String(Date.now())) } catch { /* storage blocked */ }
  event.preventDefault()
  window.location.reload()
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
