import { classifyRule, excludedForSex } from "./document-contract";
import {
  isPatentExempt,
  needsNewIgDocument,
} from "./reemployment-document-policy";

type Type = {
  id: string;
  code: string;
  erpUid?: string | null;
  stage: number | null;
  requiredForAll: boolean;
  allRu: boolean;
  allForeign: boolean;
  positions: { code1c: string }[];
  stageRules?: {
    stage: number | null;
    requiredForAll: boolean;
    allRu: boolean;
    allForeign: boolean;
    positions: { code1c: string; required?: boolean }[];
    projects?: { code1c: string }[];
    countries?: { code: string }[];
  }[];
};
type Counts = {
  approved: number;
  reused: number;
  signed: number;
  inReview: number;
  uploaded: number;
  ocrPending: number;
  ocrFailed: number;
  returned: number;
  expired: number;
  draft: number;
  missing: number;
  pending: number;
  processing: number;
  attention: number;
};
export type StageProgress = {
  deliveryProblemCount: number;
  stage: number | null;
  required: Counts;
  additional: Counts;
};
const empty = (): Counts => ({
  approved: 0,
  reused: 0,
  signed: 0,
  inReview: 0,
  uploaded: 0,
  ocrPending: 0,
  ocrFailed: 0,
  returned: 0,
  expired: 0,
  draft: 0,
  missing: 0,
  pending: 0,
  processing: 0,
  attention: 0,
});

type Profile = {
  positionCode: string;
  citizenship: string;
  projectCode?: string | null;
  sex: string | null;
};
export function classifyStageType(
  type: Type,
  stage: number | null,
  profile: Profile,
): "required" | "additional" | null {
  if (excludedForSex(type.code, profile.sex)) return null;
  const rule = (type.stageRules?.length ? type.stageRules : [type]).find(
    (item) => (item.stage ?? null) === stage,
  );
  if (!rule) return null;
  const category = classifyRule(
    rule,
    profile.positionCode,
    profile.citizenship,
    profile.projectCode,
  );
  return category === "required" &&
    isPatentExempt(type.erpUid, profile.citizenship)
    ? "additional"
    : category;
}

export function reviewStageProgress(
  types: Type[],
  documents: { documentTypeId: string | null; status: string }[],
  profile: Profile,
  previousUids: string[] = [],
  isIg = true,
  deliveryProblemTypeIds: readonly string[] = [],
): StageProgress[] {
  const deliveryProblems = new Set(deliveryProblemTypeIds);
  const nonDraftStates = new Map(
    documents
      .filter((d) => d.status !== "DRAFT")
      .map((d) => [d.documentTypeId, d.status]),
  );
  const allStates = new Map(documents.map((d) => [d.documentTypeId, d.status]));
  const reused = new Set(previousUids.map((uid) => uid.toLowerCase()));
  const stages = new Map<number | null, StageProgress>();
  for (const type of types) {
    if (excludedForSex(type.code, profile.sex)) continue;
    for (const rule of type.stageRules?.length ? type.stageRules : [type]) {
      const stage = rule.stage ?? null;
      const category = classifyStageType(type, stage, profile);
      if (!category) continue;
      let entry = stages.get(stage);
      if (!entry) {
        entry = {
          stage,
          required: empty(),
          additional: empty(),
          deliveryProblemCount: 0,
        };
        stages.set(stage, entry);
      }
      if (deliveryProblems.has(type.id)) entry.deliveryProblemCount++;
      const count = category === "required" ? entry.required : entry.additional;
      const activeStatus = nonDraftStates.get(type.id);
      const isReused =
        !activeStatus &&
        Boolean(
          type.erpUid &&
          (!isIg || !needsNewIgDocument(type.erpUid)) &&
          reused.has(type.erpUid.toLowerCase()),
        );

      if (isReused) {
        count.reused++;
      } else if (activeStatus === "APPROVED") {
        count.approved++;
      } else if (activeStatus === "SIGNED") {
        count.signed++;
      } else if (activeStatus === "IN_REVIEW") {
        count.inReview++;
      } else if (activeStatus === "UPLOADED") {
        count.uploaded++;
      } else if (activeStatus === "OCR_PENDING") {
        count.ocrPending++;
      } else if (activeStatus === "OCR_FAILED") {
        count.ocrFailed++;
      } else if (activeStatus === "RETURNED") {
        count.returned++;
      } else if (activeStatus === "EXPIRED") {
        count.expired++;
      } else if (allStates.get(type.id) === "DRAFT") {
        count.draft++;
      } else {
        count.missing++;
      }

      count.pending = count.inReview;
      count.processing = count.uploaded + count.ocrPending;
      count.attention = count.returned + count.ocrFailed + count.expired;
    }
  }
  return [...stages.values()].sort(
    (a, b) => (a.stage ?? Infinity) - (b.stage ?? Infinity),
  );
}
