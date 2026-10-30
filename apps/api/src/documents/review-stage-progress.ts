import { excludedForSex } from "./document-contract";

type Type = {
  id: string;
  code: string;
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
    positions: { code1c: string }[];
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
  return stage !== null &&
    (rule.requiredForAll ||
      (profile.citizenship.toLowerCase() === "ru"
        ? rule.allRu
        : rule.allForeign) ||
      rule.positions.some((p) => p.code1c === profile.positionCode))
    ? "required"
    : "additional";
}

export function reviewStageProgress(
  types: Type[],
  documents: { documentTypeId: string | null; status: string }[],
  profile: { positionCode: string; citizenship: string; sex: string | null },
): StageProgress[] {
  const states = new Map(documents.map((d) => [d.documentTypeId, d.status]));
  const stages = new Map<number | null, StageProgress>();
  for (const type of types) {
    if (excludedForSex(type.code, profile.sex)) continue;
    for (const rule of type.stageRules?.length ? type.stageRules : [type]) {
      const stage = rule.stage ?? null;
      let entry = stages.get(stage);
      if (!entry) {
        entry = { stage, required: empty(), additional: empty() };
        stages.set(stage, entry);
      }
      const category = classifyStageType(type, stage, profile);
      const count = category === "required" ? entry.required : entry.additional;
      const status = states.get(type.id);
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
