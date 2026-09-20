"""Server-side data sources other than the WinTeam API.

`finance_reference` loads the real WinTeam report exports restored from the Finance_Dashboard
PostgreSQL dump (database `finance_reference`, read-only) into the same core/mart tables the
WinTeam API connector fills. `rules` holds the pure derivation rules shared by the loader and
its tests.
"""
