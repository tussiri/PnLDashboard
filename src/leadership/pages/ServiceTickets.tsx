import { useApiQuery } from '../../hooks/useApiQuery'
import type { LeadershipAccount, ServiceTicket, ServiceTicketsResponse, TicketRateBand, TicketRisk } from '../../services/apiTypes'
import { queryKey } from '../../services/queryClient'
import { pct } from '../format'
import { useLeadership } from '../state'
import { Kpi, LoadError, Skeleton, SortTable, type Column } from '../ui'
import { scoreTone, stars } from './Feedback'

/** Service tickets with the star ratings ahead of them (GET /leadership/service-tickets). Renders nothing for an
 * account with no tickets. */
export function ServiceTickets({ account }: { account: LeadershipAccount }) {
  const { api, keyPrefix, decision, navigate } = useLeadership()
  const q = useApiQuery<ServiceTicketsResponse>(decision ? queryKey(`${keyPrefix}/leadership/service-tickets`, { account: account.slug }) : null,
    (signal) => api.serviceTickets(account.slug, signal), [api, account.slug])
  if (q.error) return <LoadError error={q.error} onRetry={q.refetch} />
  if (!q.data) return <Skeleton height={240} />
  const d = q.data
  if (!d.tickets.length) return null
  const open = (r: { company: string | null; job_number: string | null }) => r.company && r.job_number && navigate({ site: { company: r.company, job: r.job_number } })
  const site = (r: { site_name: string | null; location_number: string }) => r.site_name ?? `Location ${r.location_number}`
  const before = new Map(d.before.map((b) => [b.ticket_number, b]))
  const window = `${d.lookback_days} days`
  const under3 = d.bands.find((b) => b.band === 'Under 3.0')
  const top = d.bands.find((b) => b.band === '4.5 to 5.0')

  // Bands in their own order (lowest rating first, then the 1-2 star split), not alphabetical.
  const bandRows = [...d.bands, ...d.low_split]
  const bandCols: Column<TicketRateBand>[] = [
    { key: 'band', header: `Avg rating, prior ${window}`, left: true, value: (r) => bandRows.indexOf(r), render: (r) => r.band, csv: (r) => r.band, sortable: false },
    { key: 'obs', header: 'Location-months', value: (r) => r.observations, sortable: false },
    { key: 'tickets', header: `Ticket within ${d.horizon_days} days`, value: (r) => r.tickets, sortable: false },
    { key: 'rate', header: 'Ticket rate', value: (r) => r.rate, render: (r) => pct(r.rate), sortable: false },
  ]
  const riskCols: Column<TicketRisk>[] = [
    { key: 'site', header: 'Site', left: true, value: site, className: 'nm' },
    { key: 'loc', header: 'Location', left: true, value: (r) => r.location_number },
    { key: 'risk', header: 'Ticket rate', value: (r) => r.risk, render: (r) => <span className={r.band === 'Under 3.0' ? 'bad' : r.band === '3.0 to 3.9' ? 'warn' : ''}>{pct(r.risk)}</span> },
    { key: 'avg', header: `Avg rating, ${window}`, value: (r) => r.average, render: (r) => <span className={scoreTone(r.average)}>{stars(r.average)}</span> },
    { key: 'n', header: 'Ratings', value: (r) => r.ratings },
    { key: 'low', header: '1-2 stars', value: (r) => r.low, render: (r) => <span className={r.low ? 'bad' : ''}>{r.low}</span> },
    { key: 'tickets', header: 'Past tickets', value: (r) => r.tickets },
    { key: 'last', header: 'Last ticket', left: true, value: (r) => r.last_ticket ?? '' },
    { key: 'comment', header: 'Latest 1-2 star comment', left: true, value: (r) => r.latest_low_comment ?? '', className: 'wrap' },
  ]
  const ticketCols: Column<ServiceTicket>[] = [
    { key: 'ticket', header: 'Ticket', left: true, value: (r) => r.ticket_number },
    { key: 'status', header: 'Status', left: true, value: (r) => (r.open ? `0 ${r.status}` : `1 ${r.status}`), render: (r) => <span className={r.open ? 'bad' : 'neutral'}>{r.status ?? '–'}</span>, csv: (r) => r.status },
    { key: 'opco', header: 'OPCO', left: true, value: (r) => r.opco ?? '' },
    { key: 'site', header: 'Site', left: true, value: site, className: 'nm' },
    { key: 'loc', header: 'Location', left: true, value: (r) => r.location_label ?? r.location_number },
    { key: 'issue', header: 'Issue', left: true, value: (r) => r.issue_type ?? '' },
    { key: 'level', header: 'Escalation', left: true, value: (r) => r.escalation_level ?? '' },
    { key: 'received', header: 'Received', left: true, value: (r) => r.date_received ?? '' },
    { key: 'days', header: 'Days open', value: (r) => r.days_open },
    { key: 'before', header: `Avg rating, prior ${window}`, value: (r) => before.get(r.ticket_number)?.average_before ?? null,
      render: (r) => { const b = before.get(r.ticket_number); return <span className={scoreTone(b?.average_before ?? null)}>{stars(b?.average_before ?? null)}</span> } },
    { key: 'overall', header: 'Site avg', value: (r) => before.get(r.ticket_number)?.average_overall ?? null, render: (r) => stars(before.get(r.ticket_number)?.average_overall ?? null) },
    { key: 'expected', header: 'Expected close', left: true, value: (r) => r.expected_close ?? '' },
    { key: 'closed', header: 'Closed', left: true, value: (r) => r.date_closed ?? '' },
    { key: 'owner', header: 'Assigned', left: true, value: (r) => r.assigned_to ?? '' },
    { key: 'note', header: 'Latest note', left: true, value: (r) => r.latest_note ?? '', className: 'wrap', csv: (r) => r.notes },
  ]
  return <>
    <div className="kpi-lg">
      <Kpi label="Open tickets" value={d.open.toLocaleString('en-US')} tone={d.open ? 'bad' : 'ok'} sub={`${d.tickets.length} tickets`} />
      <Kpi label={`Ticket rate, avg under 3.0`} value={pct(under3?.rate ?? null)} tone="bad" sub={`4.5 and up ${pct(top?.rate ?? null)}`} />
      <Kpi label="Lift" value={d.lift == null ? '–' : `${d.lift.toFixed(1)}x`} sub="Under 3.0 vs 4.5 and up" />
      <Kpi label="Correlation" value={d.correlation == null ? '–' : d.correlation.toFixed(2)} sub={`Avg rating to ticket, ${d.observations.toLocaleString('en-US')} location-months`} />
    </div>
    <div className="card"><div className="ct"><span>Ticket rate by rating</span><span className="ks">Prior {window}, ticket within {d.horizon_days} days</span></div>
      <SortTable caption="Ticket rate by rating" rows={bandRows} columns={bandCols} defaultSort={{ key: 'band', dir: 1 }} /></div>
    <div className="card"><div className="ct"><span>Next ticket risk</span><span className="ks">No open ticket, ratings in the last {window}</span></div>
      <SortTable caption="Next ticket risk" rows={d.risk} columns={riskCols} defaultSort={{ key: 'risk', dir: -1 }} pageSize={25}
        onRowClick={open} rowLabel={(r) => `Open ${site(r)}`} csvName={`${account.slug}-ticket-risk`} /></div>
    <div className="card"><div className="ct"><span>Service tickets</span><span className="ks">{d.open} open{d.unmatched ? `, ${d.unmatched} with no WinTeam job` : ''}</span></div>
      <SortTable caption="Service tickets" rows={d.tickets} columns={ticketCols} defaultSort={{ key: 'status', dir: 1 }} pageSize={25}
        onRowClick={open} rowLabel={(r) => `Open ${site(r)}`} csvName={`${account.slug}-service-tickets`} /></div>
  </>
}
