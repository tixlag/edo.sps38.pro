import { expect, it } from "vitest";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CandidateEnrichmentBatchRequestDto } from "../src/documents/dto/candidate-enrichment.dto";
it("bounds visible-page enrichment to 100 string candidate IDs", async () => {
  expect(await validate(plainToInstance(CandidateEnrichmentBatchRequestDto, { candidateIds: ["candidate"] }))).toHaveLength(0);
  for (const candidateIds of [[], Array(101).fill("candidate"), [42], ["x".repeat(65)]]) {
    expect(await validate(plainToInstance(CandidateEnrichmentBatchRequestDto, { candidateIds }))).not.toHaveLength(0);
  }
});
