import { describe, it, expect } from "vitest";
import {
  extractExpirationDateFromFields,
  computeDaysRemaining,
  getExpirationSeverity,
  matchApplicableThreshold,
  ALERT_THRESHOLDS,
} from "../src/expiration/expiration-dates";

describe("expiration-dates", () => {
  describe("extractExpirationDateFromFields", () => {
    it("extracts expiryDate in YYYY-MM-DD format", () => {
      const date = extractExpirationDateFromFields({ expiryDate: "2026-12-31" });
      expect(date).toEqual(new Date("2026-12-31T00:00:00.000Z"));
    });

    it("extracts stay_until for migration documents", () => {
      const date = extractExpirationDateFromFields({ stay_until: "2026-11-15" });
      expect(date).toEqual(new Date("2026-11-15T00:00:00.000Z"));
    });

    it("extracts pas_date_of_expiry for foreign passports", () => {
      const date = extractExpirationDateFromFields({ pas_date_of_expiry: "2027-05-20" });
      expect(date).toEqual(new Date("2027-05-20T00:00:00.000Z"));
    });

    it("extracts registration_until for foreign registration", () => {
      const date = extractExpirationDateFromFields({ registration_until: "2026-11-20" });
      expect(date).toEqual(new Date("2026-11-20T00:00:00.000Z"));
    });

    it("handles Russian DD.MM.YYYY format and normalizes to Date", () => {
      const date = extractExpirationDateFromFields({ expiryDate: "31.12.2026" });
      expect(date).toEqual(new Date("2026-12-31T00:00:00.000Z"));
    });

    it("returns null when no expiration field is present or valid", () => {
      expect(extractExpirationDateFromFields({})).toBeNull();
      expect(extractExpirationDateFromFields({ issueDate: "2020-01-01" })).toBeNull();
      expect(extractExpirationDateFromFields({ expiryDate: "invalid-date" })).toBeNull();
    });
  });

  describe("computeDaysRemaining", () => {
    it("calculates positive days remaining in Asia/Irkutsk timezone", () => {
      // 2026-11-03 04:00:00 UTC is 2026-11-03 12:00:00 in Irkutsk (+8)
      const now = new Date("2026-11-03T04:00:00.000Z");
      const expiresAt = new Date("2026-11-10T00:00:00.000Z");
      expect(computeDaysRemaining(expiresAt, now)).toBe(7);
    });

    it("calculates 0 days remaining on the day of expiration", () => {
      const now = new Date("2026-11-03T04:00:00.000Z");
      const expiresAt = new Date("2026-11-03T00:00:00.000Z");
      expect(computeDaysRemaining(expiresAt, now)).toBe(0);
    });

    it("calculates negative days remaining for already expired documents", () => {
      const now = new Date("2026-11-03T04:00:00.000Z");
      const expiresAt = new Date("2026-10-31T00:00:00.000Z");
      expect(computeDaysRemaining(expiresAt, now)).toBe(-3);
    });
  });

  describe("getExpirationSeverity", () => {
    it("classifies thresholds into correct severity levels", () => {
      expect(getExpirationSeverity(45)).toBe("NORMAL");
      expect(getExpirationSeverity(30)).toBe("WARNING");
      expect(getExpirationSeverity(20)).toBe("WARNING");
      expect(getExpirationSeverity(15)).toBe("URGENT");
      expect(getExpirationSeverity(10)).toBe("URGENT");
      expect(getExpirationSeverity(7)).toBe("CRITICAL");
      expect(getExpirationSeverity(3)).toBe("CRITICAL");
      expect(getExpirationSeverity(1)).toBe("EMERGENCY");
      expect(getExpirationSeverity(0)).toBe("EMERGENCY");
      expect(getExpirationSeverity(-5)).toBe("EXPIRED");
    });
  });

  describe("matchApplicableThreshold", () => {
    it("matches thresholds [30, 15, 7, 1, 0]", () => {
      expect(ALERT_THRESHOLDS).toEqual([30, 15, 7, 1, 0]);
      expect(matchApplicableThreshold(30)).toBe(30);
      expect(matchApplicableThreshold(25)).toBe(30);
      expect(matchApplicableThreshold(15)).toBe(15);
      expect(matchApplicableThreshold(12)).toBe(15);
      expect(matchApplicableThreshold(7)).toBe(7);
      expect(matchApplicableThreshold(2)).toBe(7);
      expect(matchApplicableThreshold(1)).toBe(1);
      expect(matchApplicableThreshold(0)).toBe(0);
      expect(matchApplicableThreshold(-2)).toBe(0);
      expect(matchApplicableThreshold(40)).toBeNull();
    });
  });
});
