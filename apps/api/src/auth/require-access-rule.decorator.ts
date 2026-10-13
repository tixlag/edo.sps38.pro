import { SetMetadata } from '@nestjs/common';
import { EdoAccessRule } from './edo-access-rule';

export const REQUIRED_ACCESS_RULES_KEY = 'edo:requiredAccessRules';

/** Requires at least one of the listed EDO access rules (key presence, not truthiness). */
export const RequireAccessRule = (...rules: EdoAccessRule[]) =>
  SetMetadata(REQUIRED_ACCESS_RULES_KEY, rules);
