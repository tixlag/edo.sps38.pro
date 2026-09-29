/**
 * Typed principal extracted from the unified ecosystem JWT (HS256, lk-auth-service).
 * accessRules is a map: key presence grants the right, value is scoped location ids.
 */
export interface AuthPrincipal {
  uuid: string;
  code1c: string | null;
  sid: string | null;
  deviceId: string | null;
  accessRules: Record<string, string[]>;
  expiresAt: Date | null;
}

export type AccessRulesMap = Record<string, string[]>;
