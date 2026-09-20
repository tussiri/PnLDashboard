import type { JobSite, MonthlyPerformance } from '../types'

type SiteSeed = Pick<JobSite, 'id' | 'winTeamId' | 'customer' | 'name' | 'city' | 'state' | 'zip' | 'address' | 'latitude' | 'longitude' | 'region' | 'branch' | 'siteManager' | 'operationsManager' | 'accountManager' | 'serviceType'> & {
  country?: JobSite['country']
  scale: number
  margin: number
  laborDrift: number
  overtime: number
  arDays: number
}

const seeds: SiteSeed[] = [
  { id:'chi-01', winTeamId:'WT-10482', customer:'Apex Commerce', name:'Chicago Distribution Campus', city:'Joliet', state:'IL', zip:'60431', address:'2750 Logistics Way', latitude:41.525, longitude:-88.081, region:'Central', branch:'Chicago', siteManager:'Nina Patel', operationsManager:'Marcus Reed', accountManager:'Olivia Chen', serviceType:'Industrial', scale:1.34, margin:28.4, laborDrift:4.8, overtime:8.2, arDays:31 },
  { id:'dfw-01', winTeamId:'WT-10511', customer:'Meridian Health', name:'North Texas Medical Center', city:'Dallas', state:'TX', zip:'75235', address:'5030 Medical District Dr', latitude:32.812, longitude:-96.842, region:'Central', branch:'Dallas–Fort Worth', siteManager:'Luis Martinez', operationsManager:'Erin Brooks', accountManager:'Noah Williams', serviceType:'Healthcare', scale:1.52, margin:23.2, laborDrift:9.1, overtime:12.4, arDays:47 },
  { id:'atl-01', winTeamId:'WT-10217', customer:'Beacon Financial', name:'Midtown Corporate Tower', city:'Atlanta', state:'GA', zip:'30309', address:'1180 Peachtree St NE', latitude:33.786, longitude:-84.383, region:'Southeast', branch:'Atlanta', siteManager:'Aisha Grant', operationsManager:'Derrick King', accountManager:'Emma Davis', serviceType:'Janitorial', scale:1.08, margin:31.1, laborDrift:-2.2, overtime:3.8, arDays:24 },
  { id:'nyc-01', winTeamId:'WT-10604', customer:'Harbor Properties', name:'Hudson Square Portfolio', city:'New York', state:'NY', zip:'10013', address:'325 Hudson St', latitude:40.727, longitude:-74.008, region:'Northeast', branch:'New York Metro', siteManager:'Daniel Kim', operationsManager:'Priya Shah', accountManager:'Mia Thompson', serviceType:'Janitorial', scale:1.72, margin:26.8, laborDrift:3.4, overtime:7.1, arDays:38 },
  { id:'phl-01', winTeamId:'WT-10371', customer:'Meridian Health', name:'Liberty Children’s Hospital', city:'Philadelphia', state:'PA', zip:'19104', address:'3401 Civic Center Blvd', latitude:39.948, longitude:-75.194, region:'Northeast', branch:'Philadelphia', siteManager:'Sofia Torres', operationsManager:'Priya Shah', accountManager:'Noah Williams', serviceType:'Healthcare', scale:1.24, margin:19.4, laborDrift:12.6, overtime:15.8, arDays:63 },
  { id:'bos-01', winTeamId:'WT-10405', customer:'Cobalt Research', name:'Cambridge Innovation Park', city:'Cambridge', state:'MA', zip:'02142', address:'120 Broadway', latitude:42.366, longitude:-71.088, region:'Northeast', branch:'Boston', siteManager:'Caleb Wright', operationsManager:'Priya Shah', accountManager:'Olivia Chen', serviceType:'Janitorial', scale:.86, margin:34.3, laborDrift:-4.1, overtime:2.9, arDays:19 },
  { id:'mia-01', winTeamId:'WT-10198', customer:'Coastal Hospitality', name:'Biscayne Resort Complex', city:'Miami', state:'FL', zip:'33132', address:'1100 Biscayne Blvd', latitude:25.785, longitude:-80.19, region:'Southeast', branch:'South Florida', siteManager:'Camila Rivera', operationsManager:'Derrick King', accountManager:'Emma Davis', serviceType:'Janitorial', scale:1.18, margin:17.8, laborDrift:14.8, overtime:18.1, arDays:72 },
  { id:'clt-01', winTeamId:'WT-10444', customer:'Beacon Financial', name:'Charlotte Operations Center', city:'Charlotte', state:'NC', zip:'28202', address:'550 S Tryon St', latitude:35.225, longitude:-80.846, region:'Southeast', branch:'Carolinas', siteManager:'Maya Johnson', operationsManager:'Derrick King', accountManager:'Emma Davis', serviceType:'Janitorial', scale:.81, margin:29.6, laborDrift:1.5, overtime:5.2, arDays:28 },
  { id:'sea-01', winTeamId:'WT-10584', customer:'Apex Commerce', name:'Puget Sound Fulfillment Hub', city:'Kent', state:'WA', zip:'98032', address:'22600 64th Ave S', latitude:47.402, longitude:-122.255, region:'West', branch:'Pacific Northwest', siteManager:'Ethan Lee', operationsManager:'Hannah Scott', accountManager:'Olivia Chen', serviceType:'Industrial', scale:1.41, margin:25.9, laborDrift:6.7, overtime:9.4, arDays:34 },
  { id:'la-01', winTeamId:'WT-10167', customer:'Pacific Media Group', name:'Culver Studios Campus', city:'Culver City', state:'CA', zip:'90232', address:'9336 Washington Blvd', latitude:34.024, longitude:-118.394, region:'West', branch:'Los Angeles', siteManager:'Grace Park', operationsManager:'Hannah Scott', accountManager:'Mia Thompson', serviceType:'Janitorial', scale:1.28, margin:32.6, laborDrift:-1.2, overtime:4.4, arDays:22 },
  { id:'sf-01', winTeamId:'WT-10621', customer:'Cobalt Research', name:'Bay Research Laboratory', city:'South San Francisco', state:'CA', zip:'94080', address:'700 Gateway Blvd', latitude:37.657, longitude:-122.401, region:'West', branch:'Bay Area', siteManager:'Theo Nguyen', operationsManager:'Hannah Scott', accountManager:'Olivia Chen', serviceType:'Healthcare', scale:1.12, margin:21.7, laborDrift:8.3, overtime:11.6, arDays:42 },
  { id:'den-01', winTeamId:'WT-10334', customer:'Summit Education', name:'Front Range University', city:'Denver', state:'CO', zip:'80210', address:'2199 S University Blvd', latitude:39.678, longitude:-104.963, region:'West', branch:'Mountain', siteManager:'Jordan Blake', operationsManager:'Hannah Scott', accountManager:'Noah Williams', serviceType:'Education', scale:.93, margin:27.5, laborDrift:2.8, overtime:6.1, arDays:29 },
  { id:'phx-01', winTeamId:'WT-10542', customer:'Apex Commerce', name:'Sonoran Distribution Center', city:'Phoenix', state:'AZ', zip:'85043', address:'7100 W Buckeye Rd', latitude:33.435, longitude:-112.209, region:'West', branch:'Southwest', siteManager:'Mateo Cruz', operationsManager:'Hannah Scott', accountManager:'Olivia Chen', serviceType:'Industrial', scale:1.05, margin:15.2, laborDrift:17.4, overtime:21.5, arDays:55 },
  { id:'stl-01', winTeamId:'WT-10264', customer:'Summit Education', name:'Gateway Public Schools', city:'St. Louis', state:'MO', zip:'63110', address:'4200 Manchester Ave', latitude:38.625, longitude:-90.258, region:'Central', branch:'St. Louis', siteManager:'Avery Morgan', operationsManager:'Marcus Reed', accountManager:'Noah Williams', serviceType:'Education', scale:.78, margin:30.1, laborDrift:-.8, overtime:3.2, arDays:20 },
  { id:'msp-01', winTeamId:'WT-10473', customer:'Harbor Properties', name:'Twin Cities Office Portfolio', city:'Minneapolis', state:'MN', zip:'55402', address:'80 S 8th St', latitude:44.976, longitude:-93.27, region:'Central', branch:'Upper Midwest', siteManager:'Riley Jensen', operationsManager:'Marcus Reed', accountManager:'Mia Thompson', serviceType:'Janitorial', scale:.96, margin:27.1, laborDrift:2.1, overtime:5.9, arDays:33 },
  { id:'det-01', winTeamId:'WT-10648', customer:'Atlas Manufacturing', name:'Detroit Assembly Campus', city:'Detroit', state:'MI', zip:'48211', address:'3900 E Grand Blvd', latitude:42.377, longitude:-83.058, region:'Central', branch:'Great Lakes', siteManager:'Harper Evans', operationsManager:'Marcus Reed', accountManager:'Mia Thompson', serviceType:'Industrial', scale:1.38, margin:22.5, laborDrift:7.9, overtime:13.2, arDays:45 },
  { id:'bna-01', winTeamId:'WT-10308', customer:'Meridian Health', name:'Nashville Specialty Hospital', city:'Nashville', state:'TN', zip:'37203', address:'1818 Patterson St', latitude:36.153, longitude:-86.799, region:'Southeast', branch:'Tennessee', siteManager:'Zoe Parker', operationsManager:'Derrick King', accountManager:'Noah Williams', serviceType:'Healthcare', scale:1.01, margin:28.9, laborDrift:1.8, overtime:5.4, arDays:27 },
  { id:'dc-01', winTeamId:'WT-10503', customer:'Harbor Properties', name:'Capitol Office Portfolio', city:'Washington', state:'DC', zip:'20005', address:'1101 15th St NW', latitude:38.904, longitude:-77.034, region:'Northeast', branch:'Mid-Atlantic', siteManager:'Sam Wilson', operationsManager:'Priya Shah', accountManager:'Mia Thompson', serviceType:'Janitorial', scale:1.15, margin:33.4, laborDrift:-3.3, overtime:3.7, arDays:18 },
  { id:'tor-01', winTeamId:'WT-CA-1007', customer:'Harbor Properties', name:'Toronto Financial District Portfolio', city:'Toronto', state:'ON', zip:'M5J 2N8', address:'100 King St W', latitude:43.648, longitude:-79.381, region:'Northeast', branch:'Ontario', siteManager:'Amara Singh', operationsManager:'Priya Shah', accountManager:'Mia Thompson', serviceType:'Janitorial', scale:1.22, margin:29.2, laborDrift:2.7, overtime:5.6, arDays:26, country:'Canada' },
  { id:'van-01', winTeamId:'WT-CA-1014', customer:'Pacific Media Group', name:'Vancouver Production Campus', city:'Vancouver', state:'BC', zip:'V6B 1A1', address:'885 W Georgia St', latitude:49.283, longitude:-123.119, region:'West', branch:'British Columbia', siteManager:'Eli Chen', operationsManager:'Hannah Scott', accountManager:'Olivia Chen', serviceType:'Janitorial', scale:.88, margin:24.1, laborDrift:6.4, overtime:8.9, arDays:37, country:'Canada' },
  { id:'cal-01', winTeamId:'WT-CA-1022', customer:'Atlas Manufacturing', name:'Calgary Industrial Services Hub', city:'Calgary', state:'AB', zip:'T2P 1J9', address:'421 7 Ave SW', latitude:51.047, longitude:-114.071, region:'West', branch:'Alberta', siteManager:'Noah Cardinal', operationsManager:'Hannah Scott', accountManager:'Mia Thompson', serviceType:'Industrial', scale:.94, margin:20.7, laborDrift:10.8, overtime:13.5, arDays:49, country:'Canada' },
  { id:'mtl-01', winTeamId:'WT-CA-1031', customer:'Cobalt Research', name:'Montréal Life Sciences Center', city:'Montréal', state:'QC', zip:'H3B 2Y5', address:'1250 René-Lévesque Blvd W', latitude:45.497, longitude:-73.570, region:'Northeast', branch:'Québec', siteManager:'Camille Roy', operationsManager:'Priya Shah', accountManager:'Olivia Chen', serviceType:'Healthcare', scale:1.02, margin:26.6, laborDrift:3.9, overtime:6.2, arDays:32, country:'Canada' }
]

export const jobs: JobSite[] = seeds.map((seed, index) => {
  const revenue = Math.round(126_000 * seed.scale)
  const directCost = revenue * (1 - seed.margin / 100)
  const labor = Math.round(directCost * .72)
  const scheduledHours = Math.round(labor / 21.4)
  const actualHours = Math.round(scheduledHours * (1 + seed.laborDrift / 100))
  const status = seed.margin < 18 || seed.laborDrift > 13 || seed.arDays > 65 ? 'Critical' : seed.margin < 24 || seed.laborDrift > 7 || seed.arDays > 45 ? 'Watch' : 'Healthy'
  return {
    ...seed,
    country: seed.country ?? 'United States',
    status,
    contractStart: `${2021 + (index % 4)}-${String((index % 9) + 1).padStart(2, '0')}-01`,
    contractValue: revenue * 12,
    billingFrequency: index % 5 === 0 ? 'Biweekly' : 'Monthly',
    revenue,
    budgetRevenue: Math.round(revenue * (index % 4 === 0 ? 1.035 : .985)),
    labor,
    laborBudget: Math.round(labor / (1 + seed.laborDrift / 100)),
    supplies: Math.round(directCost * .09),
    payrollBurden: Math.round(directCost * .135),
    otherDirectCosts: Math.round(directCost * .055),
    scheduledHours,
    actualHours,
    overtimeHours: Math.round(actualHours * seed.overtime / 100),
    payRate: +(19.1 + (index % 7) * .55).toFixed(2),
    billRate: +(31.8 + (index % 6) * 1.15).toFixed(2),
    openReceivables: Math.round(revenue * seed.arDays / 30 * .72),
    daysOutstanding: seed.arDays,
    lastInvoiceDate: `2026-08-${String(4 + (index % 19)).padStart(2, '0')}`,
  }
})

const monthNames = ['Sep','Oct','Nov','Dec','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug']
export const monthlyPerformance: MonthlyPerformance[] = monthNames.map((month, index) => {
  const revenue = 1_940_000 + index * 46_000 + Math.sin(index * 1.3) * 115_000
  const budget = 1_980_000 + index * 42_000
  const labor = revenue * (.486 + Math.sin(index * .9) * .014)
  const grossProfit = revenue * (.284 + Math.cos(index * .65) * .012)
  return {
    month,
    revenue: Math.round(revenue),
    budget,
    labor: Math.round(labor),
    grossProfit: Math.round(grossProfit),
    ebitda: Math.round(revenue * (.104 + Math.cos(index * .7) * .009)),
    invoiced: Math.round(revenue * (1.01 + Math.sin(index) * .018)),
    collected: Math.round(revenue * (.974 + Math.cos(index * .8) * .023)),
    hours: Math.round(labor / 21.7),
    overtime: Math.round(labor / 21.7 * (.071 + Math.sin(index) * .009)),
  }
})

export const sourceFreshness = [
  { source: 'Financial data mart', state: 'Current', detail: 'Refreshed today · 5:42 AM CT' },
  { source: 'WinTeam Jobs adapter', state: 'Mocked', detail: 'Seed contract v0.1 · API credentials pending' },
  { source: 'Metabase', state: 'Ready', detail: 'Embedding adapter configured · URL pending' },
]

// ---------------------------------------------------------------------------
// Demo dataset extension (deterministic). Everything below derives from the
// seeded sites above and is the only source the DemoApi adapter reads. It is
// synthetic, labeled demo data - never presented as live WinTeam output.
// ---------------------------------------------------------------------------
import { addMonths, daysInMonth, listMonths } from '../services/period'

export const DEMO_LATEST_MONTH = '2026-08-01'
export const DEMO_PACE_MONTH = '2026-09-01'
export const DEMO_PACE_AS_OF = '2026-09-14'
export const DEMO_AS_OF = '2026-09-01T05:42:00Z'
export const DEMO_AR_AS_OF = '2026-09-01'
export const DEMO_FIRST_MONTH = '2024-09-01'
export const demoMonths = listMonths(DEMO_FIRST_MONTH, DEMO_LATEST_MONTH) // 24 closed months

/** Small deterministic PRNG so demo noise is stable across reloads and tests. */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const verticalByCustomer: Record<string, string> = {
  'Apex Commerce': 'Logistics & distribution', 'Meridian Health': 'Healthcare', 'Beacon Financial': 'Financial services',
  'Harbor Properties': 'Commercial real estate', 'Cobalt Research': 'Life sciences', 'Coastal Hospitality': 'Hospitality',
  'Pacific Media Group': 'Media & entertainment', 'Summit Education': 'Education', 'Atlas Manufacturing': 'Manufacturing',
}
const customerNumbers = Object.fromEntries(Object.keys(verticalByCustomer).map((name, index) => [name, `C${String(101 + index)}`]))

export interface DemoJobMeta {
  index: number
  job_key: number
  job_number: string
  seedId: string
  customer_number: string
  vertical: string
  /** Absent months before this ISO month (site started mid-history). */
  startMonth: string | null
  /** Absent months after this ISO month (site ended; inactive). */
  endMonth: string | null
  site: JobSite
  /** Raw tuning knobs (margin, laborDrift, overtime, arDays) for the month generator. */
  seed: SiteSeed
}

export const demoJobMeta: DemoJobMeta[] = jobs.map((site, index) => ({
  index,
  job_key: index + 1,
  job_number: site.winTeamId.replace('WT-', '').replace('CA-', 'CA'),
  seedId: site.id,
  customer_number: customerNumbers[site.customer],
  vertical: verticalByCustomer[site.customer] ?? 'Commercial',
  startMonth: site.id === 'stl-01' ? '2026-01-01' : null,
  endMonth: site.id === 'van-01' ? '2026-05-01' : null,
  site,
  seed: seeds[index],
}))

export interface DemoJobMonth {
  job_number: string
  month: string
  revenue: number
  invoiced_total: number
  collected_total: number
  budget_revenue: number | null
  labor_cost: number
  burden_cost: number
  budget_labor: number | null
  gross_profit: number
  hours: number
  regular_hours: number
  overtime_hours: number
  scheduled_hours: number
  employee_count: number
}

const monthIndex = (iso: string) => demoMonths.indexOf(iso)
/** One small site (Charlotte) carries no budget so the coverage note and null-variance states are exercised without distorting portfolio totals. */
const hasBudget = (meta: DemoJobMeta) => meta.seedId !== 'clt-01'

function buildJobMonth(meta: DemoJobMeta, month: string, position: number): DemoJobMonth {
  const site = meta.site
  const rng = mulberry32(meta.index * 1009 + position * 7 + 17)
  const calendarMonth = Number(month.slice(5, 7))
  const growth = 1 + (position - 23) * 0.0035
  const season = 1 + 0.03 * Math.sin(((calendarMonth - 1) / 12) * Math.PI * 2 + meta.index * 0.3)
  const scale = growth * season
  const revenueBase = site.revenue * scale
  const revenue = Math.round(revenueBase * (1 + (rng() - 0.5) * 0.04))
  const directCost = revenue * (1 - meta.seed.margin / 100) * (1 + (rng() - 0.5) * 0.03)
  const laborNoiseless = directCost * 0.75
  const labor_cost = Math.round(laborNoiseless * (1 + (rng() - 0.5) * 0.02))
  const burden_cost = Math.round(directCost * 0.25)
  const budget_labor = hasBudget(meta) ? Math.round(laborNoiseless / (1 + meta.seed.laborDrift / 100)) : null
  const budget_revenue = hasBudget(meta) ? Math.round(revenueBase * (meta.index % 4 === 0 ? 1.035 : 0.985)) : null
  const scheduled_hours = Math.round(site.scheduledHours * scale)
  const hours = Math.round(site.actualHours * scale * (1 + (rng() - 0.5) * 0.03))
  const overtime_hours = Math.round(hours * site.overtimeHours / Math.max(1, site.actualHours))
  return {
    job_number: meta.job_number,
    month,
    revenue,
    invoiced_total: Math.round(revenue * (1 + (rng() - 0.5) * 0.06)),
    collected_total: Math.round(revenue * (0.97 + (rng() - 0.5) * 0.05)),
    budget_revenue,
    labor_cost,
    burden_cost,
    budget_labor,
    gross_profit: revenue - labor_cost - burden_cost,
    hours,
    regular_hours: hours - overtime_hours,
    overtime_hours,
    scheduled_hours,
    employee_count: Math.max(2, Math.round(hours / 160)),
  }
}

export const demoJobMonths: DemoJobMonth[] = demoJobMeta.flatMap((meta) =>
  demoMonths
    .filter((month) => (!meta.startMonth || month >= meta.startMonth) && (!meta.endMonth || month <= meta.endMonth))
    .map((month) => buildJobMonth(meta, month, monthIndex(month))),
)

/** Day-of-week weighting used by the pace projection: weekdays 1.0, weekend 0.35. */
export const paceWeights = (month: string, throughDay: number) => {
  const [year, m] = month.split('-').map(Number)
  const total = daysInMonth(month)
  let elapsed = 0, full = 0
  for (let day = 1; day <= total; day++) {
    const dow = new Date(Date.UTC(year, m - 1, day)).getUTCDay()
    const weight = dow === 0 || dow === 6 ? 0.35 : 1
    full += weight
    if (day <= throughDay) elapsed += weight
  }
  return { elapsed, full, fraction: elapsed / full, days: total }
}

/** September 2026 in progress (through the 14th) for the labor pace view and partial-month history marker. */
export const demoPartialMonth: DemoJobMonth[] = demoJobMeta
  .filter((meta) => !meta.endMonth)
  .map((meta) => {
    const whole = buildJobMonth(meta, DEMO_PACE_MONTH, 24)
    const rng = mulberry32(meta.index * 31 + 5)
    const fraction = paceWeights(DEMO_PACE_MONTH, 14).fraction * (1 + (rng() - 0.5) * 0.06)
    const scaled = (value: number) => Math.round(value * fraction)
    return {
      ...whole,
      revenue: scaled(whole.revenue), invoiced_total: scaled(whole.invoiced_total), collected_total: scaled(whole.collected_total),
      labor_cost: scaled(whole.labor_cost), burden_cost: scaled(whole.burden_cost), gross_profit: scaled(whole.gross_profit),
      hours: scaled(whole.hours), regular_hours: scaled(whole.regular_hours), overtime_hours: scaled(whole.overtime_hours), scheduled_hours: scaled(whole.scheduled_hours),
    }
  })

export interface DemoInvoice {
  invoice_number: string
  customer_number: string
  customer_name: string
  parent_account: string
  job_number: string
  job_name: string
  invoice_date: string
  terms: string
  days_outstanding: number
  open_balance: number
  amount_paid: number
  invoice_total: number
  collection_status: string
}

const shiftDate = (iso: string, days: number) => {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export const demoInvoices: DemoInvoice[] = demoJobMeta.flatMap((meta) => {
  const site = meta.site
  if (!site.openReceivables) return []
  const rng = mulberry32(meta.index * 77 + 3)
  const count = 2 + (meta.index % 3)
  const weights = Array.from({ length: count }, () => 0.5 + rng())
  const weightTotal = weights.reduce((a, b) => a + b, 0)
  let remaining = site.openReceivables
  return weights.map((weight, i) => {
    const amount = i === count - 1 ? remaining : Math.round(site.openReceivables * weight / weightTotal)
    remaining -= amount
    const days = Math.max(4, Math.round(site.daysOutstanding + (i - (count - 1) / 2) * 17 + (rng() - 0.5) * 6))
    const invoice_date = shiftDate(DEMO_AR_AS_OF, -days)
    const invoice_total = Math.round(amount * (1 + rng() * 0.35))
    return {
      invoice_number: `INV-${meta.job_number}-${String(2600 + i)}`,
      customer_number: meta.customer_number,
      customer_name: site.customer,
      parent_account: site.customer,
      job_number: meta.job_number,
      job_name: site.name,
      invoice_date,
      terms: 'Net 30',
      days_outstanding: days,
      open_balance: amount,
      amount_paid: invoice_total - amount,
      invoice_total,
      collection_status: days > 30 ? 'Past Due' : 'Current',
    }
  })
})

export const demoVendors = [
  { vendor_number: 'V-2001', vendor_name: 'Crestline Supply Co.', share: 0.24 },
  { vendor_number: 'V-2002', vendor_name: 'Evergreen Subcontracting', share: 0.21 },
  { vendor_number: 'V-2003', vendor_name: 'Metro Floor Care', share: 0.14 },
  { vendor_number: 'V-2004', vendor_name: 'Northwind Chemicals', share: 0.12 },
  { vendor_number: 'V-2005', vendor_name: 'Summit Equipment Rental', share: 0.1 },
  { vendor_number: 'V-2006', vendor_name: 'Harbor Waste Services', share: 0.08 },
  { vendor_number: 'V-2007', vendor_name: 'Pinnacle Window Services', share: 0.06 },
  { vendor_number: 'V-2008', vendor_name: 'Beacon Uniform Co.', share: 0.05 },
]

export interface DemoApMonth { vendor_number: string; month: string; invoiced: number; paid: number; invoices: number }

export const demoApMonths: DemoApMonth[] = demoMonths.flatMap((month, position) => {
  const revenue = demoJobMonths.filter((row) => row.month === month).reduce((sum, row) => sum + row.revenue, 0)
  return demoVendors.map((vendor, v) => {
    const rng = mulberry32(position * 13 + v * 101)
    const invoiced = Math.round(revenue * 0.09 * vendor.share * (1 + (rng() - 0.5) * 0.12))
    return { vendor_number: vendor.vendor_number, month, invoiced, paid: Math.round(invoiced * (0.86 + rng() * 0.1)), invoices: 3 + Math.round(rng() * 9) }
  })
})

export interface DemoEmployee { employee_source_id: string; job_number: string; hoursShare: number; overtimeShare: number }

/** Three employees per site; overtime concentrates on the first. */
export const demoEmployees: DemoEmployee[] = demoJobMeta.flatMap((meta) => [
  { employee_source_id: `E${meta.job_number}-01`, job_number: meta.job_number, hoursShare: 0.42, overtimeShare: 0.62 },
  { employee_source_id: `E${meta.job_number}-02`, job_number: meta.job_number, hoursShare: 0.33, overtimeShare: 0.28 },
  { employee_source_id: `E${meta.job_number}-03`, job_number: meta.job_number, hoursShare: 0.25, overtimeShare: 0.1 },
])

export const demoSettings = [
  { key: 'target_gross_margin_pct', value: 25, description: 'Gross margin target used by the site status rule (pts).' },
  { key: 'margin_critical_delta_pts', value: 7, description: 'Critical when gross margin is this many points below target.' },
  { key: 'target_labor_pct', value: 56, description: 'Target labor cost as a percent of revenue.' },
  { key: 'labor_over_budget_watch_pct', value: 7, description: 'Watch when labor exceeds budget by more than this percent.' },
  { key: 'labor_over_budget_critical_pct', value: 13, description: 'Critical when labor exceeds budget by more than this percent.' },
  { key: 'ot_watch_pct', value: 10, description: 'Watch when overtime exceeds this percent of hours.' },
  { key: 'ot_critical_pct', value: 15, description: 'Critical when overtime exceeds this percent of hours.' },
  { key: 'ar_days_watch', value: 45, description: 'Watch when weighted AR days exceed this value.' },
  { key: 'ar_days_critical', value: 65, description: 'Critical when weighted AR days exceed this value.' },
  { key: 'overtime_rule', value: 'Hours over 40 per employee per work week (Sunday start)', description: 'How overtime hours are derived from timekeeping punches.' },
  { key: 'overtime_multiplier', value: 1.5, description: 'Multiplier applied to the blended hourly rate when estimating overtime cost.' },
  { key: 'revenue_basis', value: 'AR invoice revenueTotal by service month', description: 'Revenue definition used by the reporting marts.' },
]

export const demoResources = ['jobs', 'customers', 'ar_invoices', 'ap_invoices', 'timekeeping', 'schedules', 'budgets']

export { addMonths as demoAddMonths }
