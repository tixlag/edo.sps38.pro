import type {
  CandidateDetailsDto,
  CandidateStageItemDto,
} from "@edo/api-client";

export interface AssembleCandidateStagesOptions {
  stage?: string;
  returnedHistory?: boolean;
}

/**
 * Normalizes stage representation from `CandidateDetailsDto` into an array of `CandidateStageItemDto`.
 * Priority:
 * 1. `data.stages` if provided by backend (already pre-calculated with rules and categories).
 * 2. `data.stageDocuments` if query was filtered by a single stage.
 * 3. `data.documentGroups` if candidate has general required/additional groups.
 * 4. Raw `data.documents` and `data.missingDocuments`.
 *
 * If `returnedHistory` is true, keeps only documents with returned versions and clears missing/previous.
 */
export function assembleCandidateStages(
  data?: CandidateDetailsDto | null,
  options?: AssembleCandidateStagesOptions,
): CandidateStageItemDto[] {
  if (!data) return [];

  let result: CandidateStageItemDto[] = [];

  if (data.stages && data.stages.length > 0) {
    result = data.stages.map((stg) => ({
      stage: stg.stage,
      title: stg.title || (stg.stage === null ? "Без этапа" : `Этап ${stg.stage}`),
      required: {
        documents: stg.required?.documents ?? [],
        missingDocuments: stg.required?.missingDocuments ?? [],
      },
      additional: {
        documents: stg.additional?.documents ?? [],
        missingDocuments: stg.additional?.missingDocuments ?? [],
      },
      previousDocuments: stg.previousDocuments ?? [],
    }));
  } else if (data.stageDocuments) {
    const stageProp = options?.stage;
    const stgNum =
      stageProp === "none"
        ? null
        : stageProp !== undefined && stageProp !== ""
          ? Number(stageProp) || null
          : 1;
    const stgTitle =
      stageProp === "none"
        ? "Без этапа"
        : stageProp
          ? `Этап ${stageProp}`
          : "Этап 1";

    result = [
      {
        stage: stgNum,
        title: stgTitle,
        required: {
          documents: data.stageDocuments.required?.documents ?? [],
          missingDocuments: data.stageDocuments.required?.missingDocuments ?? [],
        },
        additional: {
          documents: data.stageDocuments.additional?.documents ?? [],
          missingDocuments:
            data.stageDocuments.additional?.missingDocuments ?? [],
        },
        previousDocuments: data.previousDocuments ?? [],
      },
    ];
  } else if (data.documentGroups) {
    result = [
      {
        stage: 1,
        title: "Этап 1",
        required: {
          documents: data.documentGroups.required?.documents ?? [],
          missingDocuments: data.documentGroups.required?.missingDocuments ?? [],
        },
        additional: {
          documents: data.documentGroups.additional?.documents ?? [],
          missingDocuments:
            data.documentGroups.additional?.missingDocuments ?? [],
        },
        previousDocuments: data.previousDocuments ?? [],
      },
    ];
  } else if (
    (data.documents && data.documents.length > 0) ||
    (data.missingDocuments && data.missingDocuments.length > 0)
  ) {
    result = [
      {
        stage: 1,
        title: "Этап 1",
        required: {
          documents: data.documents ?? [],
          missingDocuments: data.missingDocuments ?? [],
        },
        additional: {
          documents: [],
          missingDocuments: [],
        },
        previousDocuments: data.previousDocuments ?? [],
      },
    ];
  } else if (
    data.candidate?.stageProgress &&
    data.candidate.stageProgress.length > 0
  ) {
    result = data.candidate.stageProgress.map((p) => ({
      stage: p.stage,
      title: p.stage === null ? "Без этапа" : `Этап ${p.stage}`,
      required: { documents: [], missingDocuments: [] },
      additional: { documents: [], missingDocuments: [] },
      previousDocuments: [],
    }));
  }

  if (options?.returnedHistory) {
    return result.map((s) => ({
      ...s,
      required: {
        documents: s.required.documents.filter(
          (d) => (d.returnedVersions?.length ?? 0) > 0,
        ),
        missingDocuments: [],
      },
      additional: {
        documents: s.additional.documents.filter(
          (d) => (d.returnedVersions?.length ?? 0) > 0,
        ),
        missingDocuments: [],
      },
      previousDocuments: [],
    }));
  }

  return result;
}
