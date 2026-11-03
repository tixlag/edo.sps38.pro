import { classifyRule, excludedForSex } from "./document-contract";
import { needsNewIgDocument } from "./reemployment-document-policy";

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
  pending: number;
  processing: number;
  missing: number;
  attention: number;
};
export type StageProgress = {
  stage: number | null;
  required: Counts;
  additional: Counts;
};
const empty = (): Counts => ({
  approved: 0,
  pending: 0,
  processing: 0,
  missing: 0,
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
  if (
    profile.citizenship.toLowerCase() !== "ru" &&
    needsNewIgDocument(type.erpUid ?? null) &&
    rule === (type.stageRules?.length ? type.stageRules[0] : type)
  )
    return "required";
  const category = classifyRule(
    rule,
    profile.positionCode,
    profile.citizenship,
    profile.projectCode,
  );
  return category;
}

export function reviewStageProgress(
  types: Type[],
  documents: { documentTypeId: string | null; status: string }[],
  profile: Profile,
  previousUids: string[] = [],
): StageProgress[] {
  const states = new Map(documents.map((d) => [d.documentTypeId, d.status]));
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
        entry = { stage, required: empty(), additional: empty() };
        stages.set(stage, entry);
      }
      const count = category === "required" ? entry.required : entry.additional;
      const status =
        states.get(type.id) ??
        (type.erpUid &&
        !needsNewIgDocument(type.erpUid) &&
        reused.has(type.erpUid.toLowerCase())
          ? "APPROVED"
          : undefined);
      if (!status || status === "DRAFT") count.missing++;
      else if (status === "APPROVED" || status === "SIGNED") count.approved++;
      else if (status === "IN_REVIEW") count.pending++;
      else if (status === "OCR_PENDING" || status === "UPLOADED")
        count.processing++;
      else count.attention++;
    }
  }
  return [...stages.values()].sort(
    (a, b) => (a.stage ?? Infinity) - (b.stage ?? Infinity),
  );
}
