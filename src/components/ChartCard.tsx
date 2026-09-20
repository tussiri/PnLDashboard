import type { ReactNode } from 'react'

/**
 * Consistent card header pattern: title, subtitle (resolved range · units), action slot.
 * Body fills the remaining height so charts can use ResponsiveContainer 100%.
 */
export function ChartCard({ title, subtitle, action, className = '', children, note, id }: { title: string; subtitle?: ReactNode; action?: ReactNode; className?: string; children: ReactNode; note?: ReactNode; id?: string }) {
  return (
    <section className={`chart-card ${className}`} id={id} aria-label={title}>
      <header className="chart-card__header">
        <div className="chart-card__heading"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        {action && <div className="chart-card__action">{action}</div>}
      </header>
      <div className="chart-card__body">{children}</div>
      {note && <footer className="chart-card__note">{note}</footer>}
    </section>
  )
}
