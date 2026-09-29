import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import { useEffect, useRef, useState } from 'react'
import type { LeadershipAccount, LeadershipRow } from '../../services/apiTypes'
import { statusColor, useTokens } from '../charts'
import { money, pct } from '../format'
import type { AccountSummary as Summary, SiteMetrics as Metrics } from '../metrics'
import { useLeadership } from '../state'
import { Empty, Swatch, STATUS_LABEL, toneOf } from '../ui'

type AccountSummary = Summary<LeadershipRow>
type SiteMetrics = Metrics<LeadershipRow>

// The cluster plugin expects a browser-global `L`; set it before loading the plugin.
;(globalThis as typeof globalThis & { L: typeof L }).L = L
const clusterReady = import('leaflet.markercluster')

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
type Located = SiteMetrics & { latitude: number; longitude: number }
const located = (r: SiteMetrics): r is Located => Number.isFinite(r.latitude as number) && Number.isFinite(r.longitude as number)

/** The account's sites on a map, colored by labor (or cost) % status; a marker opens the site drawer. */
export default function SiteMap({ account, summary }: { account: LeadershipAccount; summary: AccountSummary }) {
  const t = useTokens()
  const { navigate } = useLeadership()
  const box = useRef<HTMLDivElement | null>(null)
  const [failed, setFailed] = useState(false)
  const sites = summary.sites.filter(located)
  const missing = summary.sites.filter((r) => !located(r))

  useEffect(() => {
    if (!box.current || !sites.length) return
    let disposed = false
    let map: L.Map | undefined
    clusterReady.then(() => {
      if (disposed || !box.current) return
      map = L.map(box.current, { minZoom: 3, maxZoom: 17, preferCanvas: true })
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map)
      const group = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 36, spiderfyOnMaxZoom: true })
      for (const r of sites) {
        const color = r.role === 'site' ? statusColor(t, toneOf(r.status)) : t.muted
        const marker = L.circleMarker([r.latitude, r.longitude], { radius: 7, color: t.bg, weight: 2, fillColor: color, fillOpacity: 1 })
        const status = r.role === 'site' ? STATUS_LABEL[r.status] : r.role === 'catch_all' ? 'Catch-all' : 'Non-billed'
        marker.bindTooltip(`<b>${escapeHtml(`${r.job_number} ${r.site_name}`)}</b><br>Labor % ${pct(r.measurePct)} (${status})<br>Invoicing ${money(r.invoice)}, total labor ${money(r.cost)}`, { direction: 'top' })
        marker.on('click', () => navigate({ site: { company: r.company ?? '', job: r.job_number } }))
        group.addLayer(marker)
      }
      map.addLayer(group)
      map.fitBounds(L.latLngBounds(sites.map((r) => [r.latitude, r.longitude] as [number, number])).pad(0.1))
    }).catch(() => setFailed(true))
    return () => { disposed = true; map?.remove() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sites.length, account.slug, t, summary])

  if (!sites.length) return <Empty>No sites have coordinates.</Empty>
  return <>
    <div className="legend" aria-label="Marker colors">
      <Swatch color={t.ok} label={STATUS_LABEL.on_target} /><Swatch color={t.warn} label={STATUS_LABEL.watch} /><Swatch color={t.bad} label={STATUS_LABEL.over} />
      <Swatch color={t.text3} label={STATUS_LABEL.no_billing} /><Swatch color={t.muted} label="Catch-all or non-billed" />
    </div>
    {failed ? <Empty>Map failed to load.</Empty> : <div className="map" ref={box} role="region" aria-label={`Map of ${sites.length} ${account.name} sites; the Sites tab lists the same sites`} />}
    {missing.length > 0 && <p className="foot">No coordinates: {missing.map((r) => `${r.job_number} ${r.site_name}`).join(', ')}.</p>}
  </>
}
