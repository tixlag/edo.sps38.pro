import { describe, expect, it } from 'vitest';
import { EdoAccessRule } from '../src/auth/edo-access-rule';
import {
  hasAccessRule,
  isLocationAllowed,
  resolveLocationScope,
} from '../src/auth/access-rules';

describe('EDO accessRules (key presence, not truthiness)', () => {
  it('treats `"20001": []` as granted', () => {
    expect(hasAccessRule({ '20001': [] }, EdoAccessRule.EMPLOYEE_MANAGE)).toBe(true);
  });

  it('treats a missing key as denied', () => {
    expect(hasAccessRule({}, EdoAccessRule.EMPLOYEE_MANAGE)).toBe(false);
    expect(hasAccessRule({ '20002': [] }, EdoAccessRule.EMPLOYEE_MANAGE)).toBe(false);
  });

  it('uses key presence (hasOwnProperty), not value truthiness or prototype', () => {
    // `[]` is truthy in JS, but the contract is key presence: even a future
    // falsy value (e.g. null/0) must still count as granted, while inherited
    // prototype keys must not.
    expect(hasAccessRule({ '20000': [] }, EdoAccessRule.ACCESS)).toBe(true);
    expect(hasAccessRule({ '20000': null } as never, EdoAccessRule.ACCESS)).toBe(true);
    const inherited = Object.create({ '20000': [] });
    expect(hasAccessRule(inherited, EdoAccessRule.ACCESS)).toBe(false);
  });

  it('20008 grants all locations', () => {
    const scope = resolveLocationScope({
      uuid: 'u',
      code1c: null,
      sid: null,
      deviceId: null,
      accessRules: { '20008': [] },
      expiresAt: null,
    });
    expect(scope.all).toBe(true);
  });

  it('20007 restricts to listed location ids', () => {
    const principal = {
      uuid: 'u',
      code1c: null,
      sid: null,
      deviceId: null,
      accessRules: { '20007': ['98', '148'] },
      expiresAt: null,
    };
    const scope = resolveLocationScope(principal);
    expect(scope.all).toBe(false);
    expect(scope.locationIds.sort((a, b) => a - b)).toEqual([98, 148]);
    expect(isLocationAllowed(principal, 98)).toBe(true);
    expect(isLocationAllowed(principal, 999)).toBe(false);
  });

  it('20009 grants full access (all locations)', () => {
    const principal = {
      uuid: 'u',
      code1c: null,
      sid: null,
      deviceId: null,
      accessRules: { '20009': [] },
      expiresAt: null,
    };
    expect(resolveLocationScope(principal).all).toBe(true);
    expect(isLocationAllowed(principal, 12345)).toBe(true);
  });

  it('20009 implies every EDO action rule 20000-20008', () => {
    const rules = { '20009': [] };
    for (const id of [
      EdoAccessRule.ACCESS,
      EdoAccessRule.EMPLOYEE_MANAGE,
      EdoAccessRule.DOCUMENT_REVIEW,
      EdoAccessRule.SIGNING,
      EdoAccessRule.CONFIG_MANAGE,
      EdoAccessRule.AUDIT_VIEW,
      EdoAccessRule.INTEGRATIONS_MANAGE,
      EdoAccessRule.ACCESS_LOCATIONS,
      EdoAccessRule.ACCESS_ALL_LOCATIONS,
    ]) {
      expect(hasAccessRule(rules, id)).toBe(true);
    }
    expect(hasAccessRule(rules, EdoAccessRule.FULL_ACCESS)).toBe(true);
  });

  it('20008 grants all locations but no action rights', () => {
    const rules = { '20008': [] };
    expect(hasAccessRule(rules, EdoAccessRule.EMPLOYEE_MANAGE)).toBe(false);
    expect(hasAccessRule(rules, EdoAccessRule.DOCUMENT_REVIEW)).toBe(false);
    expect(hasAccessRule(rules, EdoAccessRule.ACCESS)).toBe(false);
    expect(hasAccessRule(rules, EdoAccessRule.ACCESS_ALL_LOCATIONS)).toBe(true);
  });

  it('no scope rights -> denied', () => {
    const principal = {
      uuid: 'u',
      code1c: null,
      sid: null,
      deviceId: null,
      accessRules: { '20000': [] },
      expiresAt: null,
    };
    const scope = resolveLocationScope(principal);
    expect(scope.all).toBe(false);
    expect(scope.locationIds).toEqual([]);
    expect(isLocationAllowed(principal, 98)).toBe(false);
  });
});
