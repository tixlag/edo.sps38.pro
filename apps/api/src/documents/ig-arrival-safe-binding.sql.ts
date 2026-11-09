import { Prisma } from "@prisma/client";

// Applied at the candidate JOIN so every downstream count and action uses the same gate.
export const safeArrivalCandidate = Prisma.sql`p.factsSeenGeneration IS NOT NULL AND p.factsSeenGeneration <= (SELECT factsFinishedGeneration FROM ig_arrival_sync_state WHERE id='singleton') AND p.igVerified=1 AND p.bindingError IS NULL
 AND p.code1c IS NOT NULL
 AND c.code1c=p.code1c AND c.personUid=p.personUid AND c.chatUuid IS NULL
 AND c.reviewGroup='IG' AND c.erpUid IS NULL AND (c.citizenship IS NULL OR LOWER(c.citizenship)<>'ru')
 AND NOT EXISTS (SELECT 1 FROM ig_arrival_persons other WHERE other.personUid<>p.personUid AND other.code1c=p.code1c)
 AND NOT EXISTS (SELECT 1 FROM ig_arrival_persons owner WHERE owner.personUid<>p.personUid AND owner.candidateId=c.id)`;
