/** Small presentational pieces shared by the executive tabs (badges, WoW arrows, KPI tiles, cards, tables). */
import type { CSSProperties, ReactNode } from 'react'
import { type BadgeTone, type Tone, signed, wowTone } from './model'

export const Badge = ({ tone, children }: { tone: BadgeTone; children: ReactNode }) => <span className={`badge ${tone}`}>{children}</span>

/** `wowSpan`: arrow + signed % (flat under 0.5%). `bad` = an increase is unfavourable. */
export function Wow({ v, bad, suffix }: { v: number; bad: boolean; suffix?: string }) {
  const tone = wowTone(v, bad)
  if (tone === 'flat') return <span className="wow flat">—{suffix ? ` ${suffix}` : ''}</span>
  return <span className={`wow ${tone}`}>{v > 0 ? '↑' : '↓'} {signed(v)}%{suffix ? ` ${suffix}` : ''}</span>
}

/** Signed-percent WoW without the arrow (OT tab): up is bad. */
export const WowPlain = ({ v, suffix }: { v: number; suffix?: string }) => <span className={`wow ${v > 0 ? 'up-bad' : 'dn-ok'}`}>{signed(v)}%{suffix ? ` ${suffix}` : ''}</span>

/** The original's "~est" / "~" estimate marker. */
export const Est = ({ label = '~est' }: { label?: string }) => <span className="est" title="Estimated"> {label}</span>

export const Dash = () => <span className="neutral">—</span>

export const Swatch = ({ color, small }: { color: string; small?: boolean }) => <span className={`sw ${small ? 'sw-sm' : ''}`} style={{ background: color }} aria-hidden="true" />

export function Card({ title, titleColor, className, style, children }: { title?: ReactNode; titleColor?: string; className?: string; style?: CSSProperties; children: ReactNode }) {
  return <div className={`card ${className ?? ''}`} style={style}>{title !== undefined && <div className="ct" style={titleColor ? { color: titleColor } : undefined}>{title}</div>}{children}</div>
}

export function Kpi({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return <div className="kpi"><div className="kl">{label}</div><div className="kv">{value}</div>{children}</div>
}

export const Ks = ({ tone = 'neutral', style, title, children }: { tone?: Tone; style?: CSSProperties; /** Hover text for a definition (e.g. how full OT pay is derived). */ title?: string; children: ReactNode }) => <div className={`ks ${tone}`} style={style} title={title}>{children}</div>

/** An honest empty state that keeps the original card slot at its height. */
export function EmptySlot({ title, hint, height }: { title: string; hint?: string; height?: number }) {
  return <div className="empty" style={height ? { height } : undefined} role="status"><strong>{title}</strong>{hint && <span>{hint}</span>}</div>
}

export const Table = ({ children, ariaLabel }: { children: ReactNode; ariaLabel: string }) => <div className="tbl"><table aria-label={ariaLabel}>{children}</table></div>
