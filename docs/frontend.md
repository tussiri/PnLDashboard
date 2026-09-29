# Frontend

React 18 + TypeScript + Vite, Chart.js (react-chartjs-2) and Leaflet. The app lives in
`src/leadership/`; `src/services/` is the data seam and `src/auth/` the sign-in.

## Structure

| Path | Role |
|---|---|
| `leadership/metrics.ts` | Every derived metric (invoicing, labor %, base rate, $ Var and hours to cut with its worked / OT premium / sub split, OT premium, prior-month %, status, rollups, notes), named as in the weekly reports. Pure; tested against the Plano reference week. |
| `leadership/routes.ts` | Hash routes; account, week (week-ending date), target, open site and Analytics filters in the URL. |
| `leadership/state.tsx` | Live/demo mode, config query, route state, theme, per-account metric options. |
| `leadership/Shell.tsx` | Top nav, page header controls (account, week, target), freshness line. |
| `leadership/Overview.tsx` | The reference Overview: KPIs, notes panel, segment cards, two charts. Used by Home and Account. |
| `leadership/pages/*` | Home, Account (tabs), SiteDrawer, SiteMap, Vendors, Analytics, Admin. |
| `leadership/charts.tsx`, `ui.tsx` | Chart.js charts (colors from CSS tokens) and shared pieces (KPI, badge, sortable table with CSV, chart card with table view). |
| `leadership/leadership.css` | Tokens and styles from the reference: 14px base, 1180px shell, light and dark themes. |

## Data

Views read only the `/leadership/*` routes (`docs/api-contract.md`, "Leadership labor P&L") through
`services/api.ts`. Ratios stay fractions on these routes. When the API is unreachable or the marts are
empty, `services/demoApi.ts` answers from the reference week (`demoLeadership.ts`) and the shell shows
a demo banner. Queries are cached by `services/queryClient.ts`, keyed with the data mode.

## Rules

- No symbol glyphs or emoji in UI copy (`copy.test.ts`); labels, values, units, dates, definitions.
- Every chart has a legend or title naming the series, hover tooltips and a table view.
- Tables sort by keyboard (header buttons with `aria-sort`) and export CSV.
- After frontend changes run `pnpm test` and `pnpm build`.
