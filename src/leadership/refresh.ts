import { useEffect, useRef } from 'react'
import type { LeadershipConfig } from '../services/apiTypes'

/** How often an open page asks whether the data has been rebuilt. */
export const CHECK_EVERY_MS = 5 * 60_000

/** The marker that changes after each finished rebuild of the marts. */
export const dataVersionOf = (config: LeadershipConfig | undefined) =>
  config ? `${config.status.rebuilt_at ?? ''}|${config.status.leadership_rebuilt_at ?? ''}` : undefined

/**
 * Keeps a page that is left open on a screen up to date with each rebuild, without a reload: every few
 * minutes, and as soon as the tab is shown again, the configuration is fetched in the background (a hidden
 * tab asks nothing); when its rebuild marker differs from the one the page was drawn with, `reloads` run,
 * each keeping its data on screen until the new data arrives. Story sections that have played stay still.
 */
export function useRefreshOnRebuild(config: { data: LeadershipConfig | undefined; reload: () => void }, reloads: (() => void)[]) {
  const version = dataVersionOf(config.data)
  const seen = useRef(version)
  const reloadsRef = useRef(reloads)
  reloadsRef.current = reloads
  const reloadConfig = config.reload

  useEffect(() => {
    if (version === undefined) return
    if (seen.current !== undefined && seen.current !== version) reloadsRef.current.forEach((r) => r())
    seen.current = version
  }, [version])

  useEffect(() => {
    const check = () => { if (document.visibilityState === 'visible') reloadConfig() }
    const timer = window.setInterval(check, CHECK_EVERY_MS)
    document.addEventListener('visibilitychange', check)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', check) }
  }, [reloadConfig])
}
