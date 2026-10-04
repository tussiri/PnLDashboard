# Frontend

React 18 + TypeScript + Vite, Chart.js (react-chartjs-2) and Leaflet. The app lives in
`src/leadership/`; `src/services/` is the data seam and `src/auth/` the sign-in. `src/suite/` is the
analytics suite, for super administrators only (last section).

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

## Analytics suite (`src/suite/`)

The Finance and Operations views of the retired reporting app, restored under Analytics for super
administrators (`docs/auth-rbac.md`). Routes: `#/analytics/finance/<page>`,
`#/analytics/operations/<page>` and `#/analytics/operations/jobs/<job number>` for a site.

| Path | Role |
|---|---|
| `suite/Suite.tsx` | Host: header, the Analytics tab row, the page pills, the filter bar, the view. Loaded with `React.lazy` from `App.tsx`, so the suite (and Recharts, which only it uses) is a separate chunk that other users never download. |
| `suite/pages.ts` | The twelve pages, their groups, labels and whether the filter bar applies. |
| `suite/views/*`, `suite/components/*` | The views and their pieces (Recharts charts, `DataGrid`, KPI cards, the operations map), as they were. |
| `suite/context/DashboardContext.tsx` | Period, scope and dimension filters (kept in localStorage), the reported range and source, toasts. Live or demo follows the leadership shell's decision. |
| `suite/services/*` | `api.ts`: the reporting, labor and forecast routes on the app's request core (ratios as percentage points here). `demoApi.ts` and `data/seed.ts`: the seeded demo dataset for these views. |
| `suite/suite.css` | The retired app's stylesheet with every selector scoped to `.suite`; light palette in both themes. |

- The gate is `superAdmin` from `leadership/state.tsx` (`isSuperAdmin` in `auth/roles.ts`): it decides
  the Finance and Operations tabs (`leadership/pages/AnalyticsTabs.tsx`) and the route in `App.tsx`.
  The API enforces the same on its routes.
- The suite shares the query cache with the leadership views; its keys start with `suite/`.
- Not carried over: the old Executive overview (now Analytics > Business units), Alerts, Reports,
  Data dictionary and the old Administration page.
