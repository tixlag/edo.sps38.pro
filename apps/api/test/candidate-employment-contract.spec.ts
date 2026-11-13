import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { erpCandidateSchema } from "../src/communications/communication-contract";
import { CommunicationCandidatesQueryDto } from "../src/communications/communications.dto";
import { CandidateReviewQueueQueryDto } from "../src/documents/dto/document.dto";
import {
  buildCandidateProfileWhere,
  buildDefaultExcludedRuStatusWhere,
  buildExcludeEmployedWhere,
} from "../src/documents/candidate-profile";

const row = {
  erpUid: "463b4dfc-5b53-4dbd-a774-9460fae562e3",
  chatUuid: null,
  fullName: "Кандидат",
  projectCode: null,
  projectName: null,
  positionCode: null,
  positionName: null,
  deleted: false,
};

describe("candidate employment contract", () => {
  it("accepts boolean and unknown ERP facts without interpreting status as employment", () => {
    for (const employed of [true, false, null, undefined]) {
      expect(
        erpCandidateSchema.parse({ ...row, employed, statusId: "ПроверкаСБ" })
          .employed,
      ).toBe(employed);
    }
    expect(
      erpCandidateSchema.safeParse({ ...row, employed: "false" }).success,
    ).toBe(false);
  });
  it("keeps default RU status exclusions when employed candidates are included", () => {
    expect(
      buildCandidateProfileWhere({ reviewGroup: "RU", includeEmployed: true }),
    ).toEqual(buildDefaultExcludedRuStatusWhere());
  });
  it("leaves unknown facts visible and does not change IG filtering", () => {
    expect(buildExcludeEmployedWhere()).toEqual({
      OR: [{ employed: false }, { employed: null }],
    });
    expect(buildCandidateProfileWhere({ reviewGroup: "IG" })).toBeUndefined();
    expect(
      buildCandidateProfileWhere({ reviewGroup: "IG", includeEmployed: true }),
    ).toBeUndefined();
  });
  for (const Dto of [
    CommunicationCandidatesQueryDto,
    CandidateReviewQueueQueryDto,
  ]) {
    it(`validates the URL boolean strictly for ${Dto.name}`, async () => {
      for (const [value, expected] of [
        ["true", true],
        ["false", false],
      ] as const) {
        const dto = plainToInstance(Dto, { includeEmployed: value });
        expect(await validate(dto)).toEqual([]);
        expect(dto.includeEmployed).toBe(expected);
      }
      expect(await validate(plainToInstance(Dto, {}))).toEqual([]);
      for (const value of ["yes", "0", "", 1]) {
        expect(
          await validate(plainToInstance(Dto, { includeEmployed: value })),
        ).not.toEqual([]);
      }
    });
  }
});
