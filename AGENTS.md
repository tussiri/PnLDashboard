# Crane IFS dashboard agent instructions

Read `HANDOFF.md` and `docs/api-contract.md` before making architectural or data changes.

## Project rules

- This directory is the authoritative source tree for the Crane IFS dashboard. The models were
  ported from `/Users/tumainiussiri/Finance_Reporting/FinanceDashboard`; do not modify that repo.
- Treat `sources/` as read-only reference material.
- Preserve existing user changes and avoid destructive Git, filesystem, or Docker-volume
  operations unless the user explicitly requests them. Do not rename the Compose project.
- WinTeam / TEAM Concourse: only the endpoints, parameters, headers and fields documented in
  `WinTeamAPI.txt` may be used (see `config/winteam-endpoints.md`). Tenant-specific meanings are
  settings in `ops.app_setting`, never hardcoded.
- WinTeam credentials and raw payloads stay server-side. The browser and Metabase consume the
  `/api/v1` contract and `mart` schema only. Nothing secret may use a `VITE_` prefix.
- Keep observed actuals, budgets, the browser scenario sandbox, and governed forecasts labeled
  distinctly. Demo data appears only when the API is unreachable or the marts are empty.
- Use versioned PostgreSQL migrations (`database/migrations`); never edit an applied one.
- The API contract in `docs/api-contract.md` is shared by the backend, the demo adapter and the
  views: change the doc, the router, `src/services/apiTypes.ts` and `demoApi.ts` together.
- After frontend changes run `pnpm test` and `pnpm build`. After API changes run the
  containerized pytest command in `HANDOFF.md`. After platform changes validate
  `docker compose -f compose.yaml -f compose.simulator.yaml config --quiet` and the health checks.
- Product name is **Crane IFS** (the company). "Northstar Facilities" was a placeholder and must not appear in user-facing copy; neither may "Command Center". No emoji or symbol glyphs in UI copy, and no explanatory prose on views: labels, values, units, dates and definitions only.
