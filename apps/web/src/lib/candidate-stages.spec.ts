import { describe, expect, it } from "vitest";
import { assembleCandidateStages } from "./candidate-stages";
import type { CandidateDetailsDto } from "@edo/api-client";

describe("assembleCandidateStages", () => {
  it("returns empty array for null/undefined input", () => {
    expect(assembleCandidateStages(null)).toEqual([]);
    expect(assembleCandidateStages(undefined)).toEqual([]);
  });

  it("prioritizes data.stages when provided", () => {
    const data = {
      candidate: {
        id: "c1",
        fullName: "Test",
        approvedDocuments: 1,
        requiredDocuments: 2,
      },
      documents: [],
      stages: [
        {
          stage: 1,
          title: "Этап 1",
          required: {
            documents: [
              {
                id: "d1",
                documentUid: "u1",
                documentTypeCode: "PASSPORT",
                deliveryStatus: "NONE",
                title: "Паспорт",
                status: "APPROVED",
                currentVersion: 1,
                revision: 1,
                ocrStatus: null,
                ocrErrorCode: null,
                pendingDeliveryVersions: [],
                submittedAt: null,
                reviewedAt: null,
                reviewedBy: null,
              },
            ],
            missingDocuments: [],
          },
          additional: { documents: [], missingDocuments: [] },
          previousDocuments: [],
        },
      ],
    } as unknown as CandidateDetailsDto;

    const stages = assembleCandidateStages(data);
    expect(stages).toHaveLength(1);
    expect(stages[0].stage).toBe(1);
    expect(stages[0].title).toBe("Этап 1");
    expect(stages[0].required.documents).toHaveLength(1);
  });

  it("assembles from stageDocuments when stages is not provided", () => {
    const data = {
      candidate: {
        id: "c1",
        fullName: "Test",
        approvedDocuments: 0,
        requiredDocuments: 1,
      },
      documents: [],
      stageDocuments: {
        required: {
          documents: [],
          missingDocuments: [{ code: "PASSPORT", title: "Паспорт" }],
        },
        additional: { documents: [], missingDocuments: [] },
      },
    } as unknown as CandidateDetailsDto;

    const stages = assembleCandidateStages(data, { stage: "2" });
    expect(stages).toHaveLength(1);
    expect(stages[0].stage).toBe(2);
    expect(stages[0].title).toBe("Этап 2");
    expect(stages[0].required.missingDocuments).toHaveLength(1);
  });

  it("filters returned versions when returnedHistory is true", () => {
    const data = {
      candidate: {
        id: "c1",
        fullName: "Test",
        approvedDocuments: 0,
        requiredDocuments: 1,
      },
      documents: [],
      stages: [
        {
          stage: 1,
          title: "Этап 1",
          required: {
            documents: [
              {
                id: "d1",
                documentUid: "u1",
                documentTypeCode: "PASSPORT",
                deliveryStatus: "NONE",
                title: "Паспорт",
                status: "RETURNED",
                currentVersion: 1,
                revision: 1,
                ocrStatus: null,
                ocrErrorCode: null,
                pendingDeliveryVersions: [],
                submittedAt: null,
                reviewedAt: null,
                reviewedBy: null,
                returnedVersions: [{ version: 1, rejectionReason: "Нечеткое фото" }],
              },
              {
                id: "d2",
                documentUid: "u2",
                documentTypeCode: "INN",
                deliveryStatus: "NONE",
                title: "ИНН",
                status: "APPROVED",
                currentVersion: 1,
                revision: 1,
                ocrStatus: null,
                ocrErrorCode: null,
                pendingDeliveryVersions: [],
                submittedAt: null,
                reviewedAt: null,
                reviewedBy: null,
              },
            ],
            missingDocuments: [{ code: "SNILS", title: "СНИЛС" }],
          },
          additional: { documents: [], missingDocuments: [] },
          previousDocuments: [],
        },
      ],
    } as unknown as CandidateDetailsDto;

    const stages = assembleCandidateStages(data, { returnedHistory: true });
    expect(stages).toHaveLength(1);
    expect(stages[0].required.documents).toHaveLength(1);
    expect(stages[0].required.documents[0].title).toBe("Паспорт");
    expect(stages[0].required.missingDocuments).toHaveLength(0);
  });
});
