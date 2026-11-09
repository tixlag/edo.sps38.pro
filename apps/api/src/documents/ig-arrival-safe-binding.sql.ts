import { Prisma } from "@prisma/client";

// Applied at the candidate JOIN so every downstream count and action uses the same gate.
export const safeArrivalCandidate = Prisma.sql`p.factsSeenGeneration IS NOT NULL AND p.factsSeenGeneration <= (SELECT factsFinishedGeneration FROM ig_arrival_sync_state WHERE id='singleton') AND p.igVerified=1 AND p.bindingError IS NULL
 AND p.state<>'CONFLICT' AND p.code1c IS NOT NULL
 AND c.code1c=p.code1c AND c.personUid=p.personUid AND c.chatUuid IS NULL
 AND c.reviewGroup='IG' AND (c.citizenship IS NULL OR LOWER(c.citizenship)<>'ru')
 AND m.sourceKey IS NOT NULL AND m.sourceMemberUid IS NOT NULL
 AND m.arrivalMemberUid=m.sourceMemberUid AND m.factsIdentityIssue IS NULL
 AND NOT EXISTS (SELECT 1 FROM ig_arrival_persons other WHERE other.personUid<>p.personUid AND other.code1c=p.code1c)
 AND NOT EXISTS (SELECT 1 FROM ig_arrival_issues issue WHERE issue.personHash=SHA2(p.personUid,256) AND issue.active=1)
 AND (SELECT COUNT(*) FROM ig_arrival_members activeMember WHERE activeMember.personUid=p.personUid AND activeMember.cancelled=0 AND activeMember.factsArchived=0)<=1`;
