import { EdoAccessRule } from './edo-access-rule';
import type { AccessRulesMap, AuthPrincipal } from './auth-principal';

/** Key presence grants the right. NEVER use truthiness: `[]` means granted.
 * FULL_ACCESS (20009) implies every other EDO rule (20000-20008).
 * ACCESS_ALL_LOCATIONS (20008) only widens location scope, never grants actions.
 */
export function hasAccessRule(rules: AccessRulesMap | undefined | null, rule: EdoAccessRule): boolean {
  if (!rules || typeof rules !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(rules, String(rule))) return true;
  if (rule !== EdoAccessRule.FULL_ACCESS) {
    return Object.prototype.hasOwnProperty.call(rules, String(EdoAccessRule.FULL_ACCESS));
  }
  return false;
}

export function hasAnyAccessRule(
  rules: AccessRulesMap | undefined | null,
  ids: EdoAccessRule[],
): boolean {
  return ids.some((id) => hasAccessRule(rules, id));
}

export interface LocationScope {
  all: boolean;
  locationIds: number[];
}

/**
 * Object scope for LK locations:
 * - FULL_ACCESS (20009) -> all
 * - ACCESS_ALL_LOCATIONS (20008) -> all
 * - ACCESS_LOCATIONS (20007) -> listed location ids (string ids from JWT coerced to numbers)
 * - otherwise -> no access
 */
export function resolveLocationScope(principal: AuthPrincipal | null | undefined): LocationScope {
  const rules = principal?.accessRules;
  if (!rules) return { all: false, locationIds: [] };
  if (hasAccessRule(rules, EdoAccessRule.FULL_ACCESS)) return { all: true, locationIds: [] };
  if (hasAccessRule(rules, EdoAccessRule.ACCESS_ALL_LOCATIONS)) {
    return { all: true, locationIds: [] };
  }
  const raw = rules[String(EdoAccessRule.ACCESS_LOCATIONS)];
  if (!Object.prototype.hasOwnProperty.call(rules, String(EdoAccessRule.ACCESS_LOCATIONS))) {
    return { all: false, locationIds: [] };
  }
  const ids = (Array.isArray(raw) ? raw : [])
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
  return { all: false, locationIds: [...new Set(ids)] };
}

export function isLocationAllowed(
  principal: AuthPrincipal | null | undefined,
  locationId: number,
): boolean {
  const scope = resolveLocationScope(principal);
  if (scope.all) return true;
  return scope.locationIds.includes(locationId);
}
