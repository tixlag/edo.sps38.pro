import type { LkCandidateIdentityService } from "./lk-candidate-identity.service";
import type { ErpCandidateClient } from "./erp-candidate.client";

export async function loadCandidateRefresh(
  identity: { chatUuid: string | null; code1c: string | null },
  signal: AbortSignal,
  links: LkCandidateIdentityService,
  erp: ErpCandidateClient,
) {
  if (identity.chatUuid) {
    const link = await links.byUuid(identity.chatUuid, signal);
    const candidateSnapshot = await erp.findByChatUuid(
      identity.chatUuid,
      signal,
    );
    return { chatUuid: link.chatUuid, code1c: link.code1c, candidateSnapshot };
  }
  const code1c = identity.code1c!;
  const candidateSnapshot = await erp.findByEmployeeCode(code1c, signal);
  // The returned UUID is not linked or used to authorize this code-only refresh.
  return { chatUuid: null, code1c, candidateSnapshot };
}
