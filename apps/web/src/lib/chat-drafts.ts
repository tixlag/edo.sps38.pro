import type { ChatAttachmentDto, ChatChannel } from "@edo/api-client";

export interface ChatDraft {
  text: string;
  attachment?: ChatAttachmentDto;
  requestId?: string;
  locked?: boolean;
  operationId?: string;
}
// Sensitive drafts live only in this tab's memory; switching candidates preserves
// their individual drafts. A session change clears the entire map.
const drafts = new Map<string, ChatDraft>();
const resetListeners = new Set<() => void>();
export const chatDraftKey = (
  candidateId: string,
  channel: ChatChannel,
  recipient: string,
) => `${candidateId}:${channel}:${recipient}`;
export function readChatDraft(key: string): ChatDraft {
  return drafts.get(key) ?? { text: "" };
}
export function writeChatDraft(key: string, draft: ChatDraft) {
  drafts.set(key, draft);
}
export function clearChatDrafts() {
  drafts.clear();
  for (const listener of resetListeners) listener();
}
export function subscribeChatDraftReset(listener: () => void) {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}
