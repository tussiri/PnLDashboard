import { describe, expect, it } from 'vitest'
import { demoJobMeta, demoJobMonths } from '../data/seed'
import { COVERAGE_CAVEAT, COVERAGE_CAVEAT_THRESHOLD, coverageCaveat, headlineRow, isAggregateRow } from '../views/forecastShared'
import { CASH_APPLICATION_WARN_BELOW, cashApplicationTone } from './aging'
import { ACCOUNT_ROW, PORTFOLIO_ROW, type ForecastRow } from './apiTypes'
import { DEMO_KEY_ACCOUNTS, DEMO_NON_COLLECTIBLE_ACCOUNT, createDemoApi, demoCompanyOf, demoDeliveryModelOf } from './demoApi'

const api = createDemoApi({ latencyMs: 0 })
const sum = <T,>(rows: T[], pick: (r: T) => number | null) => rows.reduce((t, r) => t + (pick(r) ?? 0), 0)

describe('demo -> contract adapter', () => {
  it('labels every payload as demo (source.mode = empty) and resolves the server range rule', async () => {
    const ytd = await api.portfolioSummary({ period: 'YTD' })
    expect(ytd.source.mode).toBe('empty')
    expect(ytd.range).toMatchObject({ from: '2026-01-01', to: '2026-08-01', months: 8 })
    const qtd = await api.portfolioSummary({ period: 'QTD', month: '2026-05-01' })
    expect(qtd.range).toMatchObject({ from: '2026-04-01', to: '2026-05-01', months: 2 })
    expect(ytd.monthly).toHaveLength(12)
  })

  it('sums site rows into portfolio KPIs consistently across endpoints', async () => {
    const summary = await api.portfolioSummary({ period: 'T12M' })
    const jobs = await api.jobs({ period: 'T12M' })
    expect(sum(jobs.jobs, (j) => j.revenue)).toBe(summary.kpis.revenue)
    expect(sum(jobs.jobs, (j) => j.gross_profit)).toBe(summary.kpis.gross_profit)
    expect(sum(jobs.jobs, (j) => j.hours)).toBe(summary.kpis.hours)
    expect(sum(summary.by_region, (g) => g.revenue)).toBe(summary.kpis.revenue)
    expect(sum(summary.by_account, (g) => g.revenue)).toBe(summary.kpis.revenue)
    for (const job of jobs.jobs) expect(job.gross_profit).toBe(job.revenue - job.labor_cost - job.burden_cost)
    const accounts = await api.accounts({ period: 'T12M' })
    expect(sum(accounts.accounts, (a) => a.revenue)).toBe(summary.kpis.revenue)
    expect(summary.kpis.ar_open).toBe(sum(jobs.jobs, (j) => j.ar_open))
  })

  it('applies exact-match filters and derives status with the disclosed rule', async () => {
    const west = await api.jobs({ period: 'YTD', region: 'West' })
    expect(west.jobs.length).toBeGreaterThan(0)
    expect(west.jobs.every((j) => j.region === 'West')).toBe(true)
    const one = await api.jobs({ period: 'YTD', account: 'Meridian Health', service_type: 'Healthcare' })
    expect(one.jobs.every((j) => j.parent_account === 'Meridian Health')).toBe(true)
    const all = await api.jobs({ period: 'YTD' })
    for (const job of all.jobs) {
      expect(['Healthy', 'Watch', 'Critical']).toContain(job.status)
      if (job.status !== 'Healthy') expect(job.status_reasons.length).toBeGreaterThan(0)
      if (job.gross_margin_pct !== null && job.gross_margin_pct < 18 && job.revenue > 0) expect(job.status).toBe('Critical')
    }
  })

  it('produces 24 months for continuing sites and exercises partial/stale series', async () => {
    const continuing = demoJobMeta.filter((m) => !m.startMonth && !m.endMonth)
    for (const meta of continuing.slice(0, 5)) expect(demoJobMonths.filter((r) => r.job_number === meta.job_number)).toHaveLength(24)
    const detail = await api.job(continuing[0].job_number)
    expect(detail.history).toHaveLength(24)
    expect(detail.schedule_vs_actual).toHaveLength(13)
    expect(detail.forecast?.rows.length).toBe(9)
    await expect(api.job('does-not-exist')).rejects.toMatchObject({ status: 404 })
  })

  it('aging buckets reconcile with the invoice list and DSO follows the contract formula', async () => {
    const aging = await api.arAging()
    const invoices = await api.arInvoices({ limit: 500 })
    expect(invoices.total).toBe(sum(aging.buckets, (b) => b.invoices))
    expect(sum(invoices.items, (i) => i.open_balance)).toBe(aging.total_open)
    expect(sum(aging.by_customer, (c) => c.total)).toBe(aging.total_open)
    const summary = await api.portfolioSummary({ period: 'MTD' })
    expect(aging.dso_days).toBe(summary.kpis.dso_days)
    const page = await api.arInvoices({ bucket: 'd30', limit: 5, offset: 0 })
    expect(page.items.every((i) => i.aging_bucket === 'd30')).toBe(true)
    expect(page.items.length).toBeLessThanOrEqual(5)
  })

  it('governed forecast shapes: portfolio first, bands ordered, gates refuse short/stale series, accuracy gated', async () => {
    const fc = await api.forecasts({ metric: 'revenue' })
    expect(fc.run?.engine_version).toBeTruthy()
    expect(fc.rows[0].job_number).toBe('__ALL__')
    for (const row of fc.rows) { expect(row.lo).toBeLessThanOrEqual(row.point); expect(row.point).toBeLessThanOrEqual(row.hi); expect([1, 2, 3]).toContain(row.horizon_step) }
    const portfolioH1 = fc.rows.find((r) => r.job_number === '__ALL__' && r.horizon_step === 1)!
    expect(portfolioH1.point).toBe(sum(fc.rows.filter((r) => r.job_number !== '__ALL__' && r.horizon_step === 1), (r) => r.point))
    expect(fc.not_forecast.map((s) => s.status).sort()).toEqual(['insufficient_history', 'stale_series'])
    expect(fc.rows.some((r) => r.accuracy && r.accuracy.n_backtests < 3)).toBe(true)
    const history = await api.forecastHistory()
    expect(history.rows.filter((r) => !r.closed)).toHaveLength(1)
    expect(history.rows.at(-1)?.suspect).toMatch(/partial_month/)
    const track = await api.forecastTrackRecord({ metric: 'revenue' })
    expect(track.rows.every((r) => r.actual === null || r.in_band !== null)).toBe(true)
  })

  it('labor pace projects the month in progress with a day-of-week method', async () => {
    const pace = await api.laborPace()
    const portfolio = pace.rows.find((r) => r.scope === 'portfolio')!
    expect(pace.days_elapsed).toBeLessThan(pace.days_in_month)
    expect(portfolio.projection_method).toBe('day_of_week_weighted')
    expect(portfolio.projected_labor).toBeGreaterThan(portfolio.labor_to_date)
    expect(portfolio.range_lo).not.toBeNull()
    expect(portfolio.projected_variance).toBe(portfolio.projected_labor - (portfolio.budget ?? 0))
    const scoped = await api.laborPace({ account: 'Apex Commerce' })
    expect(scoped.rows).toHaveLength(1)
    expect(scoped.rows[0].scope).toBe('account')
  })

  it('refuses admin actions in demo mode with a clear error and honors abort signals', async () => {
    await expect(api.syncAll()).rejects.toThrow(/demo mode/)
    const controller = new AbortController()
    const slow = createDemoApi({ latencyMs: 50 })
    const promise = slow.dimensions(controller.signal)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('carries the finance-reference additive fields with the cost breakdown reconciling to burden and gross profit', async () => {
    const jobs = await api.jobs({ period: 'T12M' })
    const summary = await api.portfolioSummary({ period: 'T12M' })
    for (const job of jobs.jobs) {
      expect(typeof job.company).toBe('string')
      expect(['self_perform', 'subcontracted']).toContain(job.delivery_model)
      expect(['exact', 'city_center']).toContain(job.geo_precision)
      expect(job.payroll_ti_cost! + job.subcontract_cost! + job.supplies_cost! + job.other_direct_cost!).toBe(job.burden_cost)
      expect(job.gross_profit).toBe(job.revenue - job.labor_cost - job.payroll_ti_cost! - job.subcontract_cost! - job.supplies_cost! - job.other_direct_cost!)
      if (job.delivery_model === 'subcontracted') expect(job.subcontract_cost).toBeGreaterThan(0)
      else expect(job.subcontract_cost).toBe(0)
    }
    expect(jobs.jobs.some((j) => j.delivery_model === 'subcontracted')).toBe(true)
    expect(jobs.jobs.some((j) => j.geo_precision === 'city_center')).toBe(true)
    const k = summary.kpis
    expect(k.direct_cost).toBe(sum(jobs.jobs, (j) => j.labor_cost) + sum(jobs.jobs, (j) => j.burden_cost))
    expect(k.payroll_ti_cost! + k.subcontract_cost! + k.supplies_cost! + k.other_direct_cost! + k.labor_cost).toBe(k.direct_cost)
    expect(k.gross_profit).toBe(k.revenue - k.direct_cost!)
    for (const m of summary.monthly) expect(m.labor_cost + m.payroll_ti_cost! + m.subcontract_cost! + m.supplies_cost! + m.other_direct_cost!).toBe(m.direct_cost)
    expect(sum(summary.by_company!, (g) => g.revenue)).toBe(k.revenue)
    expect(summary.source.primary_source).toBe('none')
  })

  it('defaults to the key accounts and reaches the long tail through scope and drill-down', async () => {
    const keys = DEMO_KEY_ACCOUNTS.map((a) => a.name)
    const dflt = await api.jobs({ period: 'YTD' })
    expect(dflt.jobs.length).toBeGreaterThan(0)
    expect(dflt.jobs.every((j) => keys.includes(j.parent_account))).toBe(true)
    expect(dflt.range.scope).toMatchObject({ mode: 'key', label: 'Key accounts', sites: dflt.jobs.length })
    expect(dflt.range.scope!.accounts.every((a) => keys.includes(a))).toBe(true)

    const other = await api.jobs({ period: 'YTD', scope: 'other' })
    expect(other.jobs.length).toBeGreaterThan(0)
    expect(other.jobs.some((j) => keys.includes(j.parent_account))).toBe(false)
    expect(other.range.scope).toMatchObject({ mode: 'other', label: 'Other accounts' })

    const all = await api.jobs({ period: 'YTD', scope: 'all' })
    expect(all.jobs).toHaveLength(dflt.jobs.length + other.jobs.length)
    expect(all.range.scope).toMatchObject({ mode: 'all', label: 'All accounts' })

    // An account wins over the scope, exactly as the API describes it.
    const drilled = await api.jobs({ period: 'YTD', scope: 'other', account: keys[0] })
    expect(drilled.jobs.every((j) => j.parent_account === keys[0])).toBe(true)
    expect(drilled.range.scope).toMatchObject({ mode: 'account', label: keys[0], accounts: [keys[0]] })
  })

  it('filters by sub-account and delivery model, and reports the coverage of the key-account scope', async () => {
    const dims = await api.dimensions()
    const fedexLike = dims.key_accounts!.find((a) => a.sub_accounts.length >= 2)!
    const sub = fedexLike.sub_accounts[0]
    const scoped = await api.jobs({ period: 'YTD', account: fedexLike.name, sub_account: sub.name })
    expect(scoped.jobs).toHaveLength(sub.sites)
    expect(scoped.range.scope).toMatchObject({ mode: 'account', label: `${fedexLike.name} · ${sub.name}` })

    const subcontracted = await api.jobs({ period: 'YTD', scope: 'all', delivery: 'subcontracted' })
    expect(subcontracted.jobs.length).toBeGreaterThan(0)
    expect(subcontracted.jobs.every((j) => j.delivery_model === 'subcontracted')).toBe(true)

    const key = await api.portfolioSummary({ period: 'YTD' })
    const all = await api.portfolioSummary({ period: 'YTD', scope: 'all' })
    expect(all.kpis.revenue_share_of_all).toBe(1)
    expect(key.kpis.revenue_share_of_all).toBeCloseTo(key.kpis.revenue / all.kpis.revenue, 3)
    expect(key.kpis.revenue_share_of_all!).toBeLessThan(1)
    // The invoice list follows the same scope as the aging buckets.
    const aging = await api.arAging({ scope: 'other' })
    const invoices = await api.arInvoices({ scope: 'other', limit: 500 })
    expect(invoices.total).toBe(sum(aging.buckets, (b) => b.invoices))
  })

  it('describes the key/other split in /dimensions', async () => {
    const dims = await api.dimensions()
    const keys = dims.key_accounts!.map((a) => a.name)
    const others = dims.other_accounts!.map((a) => a.name)
    expect(keys).toEqual(DEMO_KEY_ACCOUNTS.map((a) => a.name))
    expect(keys.some((name) => others.includes(name))).toBe(false)
    expect([...keys, ...others].sort()).toEqual([...dims.accounts].sort())
    for (const account of dims.key_accounts!) {
      expect(account.label.length).toBeGreaterThan(0)
      expect(sum(account.sub_accounts, (s) => s.sites)).toBe(account.sites)
    }
  })

  it('exposes companies and delivery models as dimensions and filters jobs by company', async () => {
    const dims = await api.dimensions()
    expect(dims.companies!.length).toBeGreaterThanOrEqual(2)
    expect(dims.delivery_models).toEqual(['self_perform', 'subcontracted'])
    const company = dims.companies![0]
    const filtered = await api.jobs({ period: 'YTD', company })
    expect(filtered.jobs.length).toBeGreaterThan(0)
    expect(filtered.jobs.every((j) => j.company === company)).toBe(true)
    const all = await api.jobs({ period: 'YTD' })
    expect(filtered.jobs.length).toBe(all.jobs.filter((j) => j.company === company).length)
    expect(all.jobs.map((j) => j.company)).toContain(demoCompanyOf({ site: { country: 'Canada' } } as never))
    const summary = await api.portfolioSummary({ period: 'YTD', company })
    expect(summary.kpis.revenue).toBe(sum(filtered.jobs, (j) => j.revenue))
    expect(summary.by_company).toHaveLength(1)
  })

  it('reports collectible AR, vendor open balances, source rows and the labor cost basis', async () => {
    const aging = await api.arAging()
    const excluded = aging.by_customer.filter((c) => c.is_collectible === false)
    expect(excluded.length).toBeGreaterThan(0)
    expect(excluded.every((c) => c.parent_account === DEMO_NON_COLLECTIBLE_ACCOUNT)).toBe(true)
    expect(aging.collectible_open).toBe(aging.total_open - sum(excluded, (c) => c.total))
    expect(aging.by_customer.every((c) => typeof c.company === 'string')).toBe(true)
    const ap = await api.apSummary({ period: 'T12M' })
    expect(ap.by_vendor.every((v) => typeof v.open_balance === 'number' && typeof v.past_due === 'number' && v.past_due! <= v.open_balance!)).toBe(true)
    expect(ap.kpis.open_estimate).toBe(sum(ap.by_vendor, (v) => v.open_balance ?? 0))
    const status = await api.systemStatus()
    expect(status.sources!.map((s) => s.name).sort()).toEqual(['finance_reference', 'winteam_api'])
    const freshness = await api.freshness()
    expect(freshness.sources).toHaveLength(2)
    const finance = await api.financeReference()
    expect(finance).toMatchObject({ configured: false, reference: null, last_load: null })
    await expect(api.loadFinanceReference()).rejects.toThrow(/demo mode/)
    const pace = await api.laborPace()
    expect(pace.method_notes?.labor_cost_basis).toBeTruthy()
  })

  it('account-scoped forecasts omit __ALL__, lead with the __ACCOUNT__ aggregate and describe coverage', async () => {
    const account = 'Meridian Health'
    const fc = await api.forecasts({ metric: 'revenue', account })
    expect(fc.rows.some((r) => r.job_number === PORTFOLIO_ROW)).toBe(false)
    expect(fc.rows[0].job_number).toBe(ACCOUNT_ROW)
    expect(fc.rows[0].job_name).toBe(account)
    expect(fc.rows[0].method).toBe('sum_of_site_forecasts')
    const sites = fc.rows.filter((r) => !isAggregateRow(r.job_number))
    expect(sites.every((r) => r.parent_account === account && ['self_perform', 'subcontracted'].includes(r.delivery_model!))).toBe(true)
    for (const h of [1, 2, 3]) {
      const agg = fc.rows.find((r) => r.job_number === ACCOUNT_ROW && r.horizon_step === h)!
      expect(agg.point).toBe(sum(sites.filter((r) => r.horizon_step === h), (r) => r.point))
    }
    const summary = fc.account_summary!
    expect(summary.account).toBe(account)
    expect(summary.sites_forecast).toBe(new Set(sites.map((r) => r.job_number)).size)
    expect(summary.sites_forecast + summary.sites_not_forecast).toBe(summary.sites_total)
    expect(summary.self_perform_sites + summary.subcontracted_sites).toBe(summary.sites_total)
    expect(summary.sites_total).toBe(demoJobMeta.filter((m) => m.site.customer === account).length)
    expect(summary.last_closed_month).toBe('2026-08-01')
    expect(summary.last_closed_actual.gross_profit).toBeLessThan(summary.last_closed_actual.revenue)
    expect(summary.forecast_coverage_pct).toBeGreaterThan(0)
    expect(summary.forecast_coverage_pct).toBeLessThanOrEqual(100)
    expect(fc.not_forecast.every((s) => s.delivery_model !== undefined)).toBe(true)
    // Portfolio scope keeps the __ALL__ row and carries no account summary.
    const portfolio = await api.forecasts({ metric: 'revenue' })
    expect(portfolio.rows[0].job_number).toBe(PORTFOLIO_ROW)
    expect(portfolio.rows.some((r) => r.job_number === ACCOUNT_ROW)).toBe(false)
    expect(portfolio.account_summary).toBeUndefined()
    // The whole-portfolio point must never surface as an account headline.
    expect(headlineRow(portfolio.rows, account)).toEqual([])
    expect(headlineRow(fc.rows, account).map((r) => r.horizon_step)).toEqual([1, 2, 3])
    expect(headlineRow(fc.rows, account)[0].point).not.toBe(portfolio.rows[0].point)
    expect(headlineRow(portfolio.rows, '').map((r) => r.job_number)).toEqual([PORTFOLIO_ROW, PORTFOLIO_ROW, PORTFOLIO_ROW])
    expect(headlineRow(fc.rows, null)).toEqual([])
  })

  it('headlineRow sorts by horizon and coverageCaveat fires only below the threshold', () => {
    const row = (job_number: string, horizon_step: number): ForecastRow => ({ job_number, horizon_step, point: horizon_step } as ForecastRow)
    expect(headlineRow([row(PORTFOLIO_ROW, 3), row('J1', 1), row(PORTFOLIO_ROW, 1), row(PORTFOLIO_ROW, 2)], undefined).map((r) => r.horizon_step)).toEqual([1, 2, 3])
    expect(headlineRow([row(ACCOUNT_ROW, 2), row(PORTFOLIO_ROW, 1), row(ACCOUNT_ROW, 1)], 'FedEx').map((r) => r.horizon_step)).toEqual([1, 2])
    expect(headlineRow(undefined, 'FedEx')).toEqual([])
    expect(COVERAGE_CAVEAT_THRESHOLD).toBe(80)
    expect(coverageCaveat(79.9)).toBe(COVERAGE_CAVEAT)
    expect(coverageCaveat(0)).toBe(COVERAGE_CAVEAT)
    expect(coverageCaveat(80)).toBeNull()
    expect(coverageCaveat(100)).toBeNull()
    expect(coverageCaveat(null)).toBeNull()
    expect(coverageCaveat(undefined)).toBeNull()
    expect(coverageCaveat(Number.NaN)).toBeNull()
  })

  it('offers subcontract_cost as a gated metric that reconciles with the cost breakdown', async () => {
    const fc = await api.forecasts({ metric: 'subcontract_cost' })
    const sites = fc.rows.filter((r) => !isAggregateRow(r.job_number))
    expect(sites.length).toBeGreaterThan(0)
    expect(sites.every((r) => r.delivery_model === 'subcontracted' && r.point > 0)).toBe(true)
    expect(fc.not_forecast.some((s) => s.status === 'no_subcontract_cost')).toBe(true)
    expect(fc.not_forecast.filter((s) => s.status === 'no_subcontract_cost').every((s) => s.delivery_model === 'self_perform')).toBe(true)
    const history = await api.forecastHistory()
    const jobs = await api.jobs({ period: 'T12M' })
    // History splits burden per site-month while the jobs grid splits the period total once, so allow one unit of rounding per month.
    expect(Math.abs(sum(history.rows.filter((r) => r.closed).slice(-12), (r) => r.subcontract_cost ?? 0) - sum(jobs.jobs, (j) => j.subcontract_cost ?? 0))).toBeLessThanOrEqual(12)
    const subcontracted = demoJobMeta.find((m) => demoDeliveryModelOf(m) === 'subcontracted' && !m.startMonth && !m.endMonth)!
    const detail = await api.forecastJob(subcontracted.job_number)
    expect(detail.rows.filter((r) => r.metric === 'subcontract_cost')).toHaveLength(3)
    const selfPerformed = demoJobMeta.find((m) => demoDeliveryModelOf(m) === 'self_perform' && !m.startMonth && !m.endMonth)!
    const detail2 = await api.forecastJob(selfPerformed.job_number)
    expect(detail2.rows.some((r) => r.metric === 'subcontract_cost')).toBe(false)
    expect(detail2.not_forecast?.map((s) => s.metric)).toEqual(['subcontract_cost'])
  })

  it('reports cash application with the aging and flags it only below the warning share', async () => {
    const aging = await api.arAging()
    const cash = aging.cash_application!
    expect(cash.invoices_open).toBe(sum(aging.buckets, (b) => b.invoices))
    expect(cash.invoices_with_payment_applied).toBeLessThanOrEqual(cash.invoices_open)
    expect(cash.pct_with_payment_applied).toBe(Math.round((cash.invoices_with_payment_applied / cash.invoices_open) * 1000) / 10)
    expect(cash.open_nothing_applied_over_90).toBeLessThanOrEqual(cash.open_nothing_applied)
    expect(cash.open_nothing_applied).toBeLessThanOrEqual(aging.total_open)
    expect(cash.oldest_open_invoice_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(cash.note.length).toBeGreaterThan(20)
    const scoped = await api.arAging({ account: 'Meridian Health' })
    expect(scoped.cash_application!.invoices_open).toBeLessThan(cash.invoices_open)
    expect(cashApplicationTone(cash)).toBe('ok')
    expect(cashApplicationTone({ ...cash, pct_with_payment_applied: CASH_APPLICATION_WARN_BELOW - 0.1 })).toBe('warn')
    expect(cashApplicationTone({ ...cash, pct_with_payment_applied: CASH_APPLICATION_WARN_BELOW })).toBe('ok')
    expect(cashApplicationTone({ ...cash, pct_with_payment_applied: null })).toBe('ok')
    expect(cashApplicationTone(null)).toBeNull()
    expect(cashApplicationTone(undefined)).toBeNull()
  })
})
