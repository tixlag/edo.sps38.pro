/**
 * EDO access rules (LK accessRules key range 20000-20099).
 * Presence of the key grants the right; value truthiness MUST NOT be used
 * because `[]` means granted (e.g. `"20001": []`).
 */
export enum EdoAccessRule {
  ACCESS = 20000,
  EMPLOYEE_MANAGE = 20001,
  DOCUMENT_REVIEW = 20002,
  SIGNING = 20003,
  CONFIG_MANAGE = 20004,
  AUDIT_VIEW = 20005,
  INTEGRATIONS_MANAGE = 20006,
  ACCESS_LOCATIONS = 20007,
  ACCESS_ALL_LOCATIONS = 20008,
  FULL_ACCESS = 20009,
}

export const EDO_ACCESS_RULE_IDS = [
  20000, 20001, 20002, 20003, 20004, 20005, 20006, 20007, 20008, 20009,
] as const;

export const EDO_ACCESS_RULE_LABELS: Record<EdoAccessRule, string> = {
  [EdoAccessRule.ACCESS]: 'EDO_ACCESS',
  [EdoAccessRule.EMPLOYEE_MANAGE]: 'EDO_EMPLOYEE_MANAGE',
  [EdoAccessRule.DOCUMENT_REVIEW]: 'EDO_DOCUMENT_REVIEW',
  [EdoAccessRule.SIGNING]: 'EDO_SIGNING',
  [EdoAccessRule.CONFIG_MANAGE]: 'EDO_CONFIG_MANAGE',
  [EdoAccessRule.AUDIT_VIEW]: 'EDO_AUDIT_VIEW',
  [EdoAccessRule.INTEGRATIONS_MANAGE]: 'EDO_INTEGRATIONS_MANAGE',
  [EdoAccessRule.ACCESS_LOCATIONS]: 'EDO_ACCESS_LOCATIONS',
  [EdoAccessRule.ACCESS_ALL_LOCATIONS]: 'EDO_ACCESS_ALL_LOCATIONS',
  [EdoAccessRule.FULL_ACCESS]: 'EDO_FULL_ACCESS',
};
