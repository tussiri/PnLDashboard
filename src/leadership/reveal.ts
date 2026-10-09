import { useEffect, useRef, useState } from 'react'

/**
 * Where a story section is in its reveal; drives `data-reveal`, which leadership.css reads (all of it inside
 * `prefers-reduced-motion: no-preference`).
 *
 * - `pending`: as first rendered. Hidden, with a CSS fallback that shows it after 3 s if the effect never runs.
 * - `waiting`: below the fold, watched by an IntersectionObserver.
 * - `play`: animating, once.
 * - `static`: drawn as is. Reduced motion, no observer, an error, or already played: nothing stays hidden.
 */
export type RevealPhase = 'pending' | 'waiting' | 'play' | 'static'

/** Longest section animation, after which the marks are drawn still. */
export const PLAY_MS = 3200

// Sections that have played during this page load, so returning to the Company page draws them still.
const played = new Set<string>()

/** For tests. */
export const resetPlayed = () => played.clear()

/**
 * Whether the section should play now, wait for the observer, or be drawn still. Pure, so the fallbacks are
 * testable without a browser.
 */
export function startPhase(env: { motionOk: boolean; hasObserver: boolean; inView: boolean }): 'play' | 'waiting' | 'static' {
  if (!env.motionOk || !env.hasObserver) return 'static'
  return env.inView ? 'play' : 'waiting'
}

/**
 * The phase is written straight onto the element's `data-reveal`, not held in React state: React renders only
 * the initial value, so no re-render, sort, table toggle or resize resets it or replays the animation.
 */
export function useRevealOnce<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null)
  const [initial] = useState<RevealPhase>(() => (played.has(key) ? 'static' : 'pending'))

  useEffect(() => {
    const el = ref.current
    if (initial === 'static' || !el) return
    const set = (phase: RevealPhase) => { el.dataset.reveal = phase }
    let timer: number | undefined
    let observer: IntersectionObserver | undefined
    const play = () => {
      played.add(key)
      set('play')
      timer = window.setTimeout(() => set('static'), PLAY_MS)
    }
    try {
      const box = el.getBoundingClientRect()
      const phase = startPhase({
        motionOk: window.matchMedia('(prefers-reduced-motion: no-preference)').matches,
        hasObserver: typeof IntersectionObserver !== 'undefined',
        inView: box.top < window.innerHeight * 0.9 && box.bottom > 0,
      })
      if (phase === 'static') { played.add(key); set('static') }
      else if (phase === 'play') play()
      else {
        observer = new IntersectionObserver((entries) => {
          if (!entries.some((e) => e.isIntersecting)) return
          observer?.disconnect()
          play()
        // As soon as the top edge passes 85% of the viewport: a share-visible threshold fires late, or never,
        // on a phone, where text and chart stack taller than the screen.
        }, { threshold: 0, rootMargin: '0px 0px -15% 0px' })
        observer.observe(el)
        set('waiting')
      }
    } catch {
      played.add(key)
      set('static')
    }
    return () => {
      observer?.disconnect()
      if (timer) window.clearTimeout(timer)
    }
  }, [key, initial])

  return [ref, initial] as const
}
