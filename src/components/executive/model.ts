/**
 * Pure helpers behind the executive labor P&L view. They mirror the reference dashboard's
 * script functions (buSum, fmt$, fmtH, pct, lpClass, lpLabel, wowSpan, varBadge) one-to-one so
 * the numbers match the executive team's existing HTML, but read business units, colours and
 * targets from the API payload instead of constants.
 */
import type { DeliveryModel, ExecutiveBusinessUnit, ExecutiveDelivery, ExecutiveLaborPl, ExecutiveLaborRow } from '../../services/apiTypes'

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral'
export type BadgeTone = 'bok' | 'bwarn' | 'bbad'
export type WowTone = 'up-bad' | 'up-ok' | 'dn-bad' | 'dn-ok' | 'flat'

/** `fmt$`: whole dollars with thousands separators, sign dropped. */
export const fmtMoney = (v: number) => `$${Math.abs(Math.round(v)).toLocaleString('en-US')}`
/** Money that keeps its sign (margins can be negative): "−$1,235". */
export const fmtSignedMoney = (v: number) => `${Math.round(v) < 0 ? '−' : ''}${fmtMoney(v)}`
/** `fmtH`: whole hours with an "h" suffix. */
export const fmtHours = (v: number) => `${Math.round(v).toLocaleString('en-US')}h`
/** `pct`: percentage change of a over b (0 when b is 0). */
export const pctChange = (a: number, b: number) => (b ? ((a - b) / b) * 100 : 0)
export const signed = (v: number, digits = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`
export const round1 = (v: number) => Math.round(v * 10) / 10

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dateOf = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`)
/** ISO date `days` after an ISO date. */
export const addDaysIso = (iso: string, days: number) => { const d = dateOf(iso); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10) }
/**
 * A week is in progress only while its 7 days extend past `as_of` (Monday + 6 > as_of). A past week with
 * fewer labor days is a complete week with fewer working days. Without `as_of`, only the last week can be
 * in progress, and only when no site reached 7 days of labor in it.
 */
export function isWeekInProgress(week: string, asOf: string | null | undefined, isLast: boolean, rows: Pick<ExecutiveLaborRow, 'days_with_labor'>[]): boolean {
  if (asOf) return addDaysIso(week.slice(0, 10), 6) > asOf.slice(0, 10)
  return isLast && rows.length > 0 && rows.every((r) => r.days_with_labor < 7)
}
/** "Jan 5" (chart tick / select option without the prefix). */
export const shortWeek = (iso: string) => { const d = dateOf(iso); return Number.isNaN(d.getTime()) ? iso : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` }
/** "Week of Jan 5". */
export const weekLabel = (iso: string) => `Week of ${shortWeek(iso)}`
/** "Mar 2026". */
export const monthYear = (iso: string) => { const d = dateOf(iso); return Number.isNaN(d.getTime()) ? iso : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` }
/** Header subtitle span: "Dec 2025 through Mar 2026". */
export const weekSpan = (weeks: string[]) => (weeks.length ? `${monthYear(weeks[0])} through ${monthYear(weeks[weeks.length - 1])}` : '')

/** "Updated 12 min ago" from source.synced_at; null when unknown. */
export function updatedLabel(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  if (minutes < 1) return 'Updated just now'
  if (minutes < 60) return `Updated ${minutes} min ago`
  const hrs = Math.round(minutes / 60)
  if (hrs < 48) return `Updated ${hrs} h ago`
  return `Updated ${Math.round(hrs / 24)} d ago`
}

/** Week select option label: "Week of Aug 31 · in progress (4/7 days)" for a partial week. */
export const weekOptionLabel = (week: string, partial: boolean, days: number) => (partial ? `${weekLabel(week)} · in progress (${days}/7 days)` : weekLabel(week))

/** Append a two-hex-digit alpha to a #rrggbb colour (the original writes color+'88'). Other colour formats are returned unchanged. */
export const withAlpha = (color: string, alpha: string) => (/^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : color)

/** OT hours as the executive dashboard counts them: overtime plus double-time hours. */
export const otHoursOf = (r: Pick<ExecutiveLaborRow, 'ot_hours' | 'dt_hours'>) => r.ot_hours + r.dt_hours

/**
 * Full OT pay of a row, the figure the executives' original dashboard reports as "OT cost" (OT hrs × rate × 1.5,
 * DT hrs × rate × 2). The API's `ot_dollars` is only the premium (OT hrs × rate × 0.5 + DT hrs × rate × 1.0), so
 * the base pay of the OT hours is recovered from the row's own average rate: otPay = premium + (OT + DT hrs) ×
 * (direct ÷ hours). Without hours (a subcontracted or empty row) it is the premium as sent. Informational only:
 * `direct_dollars` is all-in payroll (priced at the job's trailing payroll rate, which already carries the OT
 * premium), so OT cost is included in labor cost and is never added to total cost, labor %, cost % or margin.
 */
export const otPayOf = (r: Pick<ExecutiveLaborRow, 'hours' | 'ot_hours' | 'dt_hours' | 'direct_dollars' | 'ot_dollars'>) => (r.hours > 0 ? r.ot_dollars + otHoursOf(r) * (r.direct_dollars / r.hours) : r.ot_dollars)

/**
 * Total cost of a row = direct (all-in payroll) + sub (agency or vendor). Computed here rather than read from
 * `total_dollars` so a payload that still adds the OT premium into its total cannot double count it (~5%).
 */
export const totalCostOf = (r: Pick<ExecutiveLaborRow, 'direct_dollars' | 'sub_dollars'>) => r.direct_dollars + r.sub_dollars

// ----------------------------------------------------------------- Delivery model

export const DELIVERY_OPTIONS: { value: ExecutiveDelivery; label: string }[] = [
  { value: 'all', label: 'All delivery' },
  { value: 'self_perform', label: 'Self-performed' },
  { value: 'subcontracted', label: 'Subcontracted' },
]
export const DELIVERY_LABEL: Record<DeliveryModel, string> = { self_perform: 'Self-performed', subcontracted: 'Subcontracted' }
export const DELIVERY_SHORT: Record<DeliveryModel, string> = { self_perform: 'Self', subcontracted: 'Sub' }
/**
 * Delivery model as the executives mean it, decided on evidence with the mart label as tiebreaker: a site
 * that logged hours or direct dollars self-performs (its `sub_dollars` is agency labor - KM Group at LGB3 /
 * APC2 / PSP3 - even when the job-level label says "subcontracted"); a site with no self-performed labor is
 * subcontracted when the label says so, when it came through the API's `delivery=subcontracted` filter, or
 * when it carries vendor cost. `WeekIndex` applies this once so every row it hands out carries the result.
 */
export function normalizeDelivery<T extends Pick<ExecutiveLaborRow, 'delivery_model' | 'hours' | 'direct_dollars' | 'sub_dollars'>>(r: T, filter: ExecutiveDelivery = 'all'): T {
  const selfPerformed = r.hours > 0 || r.direct_dollars > 0
  const model: DeliveryModel = selfPerformed ? 'self_perform' : r.delivery_model === 'subcontracted' || filter === 'subcontracted' || r.sub_dollars > 0 ? 'subcontracted' : 'self_perform'
  return r.delivery_model === model ? r : { ...r, delivery_model: model }
}
/** After `normalizeDelivery`: subcontracted iff `delivery_model` says so (a raw null label reads as self-performed). */
export const isSubcontracted = (r: Pick<ExecutiveLaborRow, 'delivery_model'>) => r.delivery_model === 'subcontracted'
export const deliveryOf = (r: Pick<ExecutiveLaborRow, 'delivery_model'>): DeliveryModel => (isSubcontracted(r) ? 'subcontracted' : 'self_perform')
/** Client-side mirror of the API `delivery` filter (used when a payload was fetched unfiltered). */
export const matchesDelivery = (r: Pick<ExecutiveLaborRow, 'delivery_model'>, delivery: ExecutiveDelivery) => delivery === 'all' || deliveryOf(r) === delivery

export interface BuSum {
  /** Total cost (direct all-in payroll + agency sub + vendor; `totalCostOf` summed) - the original's `dollars`. */
  dollars: number
  /** Self-performed labor dollars: direct (all-in payroll, OT premium inside) + agency sub on self-performed sites (0 for subcontracted sites). */
  labor: number
  direct: number
  /** Every `sub_dollars` (agency + vendor). */
  sub: number
  /** Agency (temp labor) sub on self-performed sites - part of labor, like the original "incl. $X agency". */
  agency: number
  /** Vendor cost of subcontracted sites - excluded from labor %, covered by cost % and margin. */
  vendor: number
  hours: number
  budHours: number
  budDollars: number
  ot: number
  /** OT premium as the API sends it (`ot_dollars`); informational, already inside `direct`. */
  otDollars: number
  /** Full OT pay (`otPayOf` summed): what the cards and tables show as "OT cost"; included in `labor`, never added to `dollars`. */
  otPay: number
  invoicing: number
  /** Invoicing of the self-performed sites only: the denominator of labor %. */
  selfInvoicing: number
  subEstimated: boolean
  agencyEstimated: boolean
  vendorEstimated: boolean
  /** Any row's invoicing is a carried-forward estimate (live API `invoicing_estimated`). */
  invoicingEstimated: boolean
  sites: number
  /** Sites by delivery model (selfSites + subSites = sites). */
  selfSites: number
  subSites: number
}

export const emptySum = (): BuSum => ({ dollars: 0, labor: 0, direct: 0, sub: 0, agency: 0, vendor: 0, hours: 0, budHours: 0, budDollars: 0, ot: 0, otDollars: 0, otPay: 0, invoicing: 0, selfInvoicing: 0, subEstimated: false, agencyEstimated: false, vendorEstimated: false, invoicingEstimated: false, sites: 0, selfSites: 0, subSites: 0 })

/** Self-performed labor of one row: direct (all-in payroll) + agency sub (0 for a subcontracted site). The OT premium is inside direct and is never added again. */
export const laborOf = (r: Pick<ExecutiveLaborRow, 'direct_dollars' | 'sub_dollars' | 'delivery_model'>) => (isSubcontracted(r) ? 0 : r.direct_dollars + r.sub_dollars)

/** `buSum`: totals for a set of rows (a BU-week, or every row of a week). */
export function sumRows(rows: ExecutiveLaborRow[]): BuSum {
  return rows.reduce<BuSum>((a, r) => ({
    dollars: a.dollars + totalCostOf(r), labor: a.labor + laborOf(r), direct: a.direct + r.direct_dollars, sub: a.sub + r.sub_dollars,
    agency: a.agency + (isSubcontracted(r) ? 0 : r.sub_dollars), vendor: a.vendor + (isSubcontracted(r) ? r.sub_dollars : 0),
    agencyEstimated: a.agencyEstimated || (!isSubcontracted(r) && r.sub_estimated), vendorEstimated: a.vendorEstimated || (isSubcontracted(r) && r.sub_estimated),
    hours: a.hours + r.hours, budHours: a.budHours + r.budget_hours, budDollars: a.budDollars + r.budget_dollars,
    ot: a.ot + otHoursOf(r), otDollars: a.otDollars + r.ot_dollars, otPay: a.otPay + otPayOf(r), invoicing: a.invoicing + r.invoicing, selfInvoicing: a.selfInvoicing + (isSubcontracted(r) ? 0 : r.invoicing),
    subEstimated: a.subEstimated || r.sub_estimated, invoicingEstimated: a.invoicingEstimated || Boolean(r.invoicing_estimated), sites: a.sites + 1,
    selfSites: a.selfSites + (isSubcontracted(r) ? 0 : 1), subSites: a.subSites + (isSubcontracted(r) ? 1 : 0),
  }), emptySum())
}

/**
 * Labor % of invoicing, the executives' original semantics: self-performed labor (all-in direct payroll + agency
 * sub such as KM Group at LGB3 / APC2 / PSP3) ÷ the self-performed sites' invoicing; 0 without any. Measured against the
 * BU target. Subcontracted sites are excluded entirely - cost % and margin cover them.
 */
export const laborPctOf = (s: Pick<BuSum, 'labor' | 'selfInvoicing'>) => (s.selfInvoicing ? (s.labor / s.selfInvoicing) * 100 : 0)
/** Cost % of invoicing: total cost incl. vendor ÷ invoicing; null without invoicing so subcontracted sites without billing never read as 0%. */
export const costPctOf = (s: Pick<BuSum, 'dollars' | 'invoicing'>): number | null => (s.invoicing ? (s.dollars / s.invoicing) * 100 : null)
/** Margin = invoicing − total cost (contract: computed client-side). */
export const marginOf = (s: Pick<BuSum, 'dollars' | 'invoicing'>) => s.invoicing - s.dollars
/** Margin as % of invoicing; null without invoicing. */
export const marginPctOf = (s: Pick<BuSum, 'dollars' | 'invoicing'>): number | null => (s.invoicing ? (marginOf(s) / s.invoicing) * 100 : null)
/** Margin tone: negative is bad, under 10% of invoicing is a watch. */
export const marginTone = (s: Pick<BuSum, 'dollars' | 'invoicing'>): Tone => { const p = marginPctOf(s); return p === null ? 'neutral' : p < 0 ? 'bad' : p < 10 ? 'warn' : 'ok' }
/** Cost % tone against the BU thresholds (same bands as labor %: the targets were set as a share of invoicing). */
export const costPctTone = (bu: ExecutiveBusinessUnit | undefined, s: Pick<BuSum, 'dollars' | 'invoicing'>): Tone => { const p = costPctOf(s); return p === null ? 'neutral' : lpClass(bu, p) }

export interface DeliverySplit { self: BuSum; sub: BuSum; total: BuSum }
/** Self-performed vs subcontracted totals of a set of rows (the "Delivery mix" card). */
export function deliverySplit(rows: ExecutiveLaborRow[]): DeliverySplit {
  return { self: sumRows(rows.filter((r) => !isSubcontracted(r))), sub: sumRows(rows.filter(isSubcontracted)), total: sumRows(rows) }
}

export interface SubAccountRollup {
  name: string
  s: BuSum
  prev: BuSum | null
  /** WoW % change of total cost; null without a comparable previous week. */
  wowCost: number | null
}
/** Rows grouped by `sub_account` (rows without one fall under their account), ordered by invoicing desc then total cost desc. */
export function subAccountRollup(rows: ExecutiveLaborRow[], prevRows: ExecutiveLaborRow[] | null): SubAccountRollup[] {
  const nameOf = (r: ExecutiveLaborRow) => r.sub_account || r.account
  const group = (list: ExecutiveLaborRow[]) => { const m = new Map<string, ExecutiveLaborRow[]>(); for (const r of list) m.set(nameOf(r), [...(m.get(nameOf(r)) ?? []), r]); return m }
  const cur = group(rows), prv = prevRows ? group(prevRows) : null
  return [...cur.entries()].map(([name, list]) => {
    const s = sumRows(list)
    const prev = prv?.has(name) ? sumRows(prv.get(name)!) : null
    return { name, s, prev, wowCost: prev && prev.dollars ? pctChange(s.dollars, prev.dollars) : null }
  }).sort((a, b) => b.s.invoicing - a.s.invoicing || b.s.dollars - a.s.dollars)
}

/**
 * Business units to render: the API's array order (or `sort_order` when every entry carries one),
 * limited to units that have at least one row in the payload so an account never shows an empty BU.
 */
export function visibleBusinessUnits(bus: ExecutiveBusinessUnit[], rows: Pick<ExecutiveLaborRow, 'bu'>[]): ExecutiveBusinessUnit[] {
  const present = new Set(rows.map((r) => r.bu))
  const kept = bus.filter((bu) => present.has(bu.name))
  return kept.every((bu) => typeof bu.sort_order === 'number') ? [...kept].sort((a, b) => a.sort_order! - b.sort_order!) : kept
}

/** Site pills on a BU card: the first `cap` codes plus how many were left out. */
export const PILL_CAP = 12
export const capList = <T,>(items: T[], cap = PILL_CAP): { shown: T[]; more: number } => (items.length > cap ? { shown: items.slice(0, cap), more: items.length - cap } : { shown: items, more: 0 })

/** Rows indexed by week and by week+BU for O(1) lookups while rendering. */
export class WeekIndex {
  readonly weeks: string[]
  /** Renderable business units (see visibleBusinessUnits). */
  readonly bus: ExecutiveBusinessUnit[]
  /** The in-progress week (its 7 days extend past `as_of`): selectable, but left out of trend series. */
  readonly partialWeeks: ReadonlySet<string>
  private byWeek = new Map<string, ExecutiveLaborRow[]>()
  private byWeekBu = new Map<string, ExecutiveLaborRow[]>()
  private sumCache = new Map<string, BuSum>()

  constructor(payload: Pick<ExecutiveLaborPl, 'weeks' | 'rows' | 'business_units'> & Partial<Pick<ExecutiveLaborPl, 'delivery' | 'as_of'>>) {
    this.weeks = payload.weeks
    this.bus = visibleBusinessUnits(payload.business_units, payload.rows)
    for (const raw of payload.rows) {
      const row = normalizeDelivery(raw, payload.delivery ?? 'all')
      const week = row.week.slice(0, 10)
      this.byWeek.set(week, [...(this.byWeek.get(week) ?? []), row])
      const key = `${week}|${row.bu}`
      this.byWeekBu.set(key, [...(this.byWeekBu.get(key) ?? []), row])
    }
    const last = this.weeks[this.weeks.length - 1]
    this.partialWeeks = new Set(this.weeks.filter((w) => isWeekInProgress(w, payload.as_of, w === last, this.byWeek.get(w) ?? [])))
  }
  isPartial(week: string): boolean { return this.partialWeeks.has(week) }
  /** Days of labor loaded for a week (the most any site has); 7 for a complete week. */
  daysLoaded(week: string): number { const rows = this.byWeek.get(week) ?? []; return rows.length ? Math.min(7, Math.max(...rows.map((r) => r.days_with_labor))) : 0 }
  /** The latest week that is not in progress (the executives' default). */
  latestCompleteWeek(): string | null { for (let i = this.weeks.length - 1; i >= 0; i--) if (!this.partialWeeks.has(this.weeks[i])) return this.weeks[i]; return null }
  /** Trend series value: null for partial weeks so an in-progress week never reads as a cliff. */
  trend<T>(week: string, value: () => T): T | null { return this.partialWeeks.has(week) ? null : value() }
  /** Every row of a week (`getAllSites`). */
  rows(week: string | null): ExecutiveLaborRow[] { return week ? this.byWeek.get(week) ?? [] : [] }
  /** Rows of one BU in a week (`getSites`). */
  buRows(week: string | null, bu: string): ExecutiveLaborRow[] { return week ? this.byWeekBu.get(`${week}|${bu}`) ?? [] : [] }
  buSum(week: string | null, bu: string): BuSum {
    if (!week) return emptySum()
    const key = `${week}|${bu}`
    let value = this.sumCache.get(key)
    if (!value) { value = sumRows(this.buRows(week, bu)); this.sumCache.set(key, value) }
    return value
  }
  /** Totals across every BU for a week. */
  weekSum(week: string | null): BuSum { return sumRows(this.rows(week)) }
  prevWeek(week: string | null): string | null { const i = week ? this.weeks.indexOf(week) : -1; return i > 0 ? this.weeks[i - 1] : null }
  /** BU invoicing for a week (`getInv(w)[bu]`). */
  invoicing(week: string | null, bu: string): number { return this.buSum(week, bu).invoicing }
  /** Distinct site codes of a BU across every week, sorted. */
  buSites(bu: string): string[] { return [...new Set(this.weeks.flatMap((w) => this.buRows(w, bu).map((r) => r.site)))].sort() }
  /** Site codes of a BU present in one week, sorted. */
  buSitesIn(week: string | null, bu: string): string[] { return [...new Set(this.buRows(week, bu).map((r) => r.site))].sort() }
  /** The row of one site in a week. */
  site(week: string | null, site: string): ExecutiveLaborRow | undefined { return this.rows(week).find((r) => r.site === site) }
  /** The BU a site belongs to (first row seen). */
  buOfSite(site: string): string | null { for (const w of this.weeks) { const r = this.rows(w).find((x) => x.site === site); if (r) return r.bu } return null }
  /** Sites with vendor (subcontractor / agency) cost in any week, per BU. */
  subSites(bu: string): string[] { return [...new Set(this.weeks.flatMap((w) => this.buRows(w, bu).filter((r) => r.sub_dollars > 0).map((r) => r.site)))].sort() }
  /** Sites of a BU that self-perform (carry hours) in any week, sorted. */
  selfSites(bu: string): string[] { return [...new Set(this.weeks.flatMap((w) => this.buRows(w, bu).filter((r) => !isSubcontracted(r)).map((r) => r.site)))].sort() }
  /** Distinct sub-account names across every week (insertion order of first appearance). */
  subAccounts(): string[] { return [...new Set(this.weeks.flatMap((w) => this.rows(w).map((r) => r.sub_account).filter((x): x is string => Boolean(x))))] }
  bu(name: string): ExecutiveBusinessUnit | undefined { return this.bus.find((b) => b.name === name) }
  color(bu: string): string { return this.bu(bu)?.color ?? '#888888' }
}

/** Labor-% tone against the BU thresholds (`lpClass`). */
export const lpClass = (bu: ExecutiveBusinessUnit | undefined, lp: number): Tone => (!bu ? 'neutral' : lp > bu.high_pct ? 'bad' : lp > bu.target_pct ? 'warn' : 'ok')
export const lpLabel = (bu: ExecutiveBusinessUnit | undefined, lp: number): string => (!bu ? '—' : lp > bu.high_pct ? 'High' : lp > bu.target_pct ? 'Watch' : 'On track')
/** `varBadge`: variance % badge tone (>3 bad, >0 warn, else ok). */
export const varBadgeTone = (v: number): BadgeTone => (v > 3 ? 'bbad' : v > 0 ? 'bwarn' : 'bok')
/** pp-vs-target badge tone (>5 bad, >0 warn, else ok). */
export const ppBadgeTone = (v: number): BadgeTone => (v > 5 ? 'bbad' : v > 0 ? 'bwarn' : 'bok')
/** `wowSpan`: direction tone; `bad` says whether an increase is unfavourable. |v| < 0.5 is flat. */
export const wowTone = (v: number, bad: boolean): WowTone => (Math.abs(v) < 0.5 ? 'flat' : v > 0 ? (bad ? 'up-bad' : 'up-ok') : bad ? 'dn-ok' : 'dn-bad')
/** OT % of hours tone (>15 bad, >8 warn). */
export const otTone = (v: number): Tone => (v > 15 ? 'bad' : v > 8 ? 'warn' : 'ok')
export const otLabel = (v: number) => (v > 15 ? 'High' : v > 8 ? 'Elevated' : 'Normal')
/** Site KPI variance tone: `vc(v, inv)` in the original. */
export const varianceTone = (v: number, increaseIsBad: boolean): Tone => (increaseIsBad ? (v > 5 ? 'bad' : v > 0 ? 'warn' : 'ok') : v < -5 ? 'bad' : v < 0 ? 'warn' : 'ok')

/** Average BU target for the "Total" row. */
export const averageTarget = (bus: ExecutiveBusinessUnit[]) => (bus.length ? bus.reduce((a, b) => a + b.target_pct, 0) / bus.length : 0)

/** Counts of estimate flags for the footer: which bases fed the selected week. */
export function estimateSummary(rows: ExecutiveLaborRow[]) {
  const count = <K extends string>(pick: (r: ExecutiveLaborRow) => K) => { const m = new Map<K, number>(); for (const r of rows) m.set(pick(r), (m.get(pick(r)) ?? 0) + 1); return m }
  return {
    invoicing: count((r) => r.invoicing_basis),
    labor: count((r) => r.labor_cost_basis),
    budget: count((r) => r.budget_basis),
    subEstimated: rows.filter((r) => r.sub_estimated).length,
    invoicingEstimated: rows.filter((r) => r.invoicing_estimated).length,
    partialWeek: rows.some((r) => r.days_with_labor < 7),
  }
}

export const BASIS_LABEL: Record<string, string> = {
  job_cost_month_prorated: 'closed-month job-cost revenue prorated by days',
  ar_invoice_prorated: 'AR invoices for the service month prorated by days',
  contract: 'contract billing (12/53 rule)',
  carry_forward: 'latest recent closed month carried forward (estimate)',
  none: 'no invoicing basis',
  trailing_job_rate: 'hours × trailing job rate (estimate)',
  job_cost: 'closed-month job cost',
  hours_x_rate: 'hours × timekeeping rate',
  daily_budget: 'daily budget',
  hbc: 'monthly labor budget prorated by days',
}
/** `none` reads differently per basis family. */
export const NONE_LABEL: Record<'invoicing' | 'labor' | 'budget', string> = { invoicing: 'no invoicing basis', labor: 'no labor cost basis', budget: 'no budget' }

/**
 * Header freshness line. With an in-progress last week:
 * "Data through Sep 3, 2026 · week of Aug 31 in progress (4 of 7 days) · showing the latest complete week";
 * otherwise "Data through Sep 3, 2026". `asOfLabel` is the already formatted as_of date.
 */
export function freshnessLine(asOfLabel: string | null, idx: WeekIndex, selectedWeek: string | null): string {
  const parts = [asOfLabel ? `Data through ${asOfLabel}` : 'Data through date not reported']
  const last = idx.weeks[idx.weeks.length - 1]
  if (last && idx.isPartial(last)) {
    parts.push(`${weekLabel(last).replace(/^Week/, 'week')} in progress (${idx.daysLoaded(last)} of 7 days)`)
    const latestComplete = idx.latestCompleteWeek()
    if (selectedWeek && selectedWeek === latestComplete) parts.push('showing the latest complete week')
    else if (selectedWeek) parts.push(`showing ${weekLabel(selectedWeek).replace(/^Week/, 'week')}`)
  }
  return parts.join(' · ')
}
