import type { AuthUser, Role } from './roles'

/**
 * Per-user permissions, mirroring the API's catalog (services/api/app/permissions.py). A role is a
 * preset of defaults; a user's `permissions` (from /auth/me) are the effective values after the
 * administrator's overrides. The API enforces the same keys; these only decide what the views show.
 */
export type Permission =
  | 'view.company' | 'view.analytics'
  | 'tab.sites' | 'tab.pallet' | 'tab.over-target' | 'tab.overtime' | 'tab.income-statement' | 'tab.subcontracted' | 'tab.map' | 'tab.vendors' | 'tab.feedback' | 'tab.budget'
  | 'data.allocations' | 'data.month' | 'data.staffing' | 'data.invoices' | 'data.photos' | 'data.export' | 'data.qa'

export interface PermissionInfo { key: Permission; group: string; label: string }

export const PERMISSIONS: readonly PermissionInfo[] = [
  { key: 'view.company', group: 'Views', label: 'Company' },
  { key: 'view.analytics', group: 'Views', label: 'Portfolio' },
  { key: 'tab.sites', group: 'Account tabs', label: 'Sites' },
  { key: 'tab.pallet', group: 'Account tabs', label: 'Pallet' },
  { key: 'tab.over-target', group: 'Account tabs', label: 'Hours to cut' },
  { key: 'tab.overtime', group: 'Account tabs', label: 'Overtime' },
  { key: 'tab.income-statement', group: 'Account tabs', label: 'Income statement' },
  { key: 'tab.subcontracted', group: 'Account tabs', label: 'Subcontracted' },
  { key: 'tab.map', group: 'Account tabs', label: 'Map' },
  { key: 'tab.vendors', group: 'Account tabs', label: 'Vendors' },
  { key: 'tab.feedback', group: 'Account tabs', label: 'Feedback' },
  { key: 'tab.budget', group: 'Account tabs', label: 'Budget' },
  { key: 'data.allocations', group: 'Data', label: 'Allocations and margin' },
  { key: 'data.month', group: 'Data', label: 'Month rollup' },
  { key: 'data.staffing', group: 'Data', label: 'Staffing requests' },
  { key: 'data.invoices', group: 'Data', label: 'Vendor invoices' },
  { key: 'data.photos', group: 'Data', label: 'Photos' },
  { key: 'data.export', group: 'Data', label: 'CSV export' },
  { key: 'data.qa', group: 'Data', label: 'QA scores' },
]
export const PERMISSION_KEYS: readonly Permission[] = PERMISSIONS.map((p) => p.key)

const OFF: Record<Role, readonly Permission[]> = { executive: ['view.analytics', 'data.staffing'], analyst: ['view.analytics'], admin: [] }
export const ROLE_DEFAULTS: Record<Role, Record<Permission, boolean>> = {
  executive: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, !OFF.executive.includes(k)])) as Record<Permission, boolean>,
  analyst: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, !OFF.analyst.includes(k)])) as Record<Permission, boolean>,
  admin: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])) as Record<Permission, boolean>,
}

/** Every permission for a role with overrides applied; administrators hold all. */
export function effective(role: Role, overrides: Partial<Record<string, boolean>> | null | undefined): Record<Permission, boolean> {
  const out = { ...ROLE_DEFAULTS[role] }
  if (role === 'admin') return out
  for (const k of PERMISSION_KEYS) if (typeof overrides?.[k] === 'boolean') out[k] = overrides[k]!
  return out
}

/** The overrides that turn a role's defaults into `values` (what a PATCH stores). */
export function overridesOf(role: Role, values: Record<Permission, boolean>): Partial<Record<Permission, boolean>> {
  const out: Partial<Record<Permission, boolean>> = {}
  for (const k of PERMISSION_KEYS) if (values[k] !== ROLE_DEFAULTS[role][k]) out[k] = values[k]
  return out
}

/** Whether a signed-in user holds a permission: the API's effective values, else the role's defaults (demo sign-in). */
export function can(user: AuthUser, key: Permission): boolean {
  if (user.role === 'admin') return true
  return user.permissions?.[key] ?? ROLE_DEFAULTS[user.role][key]
}
