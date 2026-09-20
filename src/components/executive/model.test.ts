import { describe, expect, it } from 'vitest'
import type { ExecutiveLaborRow } from '../../services/apiTypes'
import { createDemoApi, DEMO_BUSINESS_UNITS, DEMO_EXEC_LAST_WEEK, DEMO_EXEC_SELECTED_WEEK, DEMO_SUB_ACCOUNT_RULES, demoExecWeeks } from '../../services/demoApi'
import { WeekIndex, addDaysIso, averageTarget, capList, isWeekInProgress, costPctOf, costPctTone, deliveryOf, deliverySplit, normalizeDelivery, freshnessLine, fmtSignedMoney, isSubcontracted, laborOf, laborPctOf, marginOf, marginPctOf, marginTone, matchesDelivery, otHoursOf, otPayOf, subAccountRollup, totalCostOf, updatedLabel, weekOptionLabel, fmtHours, fmtMoney, lpClass, lpLabel, pctChange, ppBadgeTone, shortWeek, sumRows, varBadgeTone, visibleBusinessUnits, weekLabel, weekSpan, wowTone } from './model'

const api = createDemoApi({ latencyMs: 0 })

describe('executive labor P&L model', () => {
  it('formats like the reference dashboard (fmt$, fmtH, pct, week labels)', () => {
    expect(fmtMoney(68068.18)).toBe('$68,068')
    expect(fmtMoney(-1234.6)).toBe('$1,235')
    expect(fmtHours(3617.8)).toBe('3,618h')
    expect(pctChange(110, 100)).toBeCloseTo(10)
    expect(pctChange(5, 0)).toBe(0)
    expect(shortWeek('2026-01-05')).toBe('Jan 5')
    expect(weekLabel('2026-05-04')).toBe('Week of May 4')
    expect(weekSpan(['2025-12-22', '2026-03-30'])).toBe('Dec 2025 through Mar 2026')
  })

  it('applies the reference thresholds for labor %, variance badges and WoW arrows', () => {
    const bu = DEMO_BUSINESS_UNITS[0] // Crane West 59.5 / 65
    expect(lpClass(bu, 58)).toBe('ok'); expect(lpLabel(bu, 58)).toBe('On track')
    expect(lpClass(bu, 60)).toBe('warn'); expect(lpLabel(bu, 60)).toBe('Watch')
    expect(lpClass(bu, 66)).toBe('bad'); expect(lpLabel(bu, 66)).toBe('High')
    expect(varBadgeTone(3.1)).toBe('bbad'); expect(varBadgeTone(1)).toBe('bwarn'); expect(varBadgeTone(-2)).toBe('bok')
    expect(ppBadgeTone(5.1)).toBe('bbad'); expect(ppBadgeTone(0.2)).toBe('bwarn'); expect(ppBadgeTone(-1)).toBe('bok')
    expect(wowTone(0.3, true)).toBe('flat'); expect(wowTone(4, true)).toBe('up-bad'); expect(wowTone(-4, true)).toBe('dn-ok'); expect(wowTone(4, false)).toBe('up-ok'); expect(wowTone(-4, false)).toBe('dn-bad')
    expect(averageTarget(DEMO_BUSINESS_UNITS)).toBeCloseTo((59.5 + 64.5 + 64.5 + 64.5) / 4)
  })

  it('demo adapter synthesizes 18 Monday-based weeks with consistent totals and BU membership', async () => {
    const pl = await api.executiveLaborPl({})
    expect(pl.source.mode).toBe('empty')
    expect(pl.weeks).toHaveLength(18)
    expect(pl.weeks.at(-1)).toBe(DEMO_EXEC_LAST_WEEK)
    expect(pl.selected_week).toBe(DEMO_EXEC_SELECTED_WEEK)
    expect(demoExecWeeks(3)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14'])
    for (const w of pl.weeks) expect(new Date(`${w}T00:00:00Z`).getUTCDay()).toBe(1)
    expect(pl.business_units.map((b) => b.name)).toEqual(['Crane West', 'Crane IFS', 'Crane Southwest', 'Sarus'])
    expect(pl.rows.length).toBeGreaterThan(100)
    for (const r of pl.rows) {
      // The UI derives total cost itself (direct all-in payroll + sub); the payload's total_dollars is never trusted to exclude the OT premium.
      expect(totalCostOf(r)).toBeCloseTo(r.direct_dollars + r.sub_dollars, 6)
      expect(pl.business_units.some((b) => b.name === r.bu)).toBe(true)
      // Contract row semantics: self-performed sites carry hours; subcontracted sites carry vendor cost and no hours.
      if (r.delivery_model === 'subcontracted') { expect(r.hours).toBe(0); expect(r.direct_dollars).toBe(0); expect(r.ot_hours).toBe(0); expect(r.sub_dollars).toBeGreaterThan(0) }
      else expect(r.hours).toBeGreaterThan(0)
      expect(r.days_with_labor).toBeGreaterThanOrEqual(1)
      expect(r.days_with_labor).toBeLessThanOrEqual(7)
    }
    expect(pl.rows.some((r) => r.delivery_model === 'subcontracted')).toBe(true)
    // September weeks are estimates: AR-prorated invoicing, trailing rate, sub flagged.
    const sep = pl.rows.filter((r) => r.week === '2026-09-07')
    expect(sep.every((r) => r.labor_cost_basis === 'trailing_job_rate' && r.invoicing_basis === 'ar_invoice_prorated')).toBe(true)
    expect(sep.some((r) => r.sub_estimated)).toBe(true)
    // The last (partial) week only has Monday's labor.
    expect(pl.rows.filter((r) => r.week === DEMO_EXEC_LAST_WEEK).every((r) => r.days_with_labor === 1)).toBe(true)
    // Closed weeks are job-cost based.
    expect(pl.rows.filter((r) => r.week === '2026-08-03').every((r) => r.labor_cost_basis === 'job_cost' && !r.sub_estimated)).toBe(true)
    // Labor % lands in the executive range the thresholds were built for.
    const idx = new WeekIndex(pl)
    const s = idx.weekSum(pl.selected_week)
    expect(s.invoicing).toBeGreaterThan(0)
    const lp = (s.dollars / s.invoicing) * 100
    expect(lp).toBeGreaterThan(40); expect(lp).toBeLessThan(90)
    expect(sumRows(idx.buRows(pl.selected_week, 'Crane West')).sites).toBe(idx.buSitesIn(pl.selected_week, 'Crane West').length)
    expect(idx.prevWeek(pl.weeks[0])).toBeNull()
    expect(idx.prevWeek(pl.weeks[1])).toBe(pl.weeks[0])
  })

  it('filters by account and lists accounts for the selector', async () => {
    const accounts = await api.executiveAccounts()
    expect(accounts.accounts.length).toBeGreaterThan(3)
    const first = accounts.accounts[0]
    const pl = await api.executiveLaborPl({ account: first.name, weeks: 8 })
    expect(pl.account).toBe(first.name)
    expect(pl.weeks).toHaveLength(8)
    expect(pl.rows.every((r) => r.account === first.name)).toBe(true)
    expect(pl.business_units.every((b) => first.business_units.includes(b.name))).toBe(true)
    const all = await api.executiveLaborPl({ account: 'All' })
    expect(all.account).toBe('All')
  })
})

describe('demo budgets across the month boundary', () => {
  it('keeps the in-progress month budget on a calendar-day basis (no 2x jump in September)', async () => {
    const pl = await api.executiveLaborPl({})
    const idx = new WeekIndex(pl)
    const aug = idx.buSum('2026-08-03', 'Crane West'), sep = idx.buSum('2026-09-07', 'Crane West')
    expect(sep.budDollars / aug.budDollars).toBeGreaterThan(0.8)
    expect(sep.budDollars / aug.budDollars).toBeLessThan(1.25)
    expect(sep.dollars / aug.dollars).toBeGreaterThan(0.7)
    expect(sep.dollars / aug.dollars).toBeLessThan(1.3)
    expect(sep.budHours / aug.budHours).toBeGreaterThan(0.8)
    expect(sep.budHours / aug.budHours).toBeLessThan(1.25)
    // Hours run within ±25% of scheduled hours in every full week.
    for (const w of pl.weeks.filter((x) => !idx.isPartial(x))) { const s = idx.weekSum(w); expect(s.hours / s.budHours).toBeGreaterThan(0.75); expect(s.hours / s.budHours).toBeLessThan(1.25) }
  })
})

describe('business unit visibility, order and site pills', () => {
  const bus = [{ key: 'sarus', name: 'Sarus', color: '#7C3AED', target_pct: 64.5, high_pct: 70 }, { key: 'crane_ifs', name: 'Crane IFS', color: '#1F9E89', target_pct: 64.5, high_pct: 70 }, { key: 'crane_west', name: 'Crane West', color: '#378ADD', target_pct: 59.5, high_pct: 65 }, { key: 'crane_southwest', name: 'Crane Southwest', color: '#D97706', target_pct: 64.5, high_pct: 70 }]
  it('keeps the API array order and drops units without rows', () => {
    const rows = [{ bu: 'Crane West' }, { bu: 'Sarus' }, { bu: 'Crane IFS' }]
    expect(visibleBusinessUnits(bus, rows).map((b) => b.name)).toEqual(['Sarus', 'Crane IFS', 'Crane West'])
    expect(visibleBusinessUnits(bus, [])).toEqual([])
  })
  it('honours sort_order when every unit carries one', () => {
    const ordered = bus.map((b, i) => ({ ...b, sort_order: [3, 1, 0, 2][i] }))
    expect(visibleBusinessUnits(ordered, bus.map((b) => ({ bu: b.name }))).map((b) => b.name)).toEqual(['Crane West', 'Crane IFS', 'Crane Southwest', 'Sarus'])
  })
  it('hides a BU with no rows for an account in the demo too', async () => {
    const accounts = await api.executiveAccounts()
    const noSouthwest = accounts.accounts.find((a) => !a.business_units.includes('Crane Southwest'))!
    const pl = await api.executiveLaborPl({ account: noSouthwest.name })
    const idx = new WeekIndex(pl)
    expect(idx.bus.some((b) => b.name === 'Crane Southwest')).toBe(false)
    expect(idx.bus.every((b) => pl.rows.some((r) => r.bu === b.name))).toBe(true)
    const all = new WeekIndex(await api.executiveLaborPl({}))
    expect(all.bus.map((b) => b.name)).toEqual(['Crane West', 'Crane IFS', 'Crane Southwest', 'Sarus'])
  })
  it('caps site pills at 12 with a +N more count', () => {
    const sites = Array.from({ length: 110 }, (_, i) => `S${i}`)
    expect(capList(sites)).toEqual({ shown: sites.slice(0, 12), more: 98 })
    expect(capList(sites.slice(0, 12))).toEqual({ shown: sites.slice(0, 12), more: 0 })
  })
})

describe('in-progress week detection', () => {
  const bu = [{ key: 'crane_ifs', name: 'Crane IFS', color: '#1D9E75', target_pct: 64.5, high_pct: 70 }]
  const wk = (week: string, days: number) => row({ site: `S-${week}`, week, hours: 10, direct_dollars: 100, invoicing: 500, days_with_labor: days })
  it('marks a week in progress only when its 7 days extend past as_of', () => {
    expect(addDaysIso('2026-08-31', 6)).toBe('2026-09-06')
    expect(isWeekInProgress('2026-08-31', '2026-09-04', true, [])).toBe(true)
    expect(isWeekInProgress('2026-08-24', '2026-09-04', false, [{ days_with_labor: 2 }])).toBe(false)
    expect(isWeekInProgress('2026-08-31', '2026-09-06', true, [{ days_with_labor: 4 }])).toBe(false)
    expect(isWeekInProgress('2026-08-31', '2026-09-05T10:00:00Z', true, [])).toBe(true)
    // Without as_of only the last week can be in progress, and only when no site reached 7 days.
    expect(isWeekInProgress('2026-08-31', null, true, [{ days_with_labor: 4 }])).toBe(true)
    expect(isWeekInProgress('2026-08-31', null, true, [{ days_with_labor: 4 }, { days_with_labor: 7 }])).toBe(false)
    expect(isWeekInProgress('2026-08-24', null, false, [{ days_with_labor: 2 }])).toBe(false)
  })
  it('keeps past summer weeks with few labor days as plain complete weeks (Plano ISD bug)', () => {
    const weeks = ['2026-06-01', '2026-06-08', '2026-06-15', '2026-08-24', '2026-08-31']
    const idx = new WeekIndex({ weeks, business_units: bu, as_of: '2026-09-04', rows: [wk('2026-06-01', 2), wk('2026-06-15', 2), wk('2026-08-24', 7), wk('2026-08-31', 4)] })
    expect([...idx.partialWeeks]).toEqual(['2026-08-31'])
    expect(idx.isPartial('2026-06-01')).toBe(false); expect(idx.isPartial('2026-06-08')).toBe(false)
    expect(idx.latestCompleteWeek()).toBe('2026-08-24')
    expect(idx.trend('2026-06-01', () => 1)).toBe(1); expect(idx.trend('2026-08-31', () => 1)).toBeNull()
    expect(weekOptionLabel('2026-06-01', idx.isPartial('2026-06-01'), idx.daysLoaded('2026-06-01'))).toBe('Week of Jun 1')
    expect(weekOptionLabel('2026-08-31', idx.isPartial('2026-08-31'), idx.daysLoaded('2026-08-31'))).toBe('Week of Aug 31 · in progress (4/7 days)')
    expect(freshnessLine('Sep 4, 2026', idx, '2026-08-24')).toBe('Data through Sep 4, 2026 · week of Aug 31 in progress (4 of 7 days) · showing the latest complete week')
    // Once as_of passes the Sunday, the same week is complete even with 4 labor days.
    const later = new WeekIndex({ weeks, business_units: bu, as_of: '2026-09-07', rows: [wk('2026-08-31', 4)] })
    expect(later.partialWeeks.size).toBe(0); expect(later.latestCompleteWeek()).toBe('2026-08-31')
  })
})

describe('header freshness', () => {
  it('formats the updated label from synced_at', () => {
    const now = Date.parse('2026-09-03T12:00:00Z')
    expect(updatedLabel('2026-09-03T11:48:00Z', now)).toBe('Updated 12 min ago')
    expect(updatedLabel('2026-09-03T11:59:40Z', now)).toBe('Updated just now')
    expect(updatedLabel('2026-09-03T06:00:00Z', now)).toBe('Updated 6 h ago')
    expect(updatedLabel('2026-08-30T12:00:00Z', now)).toBe('Updated 4 d ago')
    expect(updatedLabel(null, now)).toBeNull()
  })
  it('explains the in-progress week and the default complete week', async () => {
    const pl = await api.executiveLaborPl({})
    const idx = new WeekIndex(pl)
    expect(idx.latestCompleteWeek()).toBe('2026-09-07')
    expect(idx.daysLoaded('2026-09-14')).toBe(1)
    expect(idx.daysLoaded('2026-09-07')).toBe(7)
    expect(freshnessLine('Sep 14, 2026', idx, '2026-09-07')).toBe('Data through Sep 14, 2026 · week of Sep 14 in progress (1 of 7 days) · showing the latest complete week')
    expect(freshnessLine('Sep 14, 2026', idx, '2026-08-31')).toBe('Data through Sep 14, 2026 · week of Sep 14 in progress (1 of 7 days) · showing week of Aug 31')
    expect(weekOptionLabel('2026-09-14', true, 1)).toBe('Week of Sep 14 · in progress (1/7 days)')
    expect(weekOptionLabel('2026-09-07', false, 7)).toBe('Week of Sep 7')
    expect(pl.source.synced_at).toBeTruthy()
    // No partial week: plain "Data through".
    const complete = new WeekIndex({ ...pl, weeks: pl.weeks.slice(0, -1), rows: pl.rows.filter((r) => r.week !== '2026-09-14') })
    expect(freshnessLine('Sep 14, 2026', complete, '2026-09-07')).toBe('Data through Sep 14, 2026')
  })
})

// ------------------------------------------------------------ Sub-accounts and delivery model

/** A minimal week × site row; everything not given is zero / self-performed. */
const row = (o: Partial<ExecutiveLaborRow> & { site: string }): ExecutiveLaborRow => ({
  week: '2026-09-07', bu: 'Crane IFS', job_number: o.site, site_name: o.site, account: 'Summit Education', delivery_model: 'self_perform',
  invoicing: 0, invoicing_basis: 'job_cost_month_prorated', hours: 0, ot_hours: 0, dt_hours: 0, budget_hours: 0, budget_dollars: 0, budget_basis: 'none',
  direct_dollars: 0, ot_dollars: 0, sub_dollars: 0, sub_estimated: false, labor_cost_basis: 'job_cost', days_with_labor: 7,
  ...o, total_dollars: o.total_dollars ?? (o.direct_dollars ?? 0) + (o.ot_dollars ?? 0) + (o.sub_dollars ?? 0),
})
const selfA = row({ site: 'A', sub_account: 'District 1', invoicing: 10_000, hours: 300, ot_hours: 20, direct_dollars: 5_000, ot_dollars: 500 })
const selfB = row({ site: 'B', sub_account: 'District 1', invoicing: 8_000, hours: 250, direct_dollars: 4_500, sub_dollars: 300 })
const subC = row({ site: 'C', sub_account: 'District 2', delivery_model: 'subcontracted', invoicing: 12_000, sub_dollars: 10_200, sub_estimated: true })
const subD = row({ site: 'D', sub_account: 'District 2', delivery_model: 'subcontracted', invoicing: 0, sub_dollars: 1_000 })

describe('margin, cost % and labor % (self-performed vs total cost)', () => {
  it('splits labor (all-in direct + agency) from vendor cost and keeps total = labor + vendor, never adding the OT premium', () => {
    const s = sumRows([selfA, selfB, subC, subD])
    // selfB's $300 sub is agency labor on a self-performed site (counted in labor); subC/subD's sub is vendor cost.
    // selfA's $500 ot_dollars premium is already inside its all-in direct $5,000, so labor is 5,000 + 4,800, not 10,300.
    expect(s.labor).toBe(9_800); expect(s.agency).toBe(300); expect(s.vendor).toBe(11_200); expect(s.sub).toBe(11_500); expect(s.dollars).toBe(21_000)
    expect(s.labor + s.vendor).toBe(s.dollars)
    expect(s.otDollars).toBe(500)
    expect(s.agencyEstimated).toBe(false); expect(s.vendorEstimated).toBe(true)
    expect(s.sites).toBe(4); expect(s.selfSites).toBe(2); expect(s.subSites).toBe(2)
    expect(s.hours).toBe(550); expect(s.ot).toBe(20); expect(s.subEstimated).toBe(true)
    expect(s.selfInvoicing).toBe(18_000)
    expect(laborPctOf(s)).toBeCloseTo((9_800 / 18_000) * 100)
    expect(costPctOf(s)).toBeCloseTo((21_000 / 30_000) * 100)
    expect(marginOf(s)).toBe(9_000)
    expect(marginPctOf(s)).toBeCloseTo((9_000 / 30_000) * 100)
    // A payload whose total_dollars still adds the premium (the fixture's 5,500) does not leak into total cost.
    expect(selfA.total_dollars).toBe(5_500); expect(totalCostOf(selfA)).toBe(5_000); expect(laborOf(selfA)).toBe(5_000); expect(sumRows([selfA]).dollars).toBe(5_000)
    expect(laborOf(subC)).toBe(0); expect(totalCostOf(subC)).toBe(10_200)
  })
  it('reports OT cost as the full OT pay (premium + OT hours at the site average rate), included in labor cost', () => {
    // SBN1, week of Aug 24: 2,150.55 h, 384.87 OT h, $39,837.33 direct, $3,144 premium -> the executives' file shows ~$9,944 (384.87 h × ~$25.8).
    const sbn1 = row({ site: 'SBN1', hours: 2_150.55, ot_hours: 384.87, direct_dollars: 39_837.33, ot_dollars: 3_144, invoicing: 60_000 })
    const pay = otPayOf(sbn1)
    expect(pay).toBeCloseTo(3_144 + 384.87 * (39_837.33 / 2_150.55), 6)
    expect(pay).toBeGreaterThan(10_000); expect(pay).toBeLessThan(10_500)
    expect(pay / 384.87).toBeGreaterThan(25); expect(pay / 384.87).toBeLessThan(28) // ≈ 1.5 × the ~$18.5 average rate
    // Double-time hours count in the OT hours priced at the average rate.
    const dt = row({ site: 'DT', hours: 100, ot_hours: 10, dt_hours: 4, direct_dollars: 2_000, ot_dollars: 100 + 80 })
    expect(otHoursOf(dt)).toBe(14)
    expect(otPayOf(dt)).toBeCloseTo(180 + 14 * 20, 6)
    // Without hours there is no rate to recover: the premium as sent (0 for a subcontracted site).
    expect(otPayOf(row({ site: 'Z', ot_dollars: 250 }))).toBe(250)
    expect(otPayOf(subC)).toBe(0)
    // Summed per scope alongside the premium; neither changes total cost, labor %, cost % or margin.
    const s = sumRows([sbn1, dt, subC])
    expect(s.otPay).toBeCloseTo(otPayOf(sbn1) + otPayOf(dt), 6); expect(s.otDollars).toBe(3_144 + 180)
    expect(s.dollars).toBeCloseTo(39_837.33 + 2_000 + 10_200, 6); expect(s.labor).toBeCloseTo(39_837.33 + 2_000, 6)
    expect(laborPctOf(s)).toBeCloseTo(((39_837.33 + 2_000) / 60_000) * 100)
    expect(marginOf(s)).toBeCloseTo(72_000 - s.dollars, 6)
  })
  it('never divides by zero invoicing and tones margins', () => {
    const none = sumRows([subD])
    expect(none.selfInvoicing).toBe(0)
    expect(laborPctOf(none)).toBe(0); expect(costPctOf(none)).toBeNull(); expect(marginPctOf(none)).toBeNull()
    // A subcontracted site's invoicing never dilutes labor %: only self-performed billing is the denominator.
    expect(laborPctOf(sumRows([selfA, subC]))).toBeCloseTo(50)
    expect(costPctOf(sumRows([selfA, subC]))).toBeCloseTo((15_200 / 22_000) * 100)
    expect(marginOf(none)).toBe(-1_000); expect(marginTone(none)).toBe('neutral')
    expect(marginTone({ dollars: 110, invoicing: 100 })).toBe('bad')
    expect(marginTone({ dollars: 95, invoicing: 100 })).toBe('warn')
    expect(marginTone({ dollars: 60, invoicing: 100 })).toBe('ok')
    expect(costPctTone(DEMO_BUSINESS_UNITS[0], { dollars: 66, invoicing: 100 })).toBe('bad')
    expect(costPctTone(DEMO_BUSINESS_UNITS[0], { dollars: 50, invoicing: 100 })).toBe('ok')
    expect(costPctTone(undefined, { dollars: 50, invoicing: 0 })).toBe('neutral')
    expect(fmtSignedMoney(-1234.6)).toBe('−$1,235'); expect(fmtSignedMoney(1234.6)).toBe('$1,235'); expect(fmtSignedMoney(-0.2)).toBe('$0')
  })
  it('normalizes the delivery model on evidence: hours or direct dollars mean self-performed, whatever the job label says', () => {
    // LGB3-style row: the mart labels the job "subcontracted" because it buys agency labor, but it logs 4,000 hours.
    const lgb3 = row({ site: 'LGB3', delivery_model: 'subcontracted', hours: 4082, direct_dollars: 73_634, ot_dollars: 3_400, sub_dollars: 3_948, invoicing: 112_131 })
    expect(normalizeDelivery(lgb3).delivery_model).toBe('self_perform')
    const s = sumRows([normalizeDelivery(lgb3)])
    expect(s.labor).toBe(77_582); expect(s.agency).toBe(3_948); expect(s.vendor).toBe(0); expect(laborPctOf(s)).toBeCloseTo((77_582 / 112_131) * 100)
    // No hours, no direct: the label decides, then the API filter, then vendor cost; otherwise self-performed.
    expect(normalizeDelivery(row({ site: 'V', delivery_model: 'subcontracted', sub_dollars: 1_000 })).delivery_model).toBe('subcontracted')
    expect(normalizeDelivery(row({ site: 'N', delivery_model: null }), 'subcontracted').delivery_model).toBe('subcontracted')
    expect(normalizeDelivery(row({ site: 'N', delivery_model: null, sub_dollars: 500 })).delivery_model).toBe('subcontracted')
    expect(normalizeDelivery(row({ site: 'N', delivery_model: null })).delivery_model).toBe('self_perform')
    expect(normalizeDelivery(row({ site: 'S', delivery_model: 'self_perform' }), 'subcontracted').delivery_model).toBe('subcontracted')
    // Unchanged rows are returned as the same object; WeekIndex applies the rule with the payload's echoed filter.
    expect(normalizeDelivery(selfA)).toBe(selfA)
    const idx = new WeekIndex({ weeks: ['2026-09-07'], business_units: [{ key: 'crane_ifs', name: 'Crane IFS', color: '#1D9E75', target_pct: 64.5, high_pct: 70 }], rows: [lgb3, row({ site: 'N', delivery_model: null })], delivery: 'subcontracted' })
    expect(idx.site('2026-09-07', 'LGB3')?.delivery_model).toBe('self_perform')
    expect(idx.site('2026-09-07', 'N')?.delivery_model).toBe('subcontracted')
    expect(idx.weekSum('2026-09-07').selfSites).toBe(1); expect(idx.weekSum('2026-09-07').subSites).toBe(1)
  })
  it('classifies delivery from delivery_model (null = self-performed) and mirrors the API filter', () => {
    expect(isSubcontracted(subC)).toBe(true); expect(isSubcontracted(selfA)).toBe(false); expect(isSubcontracted({ delivery_model: null })).toBe(false)
    expect(deliveryOf({ delivery_model: null })).toBe('self_perform')
    expect(matchesDelivery(subC, 'all')).toBe(true); expect(matchesDelivery(subC, 'subcontracted')).toBe(true); expect(matchesDelivery(subC, 'self_perform')).toBe(false)
    expect(matchesDelivery(selfA, 'self_perform')).toBe(true)
  })
})

describe('delivery split and sub-account rollup', () => {
  it('splits a week into self-performed and subcontracted totals', () => {
    const mix = deliverySplit([selfA, selfB, subC, subD])
    expect(mix.self.sites).toBe(2); expect(mix.self.hours).toBe(550); expect(mix.self.labor).toBe(9_800); expect(mix.self.agency).toBe(300); expect(mix.self.vendor).toBe(0); expect(mix.self.invoicing).toBe(18_000); expect(mix.self.selfInvoicing).toBe(18_000)
    expect(mix.sub.selfInvoicing).toBe(0)
    expect(mix.sub.sites).toBe(2); expect(mix.sub.hours).toBe(0); expect(mix.sub.labor).toBe(0); expect(mix.sub.agency).toBe(0); expect(mix.sub.vendor).toBe(11_200); expect(mix.sub.invoicing).toBe(12_000)
    expect(costPctOf(mix.sub)).toBeCloseTo((11_200 / 12_000) * 100)
    expect(marginOf(mix.sub)).toBe(800)
    expect(mix.total.dollars).toBe(mix.self.dollars + mix.sub.dollars)
    expect(mix.total.sites).toBe(4)
    const empty = deliverySplit([])
    expect(empty.self.sites).toBe(0); expect(empty.sub.sites).toBe(0); expect(costPctOf(empty.total)).toBeNull()
  })
  it('rolls rows up by sub_account with WoW cost, ordered by invoicing', () => {
    const prev = [row({ ...selfA, direct_dollars: 4_000, ot_dollars: 0, total_dollars: undefined }), row({ ...subC, sub_dollars: 10_000, total_dollars: undefined })]
    const r = subAccountRollup([selfA, selfB, subC, subD], prev)
    expect(r.map((x) => x.name)).toEqual(['District 1', 'District 2'])
    const d1 = r[0], d2 = r[1]
    expect(d1.s.sites).toBe(2); expect(d1.s.labor).toBe(9_800); expect(d1.s.agency).toBe(300); expect(d1.s.vendor).toBe(0); expect(d1.s.dollars).toBe(9_800); expect(d1.s.invoicing).toBe(18_000)
    expect(d1.prev?.dollars).toBe(4_000); expect(d1.wowCost).toBeCloseTo(pctChange(9_800, 4_000))
    expect(d2.s.subSites).toBe(2); expect(d2.s.selfSites).toBe(0); expect(d2.s.vendor).toBe(11_200); expect(d2.s.vendorEstimated).toBe(true); expect(d2.s.agencyEstimated).toBe(false)
    expect(d2.wowCost).toBeCloseTo(pctChange(11_200, 10_000))
    // Without a previous week there is no WoW; rows without sub_account fall under their account.
    const noPrev = subAccountRollup([row({ site: 'E', account: 'Cobalt Research', invoicing: 100, direct_dollars: 50 })], null)
    expect(noPrev).toHaveLength(1); expect(noPrev[0].name).toBe('Cobalt Research'); expect(noPrev[0].prev).toBeNull(); expect(noPrev[0].wowCost).toBeNull()
  })
})

describe('demo sub-accounts and delivery filters', () => {
  it('lists sub-accounts with site and delivery counts on /executive/accounts', async () => {
    const { accounts } = await api.executiveAccounts()
    for (const a of accounts) {
      expect(a.sub_accounts!.reduce((t, s) => t + s.sites, 0)).toBe(a.sites)
      expect(a.delivery!.self_perform + a.delivery!.subcontracted).toBe(a.sites)
      for (const s of a.sub_accounts!) expect(s.delivery!.self_perform + s.delivery!.subcontracted).toBe(s.sites)
    }
    const education = accounts.find((a) => a.name === 'Summit Education')!
    expect(education.sub_accounts!.map((s) => s.name).sort()).toEqual(Object.values(DEMO_SUB_ACCOUNT_RULES['Summit Education']).sort())
    expect(education.sub_accounts).toHaveLength(2)
    const harbor = accounts.find((a) => a.name === 'Harbor Properties')!
    expect(harbor.sub_accounts!.map((s) => s.name)).toEqual(['Harbor Office Fund I', 'Harbor Office Fund II'])
    expect(harbor.sub_accounts![0].delivery).toEqual({ self_perform: 0, subcontracted: 2 })
    expect(harbor.delivery).toEqual({ self_perform: 2, subcontracted: 2 })
    // Accounts without a second level roll up to a single sub-account named after the account (the selector stays hidden).
    const cobalt = accounts.find((a) => a.name === 'Cobalt Research')!
    expect(cobalt.sub_accounts).toEqual([{ name: 'Cobalt Research', sites: 3, delivery: { self_perform: 2, subcontracted: 1 } }])
    // Ordered by sites desc.
    const apex = accounts.find((a) => a.name === 'Apex Commerce')!
    expect(apex.sub_accounts!.map((s) => [s.name, s.sites])).toEqual([['Apex Fulfillment (APF)', 2], ['Apex Distribution (APD)', 1]])
  })
  it('honours sub_account on /executive/labor-pl and echoes the filters', async () => {
    const pl = await api.executiveLaborPl({ account: 'Summit Education', sub_account: 'Gateway Public School District' })
    expect(pl.account).toBe('Summit Education'); expect(pl.sub_account).toBe('Gateway Public School District'); expect(pl.delivery).toBe('all')
    expect(pl.rows.length).toBeGreaterThan(0)
    expect(pl.rows.every((r) => r.account === 'Summit Education' && r.sub_account === 'Gateway Public School District' && r.site === 'STL1')).toBe(true)
    const all = await api.executiveLaborPl({ account: 'Summit Education' })
    expect(new WeekIndex(all).subAccounts().sort()).toEqual(['Front Range Unified School District', 'Gateway Public School District'])
    expect(all.rows.length).toBeGreaterThan(pl.rows.length)
    // sub_account is ignored without an account.
    const portfolio = await api.executiveLaborPl({ sub_account: 'Gateway Public School District' })
    expect(portfolio.sub_account).toBeNull(); expect(portfolio.rows.length).toBeGreaterThan(all.rows.length)
    const idx = new WeekIndex(all)
    const rollup = subAccountRollup(idx.rows(all.selected_week), idx.rows(idx.prevWeek(all.selected_week)))
    expect(rollup.map((r) => r.name).sort()).toEqual(['Front Range Unified School District', 'Gateway Public School District'])
    expect(rollup.every((r) => r.s.sites === 1 && r.wowCost !== null)).toBe(true)
  })
  it('honours delivery on /executive/labor-pl and the delivery split reads right', async () => {
    const sub = await api.executiveLaborPl({ account: 'Harbor Properties', delivery: 'subcontracted' })
    expect(sub.delivery).toBe('subcontracted')
    expect(sub.rows.length).toBeGreaterThan(0)
    expect(sub.rows.every((r) => r.delivery_model === 'subcontracted' && r.hours === 0 && r.sub_dollars > 0)).toBe(true)
    expect(new Set(sub.rows.map((r) => r.site))).toEqual(new Set(['NYC1', 'DC1']))
    const idx = new WeekIndex(sub)
    const s = idx.weekSum(sub.selected_week)
    expect(s.selfSites).toBe(0); expect(s.subSites).toBe(2); expect(s.labor).toBe(0); expect(s.vendor).toBe(s.sub); expect(s.invoicing).toBeGreaterThan(0)
    expect(costPctOf(s)).toBeGreaterThan(40); expect(costPctOf(s)).toBeLessThan(100)
    expect(marginOf(s)).toBeCloseTo(s.invoicing - s.sub, 5)
    expect(sub.notes[0]).toContain('2 subcontracted sites')
    const self = await api.executiveLaborPl({ account: 'Harbor Properties', delivery: 'self_perform' })
    expect(self.rows.every((r) => r.delivery_model === 'self_perform' && r.hours > 0 && r.sub_dollars === 0)).toBe(true)
    expect(new Set(self.rows.map((r) => r.site))).toEqual(new Set(['MSP1', 'TOR1']))
    const all = await api.executiveLaborPl({ account: 'Harbor Properties' })
    expect(all.rows.length).toBe(sub.rows.length + self.rows.length)
    const mix = deliverySplit(new WeekIndex(all).rows(all.selected_week))
    expect(mix.self.sites).toBe(2); expect(mix.sub.sites).toBe(2); expect(mix.total.sites).toBe(4)
    expect(mix.self.hours).toBeGreaterThan(0); expect(mix.sub.hours).toBe(0)
    expect(mix.self.dollars + mix.sub.dollars).toBeCloseTo(mix.total.dollars, 5)
    // Sub-account + delivery together: Fund I is fully subcontracted, so it has no self-performed rows.
    const fund1Self = await api.executiveLaborPl({ account: 'Harbor Properties', sub_account: 'Harbor Office Fund I', delivery: 'self_perform' })
    expect(fund1Self.rows).toHaveLength(0); expect(fund1Self.business_units).toHaveLength(0)
    const fund1 = await api.executiveLaborPl({ account: 'Harbor Properties', sub_account: 'Harbor Office Fund I' })
    expect(new Set(fund1.rows.map((r) => r.site))).toEqual(new Set(['NYC1', 'DC1']))
  })
  it('keeps labor % and cost % in the executive range for the portfolio and separates them where vendor cost exists', async () => {
    const pl = await api.executiveLaborPl({})
    const idx = new WeekIndex(pl)
    const s = idx.weekSum(pl.selected_week)
    const lp = laborPctOf(s), cp = costPctOf(s)!
    expect(lp).toBeGreaterThan(40); expect(lp).toBeLessThan(90)
    expect(cp).toBeGreaterThan(lp); expect(cp).toBeLessThan(95)
    expect(s.sub).toBeGreaterThan(0); expect(s.subSites).toBe(3)
    expect(s.selfInvoicing).toBeLessThan(s.invoicing); expect(s.selfInvoicing).toBeGreaterThan(0)
    // A mixed BU's labor % is its self-performed sites' labor %, not diluted by subcontracted billing.
    const harbor = new WeekIndex(await api.executiveLaborPl({ account: 'Harbor Properties' }))
    const ifs = harbor.buSum(DEMO_EXEC_SELECTED_WEEK, 'Crane IFS')
    expect(ifs.selfSites).toBe(1); expect(ifs.subSites).toBe(2)
    expect(laborPctOf(ifs)).toBeCloseTo((ifs.labor / ifs.selfInvoicing) * 100)
    expect(laborPctOf(ifs)).toBeGreaterThan(40); expect(laborPctOf(ifs)).toBeLessThan(90)
    expect(idx.selfSites('Crane IFS').length + idx.subSites('Crane IFS').length).toBe(idx.buSites('Crane IFS').length)
    expect(idx.subSites('Crane IFS')).toEqual(['DC1', 'NYC1'])
  })
})

describe('vendor block and projected vendor cost (demo)', () => {
  it('ships the vendor block: 6 closed months of history, an in-progress projection and the live AP look', async () => {
    const pl = await api.executiveLaborPl({})
    const v = pl.vendor
    expect(v).toBeTruthy()
    if (!v) return
    expect(v.month).toBe('2026-09-01'); expect(v.month_status).toBe('in_progress')
    expect(v.history).toHaveLength(6)
    expect(v.history.map((h) => h.month)).toEqual(['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01'])
    for (const h of v.history) { expect(h.job_cost_sub).toBeGreaterThan(0); expect(h.ap_subcontractor_invoiced).toBeGreaterThan(0); expect(h.ap_all_invoiced).toBeGreaterThan(h.ap_subcontractor_invoiced) }
    // The July close anomaly shows up in the job-cost line, not in AP.
    const july = v.history.find((h) => h.month === '2026-07-01')!, june = v.history.find((h) => h.month === '2026-06-01')!
    expect(july.job_cost_sub).toBeGreaterThan(june.job_cost_sub * 2)
    expect(Math.abs(july.ap_subcontractor_invoiced - june.ap_subcontractor_invoiced) / june.ap_subcontractor_invoiced).toBeLessThan(0.2)
    expect(v.projected_month_sub).toBeGreaterThan(0); expect(v.projected_basis).toBe('trailing_3mo_projection'); expect(v.sites_projected).toBeGreaterThan(0)
    expect(v.ap_live?.through).toBe('2026-09-14'); expect(v.ap_live?.invoiced_to_date).toBeGreaterThan(0)
    expect(v.ap_live?.by_vendor_type.map((t) => t.vendor_type)).toEqual(['Subcontract', 'Janitorial'])
    // Rows carry sub_basis: projection in the open month, prorated job cost in closed months.
    expect(pl.rows.filter((r) => r.week === '2026-09-07' && r.sub_dollars > 0).every((r) => r.sub_basis === 'trailing_3mo_projection' && r.sub_estimated)).toBe(true)
    expect(pl.rows.filter((r) => r.week === '2026-08-03' && r.sub_dollars > 0).every((r) => r.sub_basis === 'job_cost_month_prorated')).toBe(true)
  })
})
