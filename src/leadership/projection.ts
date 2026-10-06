/**
 * The trend's last weeks while their labor is still arriving (the week in progress, or a finished week whose
 * timekeeping is not loaded yet): drawn as a projection instead of a drop to zero. Projected, never observed:
 * callers label it as such.
 */
export interface TrendWeek {
  week: string
  /** Labor (cost) and invoice of the week; null when the week has no rows. */
  cost: number | null
  invoice: number | null
  lp: number | null
  sitesLp: number | null
  segs: Record<string, number | null>
}
export type ProjectedWeek<T extends TrendWeek> = T & { projected: boolean }

/** Weeks averaged for a projection. */
export const PROJECTION_BASE_WEEKS = 4
/** Only the latest weeks can be projected; an older gap is data, not lag. */
export const PROJECTION_RECENT_WEEKS = 2
/** A recent week with under this share of the base weeks' labor is still arriving. */
export const PROJECTION_SHORT_SHARE = 0.5

const mean = (xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null }

/**
 * Each of the latest PROJECTION_RECENT_WEEKS weeks that is in progress, or carries under PROJECTION_SHORT_SHARE of the
 * average labor of the PROJECTION_BASE_WEEKS complete weeks before it, takes that average as its labor (labor % against
 * its own invoice) and each group's average labor %; it is flagged projected. Other weeks pass through unchanged.
 */
export function projectRecentWeeks<T extends TrendWeek>(weeks: T[], inProgress: ReadonlySet<string>,
  /** Whether a week is among the latest the data has (default: the last PROJECTION_RECENT_WEEKS of `weeks`). */
  isRecent?: (week: string) => boolean): ProjectedWeek<T>[] {
  const out: ProjectedWeek<T>[] = []
  weeks.forEach((w, i) => {
    const base = out.slice(0, i).filter((x) => !x.projected && (x.cost ?? 0) > 0).slice(-PROJECTION_BASE_WEEKS)
    const baseCost = base.length >= 2 ? mean(base.map((x) => x.cost)) : null
    const recent = isRecent ? isRecent(w.week) : i >= weeks.length - PROJECTION_RECENT_WEEKS
    const short = baseCost != null && (w.cost ?? 0) < baseCost * PROJECTION_SHORT_SHARE
    if (!recent || baseCost == null || !(inProgress.has(w.week) || short)) { out.push({ ...w, projected: false }); return }
    const cost = Math.max(w.cost ?? 0, baseCost)
    const names = new Set(base.flatMap((x) => Object.keys(x.segs)))
    out.push({ ...w, projected: true, cost, lp: w.invoice ? cost / w.invoice : mean(base.map((x) => x.lp)),
      sitesLp: mean(base.map((x) => x.sitesLp)), segs: Object.fromEntries([...names].map((n) => [n, mean(base.map((x) => x.segs[n]))])) })
  })
  return out
}
