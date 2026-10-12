import { NO_ACCESS, type AuthUser, type Role } from './roles'

/**
 * Per-user permissions, mirroring the API's catalog (services/api/app/permissions.py). A role is a
 * preset of defaults; a user's `permissions` (from /auth/me) are the effective values after the
 * administrator's overrides. The API enforces the same keys; these only decide what the views show.
 */
export type Permission =
  | 'view.company' | 'view.company-story' | 'view.analytics' | 'view.reporting'
  | 'tab.sites' | 'tab.pallet' | 'tab.over-target' | 'tab.overtime' | 'tab.income-statement' | 'tab.subcontracted' | 'tab.map' | 'tab.vendors' | 'tab.feedback' | 'tab.budget'
  | 'data.allocations' | 'data.month' | 'data.staffing' | 'data.invoices' | 'data.photos' | 'data.export' | 'data.qa'

export interface PermissionInfo { key: Permission; group: string; label: string }

export const PERMISSIONS: readonly PermissionInfo[] = [
  { key: 'view.company', group: 'Views', label: 'Company' },
  { key: 'view.company-story', group: 'Views', label: 'Company at a glance' },
  { key: 'view.analytics', group: 'Views', label: 'Portfolio' },
  { key: 'view.reporting', group: 'Views', label: 'Reporting and forecasts' },
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

const OFF: Record<Role, readonly Permission[]> = { executive: ['view.company-story', 'view.analytics', 'view.reporting', 'data.staffing'], analyst: ['view.company-story', 'view.analytics'], admin: [] }
export const ROLE_DEFAULTS: Record<Role, Record<Permission, boolean>> = {
  executive: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, !OFF.executive.includes(k)])) as Record<Permission, boolean>,
  analyst: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, !OFF.analyst.includes(k)])) as Record<Permission, boolean>,
  admin: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])) as Record<Permission, boolean>,
}

/** A role's permission set as the API lists it (Admin > Users > Roles), keyed by role slug. */
export type RoleDefaults = Record<string, Record<Permission, boolean>>
const NONE_SET = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false])) as Record<Permission, boolean>

/** A role's permissions: from `roles` (the API's list) when given, else the built-in defaults; an unknown
 * role (and No access) holds nothing. */
export function roleDefaults(role: string, roles?: RoleDefaults): Record<Permission, boolean> {
  return roles?.[role] ?? (ROLE_DEFAULTS as RoleDefaults)[role] ?? NONE_SET
}

/** Every permission for a role with overrides applied; administrators hold all, No access holds none. */
export function effective(role: string, overrides: Partial<Record<string, boolean>> | null | undefined, roles?: RoleDefaults): Record<Permission, boolean> {
  if (role === 'admin') return { ...ROLE_DEFAULTS.admin }
  if (role === NO_ACCESS) return { ...NONE_SET }
  const out = { ...roleDefaults(role, roles) }
  for (const k of PERMISSION_KEYS) if (typeof overrides?.[k] === 'boolean') out[k] = overrides[k]!
  return out
}

/** The overrides that turn a role's permissions into `values` (what a PATCH stores). */
export function overridesOf(role: string, values: Record<Permission, boolean>, roles?: RoleDefaults): Partial<Record<Permission, boolean>> {
  const base = roleDefaults(role, roles)
  const out: Partial<Record<Permission, boolean>> = {}
  for (const k of PERMISSION_KEYS) if (values[k] !== base[k]) out[k] = values[k]
  return out
}

/** Whether a signed-in user holds a permission: the API's effective values, else the built-in role's defaults (demo sign-in). */
export function can(user: AuthUser, key: Permission): boolean {
  if (user.role === 'admin') return true
  if (user.role === NO_ACCESS) return false
  return user.permissions?.[key] ?? roleDefaults(user.role)[key]
}
