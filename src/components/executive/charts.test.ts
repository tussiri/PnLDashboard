import { describe, expect, it } from 'vitest'
import { demoExecutiveLaborPl } from '../../services/demoApi'
import { ANOMALY_PCT, PCT_DOMAIN, anomalyNote, clampSeries, csvFileName, dialogKeyAction, dollarClampMax, dollarTick, expandReducer, fmtCurrency, formatCell, monthTicks, niceDollarAxis, pctStep, trapFocus, trendKind, weeklyCsv, wowText } from './charts'
import { WeekIndex, sumRows } from './model'
import { headlineValue, weeklySeries } from './trends'

const mondays = (from: string, n: number) => Array.from({ length: n }, (_, i) => { const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 7 * i); return d.toISOString().slice(0, 10) })

describe('month-boundary ticks', () => {
  it('labels the first week of each month only, keeps every week as an unlabelled gridline', () => {
    const weeks = mondays('2026-05-18', 18) // May 18 .. Sep 14
    const { labels, boundaries } = monthTicks(weeks)
    expect(labels).toHaveLength(18)
    expect(labels.filter(Boolean)).toEqual(['May', 'Jun', 'Jul', 'Aug', 'Sep'])
    expect(boundaries.map((i) => weeks[i])).toEqual(['2026-05-18', '2026-06-01', '2026-07-06', '2026-08-03', '2026-09-07'])
    // No label is ever rotated: labels are month names, never "May 4"-style dates.
    expect(labels.every((l) => l === '' || /^[A-Z][a-z]{2}( \d{4})?$/.test(l))).toBe(true)
  })
  it('drops the first-week label when the next month starts within two weeks, and years January', () => {
    expect(monthTicks(mondays('2026-05-25', 4)).labels).toEqual(['', 'Jun', '', ''])
    expect(monthTicks(mondays('2026-05-18', 4), 3).labels).toEqual(['', '', 'Jun', '']) // narrow site cards need three weeks of room
    expect(monthTicks(mondays('2026-12-14', 5)).labels.filter(Boolean)).toEqual(['Dec', 'Jan 2027'])
    expect(monthTicks([])).toEqual({ labels: [], boundaries: [] })
    // Monthly series (the vendor card) label every period, first included.
    expect(monthTicks(['2026-03-01', '2026-04-01', '2026-05-01']).labels).toEqual(['Mar', 'Apr', 'May'])
  })
})

describe('fixed percent domain with clamping', () => {
  it('plots values beyond 120 % at the top and flags them, leaving the rest untouched', () => {
    const { plotted, clamped, raw } = clampSeries([58.2, null, 134.5, 420, 61], PCT_DOMAIN.max)
    expect(plotted).toEqual([58.2, null, 120, 120, 61])
    expect(clamped).toEqual([false, false, true, true, false])
    expect(raw[3]).toBe(420)
    expect(pctStep(PCT_DOMAIN.max)).toBe(30) // 0 / 30 / 60 / 90 / 120
  })
  it('rounds dollar axes to nice 0-based steps with 4-6 ticks', () => {
    expect(niceDollarAxis(0, 37_000)).toEqual({ min: 0, max: 40_000, step: 10_000 })
    expect(niceDollarAxis(0, 12_000)).toEqual({ min: 0, max: 15_000, step: 5_000 })
    expect(niceDollarAxis(-8_000, 22_000)).toEqual({ min: -10_000, max: 30_000, step: 10_000 })
    expect(niceDollarAxis(0, 0)).toEqual({ min: 0, max: 1000, step: 250 })
    expect(dollarClampMax([300_000, 310_000, 305_000, 1_460_000, 309_000])).toBe(1_000_000) // 3× median, nice-rounded
    expect(dollarClampMax([35_000, 38_000, -310_000, 36_000, 34_000])).toBe(150_000) // margins: 3× the median |value|, nice-rounded; the July loss clamps symmetrically
    const m = clampSeries([35_000, -310_000, 36_000], 150_000, -150_000)
    expect(m.plotted).toEqual([35_000, -150_000, 36_000]); expect(m.below).toEqual([false, true, false]); expect(m.clamped).toEqual([false, false, false])
    expect(dollarClampMax([300_000, 310_000, 305_000, 320_000])).toBeNull()
    expect(dollarClampMax([1, null])).toBeNull()
    expect(dollarTick(40_000)).toBe('$40k'); expect(dollarTick(1_250_000)).toBe('$1.3M'); expect(dollarTick(750)).toBe('$750'); expect(dollarTick(-2_500)).toBe('−$2.5k')
  })
  it('annotates anomalies past 150 % with the July close wording', () => {
    expect(anomalyNote('2026-07-06', 187)).toBe('cost exceeds invoicing · July close carries flagged subcontract costs')
    expect(anomalyNote('2026-08-03', 160)).toBe('cost exceeds invoicing this week')
    expect(anomalyNote('2026-07-06', ANOMALY_PCT)).toBeNull()
    expect(anomalyNote('2026-07-06', null)).toBeNull()
  })
})

describe('delivery-aware chart selection', () => {
  it('picks labor % for sites with hours and cost + margin for fully subcontracted scopes', () => {
    expect(trendKind([{ hours: 120, delivery_model: 'self_perform' }])).toBe('labor')
    expect(trendKind([{ hours: 0, delivery_model: 'subcontracted' }, { hours: 0, delivery_model: 'subcontracted' }])).toBe('cost_margin')
    expect(trendKind([{ hours: 0, delivery_model: 'subcontracted' }, { hours: 40, delivery_model: 'self_perform' }])).toBe('labor')
    expect(trendKind([])).toBe('labor')
  })
  it('demo: Harbor Office Fund I is fully subcontracted, the portfolio is not; July carries the flagged anomaly', () => {
    const fund = new WeekIndex(demoExecutiveLaborPl({ account: 'Harbor Properties', sub_account: 'Harbor Office Fund I' }))
    expect(trendKind(fund.weeks.flatMap((w) => fund.rows(w)))).toBe('cost_margin')
    const all = new WeekIndex(demoExecutiveLaborPl({}))
    expect(trendKind(all.weeks.flatMap((w) => all.rows(w)))).toBe('labor')
    const ifs = weeklySeries(all, (w) => all.buSum(w, 'Crane IFS'))
    const july = ifs.weeks.map((w, i) => ({ w, c: ifs.costPct[i], note: ifs.anomalies[i] })).filter((x) => x.w.startsWith('2026-07'))
    expect(july.some((x) => (x.c ?? 0) > ANOMALY_PCT && x.note?.includes('July close'))).toBe(true)
    expect(ifs.weeks.filter((w) => w.startsWith('2026-08')).every((w) => (ifs.costPct[ifs.weeks.indexOf(w)] ?? 0) < 100)).toBe(true)
    const nyc = weeklySeries(all, (w) => { const r = all.site(w, 'NYC1'); return r ? sumRows([r]) : null })
    expect(nyc.laborPct.every((v) => v === null)).toBe(true) // no hours: a labor sparkline would show nothing
    expect(nyc.costPct.some((v) => v !== null)).toBe(true)
    expect(nyc.margin.some((v) => v !== null && v < 0)).toBe(true)
  })
})

describe('headline, WoW and formatting', () => {
  it('headlines the selected week (or the latest value) with its predecessor', () => {
    const weeks = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14']
    expect(headlineValue([60, 62, null, 65], weeks, '2026-09-07')).toEqual({ value: 65, prev: 62, week: '2026-09-14' })
    expect(headlineValue([60, 62, 63, 65], weeks, '2026-09-07')).toEqual({ value: 63, prev: 62, week: '2026-09-07' })
    expect(headlineValue([null, null, null, null], weeks, null)).toEqual({ value: null, prev: null, week: null })
    expect(wowText('pct', 63, 62)).toBe('+1.0 pp WoW'); expect(wowText('dollars', 110, 100)).toBe('+10.0% WoW'); expect(wowText('dollars', 5, 0)).toBeNull(); expect(wowText('pct', null, 1)).toBeNull()
  })
  it('formats currency without cents above $10k and percentages to one decimal', () => {
    expect(fmtCurrency(68068.18)).toBe('$68,068'); expect(fmtCurrency(9876.5)).toBe('$9,876.50'); expect(fmtCurrency(-1234.5)).toBe('−$1,234.50'); expect(fmtCurrency(0)).toBe('$0.00')
    expect(formatCell('pct', 62.345)).toBe('62.3%'); expect(formatCell('pct', null)).toBe('—'); expect(formatCell('dollars', 12345.67)).toBe('$12,346')
    expect(formatCell('pp', -1.25)).toBe('-1.3 pp'); expect(formatCell('flag', true)).toBe('~est'); expect(formatCell('flag', false)).toBe(''); expect(formatCell('number', 3617.8)).toBe('3,618')
  })
})

describe('expanded table CSV export', () => {
  it('writes headers, raw numbers and flags so spreadsheets parse them', () => {
    const csv = weeklyCsv({
      columns: [{ key: 'week', header: 'Week', kind: 'text' }, { key: 'labor_pct', header: 'Labor %', kind: 'pct' }, { key: 'invoicing', header: 'Invoicing', kind: 'dollars' }, { key: 'est', header: 'Basis', kind: 'flag' }, { key: 'note', header: 'Note', kind: 'text' }],
      rows: [{ week: '2026-08-31', labor_pct: 62.345, invoicing: 68068.18, est: true, note: 'cost exceeds invoicing, this week' }, { week: '2026-09-07 (in progress)', labor_pct: null, invoicing: 0, est: false, note: '' }],
    })
    expect(csv.split('\r\n')).toEqual(['Week,Labor %,Invoicing,Basis,Note', '2026-08-31,62.35,68068.18,true,"cost exceeds invoicing, this week"', '2026-09-07 (in progress),,0,false,'])
    expect(csvFileName('Crane IFS — Labor %', '2026-09-07')).toBe('crane-ifs-labor-pct-2026-09-07.csv')
  })
})

describe('expand dialog', () => {
  it('opens, closes and toggles', () => {
    expect(expandReducer(false, 'open')).toBe(true)
    expect(expandReducer(true, 'close')).toBe(false)
    expect(expandReducer(true, 'toggle')).toBe(false)
    expect(expandReducer(false, 'toggle')).toBe(true)
  })
  it('closes on Escape, traps Tab and ignores other keys', () => {
    expect(dialogKeyAction('Escape')).toBe('close'); expect(dialogKeyAction('Esc')).toBe('close')
    expect(dialogKeyAction('Tab')).toBe('trap'); expect(dialogKeyAction('Enter')).toBeNull()
    const els = ['export', 'close', 'link']
    expect(trapFocus(els, 'link', false)).toBe('export') // Tab off the last wraps to the first
    expect(trapFocus(els, 'export', true)).toBe('link') // Shift+Tab off the first wraps to the last
    expect(trapFocus(els, 'close', false)).toBeNull() // otherwise the browser moves focus itself
    expect(trapFocus(els, null, false)).toBe('export'); expect(trapFocus(els, 'outside', true)).toBe('export'); expect(trapFocus([], null, false)).toBeNull()
  })
})
