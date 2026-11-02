import { useMemo } from "react";
import type {
  ChatMessageDto,
  CandidateStatusHistoryDto,
  CandidateDocumentSummaryDto,
  DocumentStatus,
} from "@edo/api-client";

export type CandidateFeedFilter = "all" | "messages" | "events";

export interface CandidateFeedMessageItem {
  id: string;
  kind: "message";
  timestamp: string;
  message: ChatMessageDto;
}

export interface CandidateFeedStatusItem {
  id: string;
  kind: "status_change";
  timestamp: string;
  statusName: string;
  statusId: string;
  author: string;
  comment?: string;
}

export interface CandidateFeedDocumentSubmittedItem {
  id: string;
  kind: "document_submitted";
  timestamp: string;
  documentTitle: string;
  version?: number;
}

export interface CandidateFeedDocumentReviewedItem {
  id: string;
  kind: "document_reviewed";
  timestamp: string;
  documentTitle: string;
  status: DocumentStatus;
  reviewedBy?: string | null;
  reason?: string | null;
  comment?: string | null;
}

export interface CandidateFeedDocumentReturnedItem {
  id: string;
  kind: "document_returned";
  timestamp: string;
  documentTitle: string;
  reason?: string | null;
  comment?: string | null;
  version: number;
}

export type CandidateFeedItem =
  | CandidateFeedMessageItem
  | CandidateFeedStatusItem
  | CandidateFeedDocumentSubmittedItem
  | CandidateFeedDocumentReviewedItem
  | CandidateFeedDocumentReturnedItem;

export interface BuildCandidateFeedOptions {
  messages?: ChatMessageDto[] | null;
  history?: CandidateStatusHistoryDto[] | null;
  documents?: CandidateDocumentSummaryDto[] | null;
  filter?: CandidateFeedFilter;
}

export function buildCandidateFeed({
  messages,
  history,
  documents,
  filter = "all",
}: BuildCandidateFeedOptions): CandidateFeedItem[] {
  const items: CandidateFeedItem[] = [];

  if (messages) {
    for (const message of messages) {
      if (!message || !message.id) continue;
      items.push({
        id: `msg-${message.id}`,
        kind: "message",
        timestamp: message.createdAt,
        message,
      });
    }
  }

  if (history) {
    for (const h of history) {
      if (!h || !h.date) continue;
      items.push({
        id: `status-${h.date}-${h.statusId}`,
        kind: "status_change",
        timestamp: h.date,
        statusName: h.statusName,
        statusId: h.statusId,
        author: h.author,
        comment: h.comment || undefined,
      });
    }
  }

  if (documents) {
    for (const doc of documents) {
      if (!doc || !doc.id) continue;
      if (doc.submittedAt) {
        items.push({
          id: `doc-sub-${doc.id}-${doc.submittedAt}`,
          kind: "document_submitted",
          timestamp: doc.submittedAt,
          documentTitle: doc.title,
          version: doc.currentVersion,
        });
      }
      if (doc.reviewedAt) {
        items.push({
          id: `doc-rev-${doc.id}-${doc.reviewedAt}`,
          kind: "document_reviewed",
          timestamp: doc.reviewedAt,
          documentTitle: doc.title,
          status: doc.status,
          reviewedBy: doc.reviewedBy,
        });
      }
      if (doc.returnedVersions) {
        for (const v of doc.returnedVersions) {
          const vObj = v as {
            returnedAt?: string;
            reviewedAt?: string | null;
            reason?: string;
            rejectionReason?: string | null;
            comment?: string | null;
            version: number;
          };
          const ts =
            vObj.returnedAt ??
            vObj.reviewedAt ??
            doc.reviewedAt ??
            doc.submittedAt ??
            "";
          const reason = vObj.reason ?? vObj.rejectionReason ?? "";
          items.push({
            id: `doc-ret-${doc.id}-${v.version}`,
            kind: "document_returned",
            timestamp: ts,
            documentTitle: doc.title,
            reason: reason || undefined,
            comment: vObj.comment ?? undefined,
            version: v.version,
          });
        }
      }
    }
  }

  // Deduplicate by item.id preserving first occurrence
  const map = new Map<string, CandidateFeedItem>();
  for (const item of items) {
    if (!map.has(item.id)) {
      map.set(item.id, item);
    }
  }
  const deduplicated = Array.from(map.values());

  // Sort ascending by timestamp, then by id
  deduplicated.sort((a, b) => {
    const timeA = Date.parse(a.timestamp) || 0;
    const timeB = Date.parse(b.timestamp) || 0;
    if (timeA !== timeB) return timeA - timeB;
    return a.id.localeCompare(b.id);
  });

  if (filter === "messages") {
    return deduplicated.filter((item) => item.kind === "message");
  }
  if (filter === "events") {
    return deduplicated.filter((item) => item.kind !== "message");
  }

  return deduplicated;
}

export interface UseCandidateFeedOptions extends BuildCandidateFeedOptions {}

export interface UseCandidateFeedResult {
  items: CandidateFeedItem[];
  counts: {
    all: number;
    messages: number;
    events: number;
  };
}

export function useCandidateFeed(
  options: UseCandidateFeedOptions,
): UseCandidateFeedResult {
  const { messages, history, documents, filter = "all" } = options;

  return useMemo(() => {
    const all = buildCandidateFeed({
      messages,
      history,
      documents,
      filter: "all",
    });
    const messageCount = all.filter((i) => i.kind === "message").length;
    const eventCount = all.length - messageCount;

    let items = all;
    if (filter === "messages") {
      items = all.filter((i) => i.kind === "message");
    } else if (filter === "events") {
      items = all.filter((i) => i.kind !== "message");
    }

    return {
      items,
      counts: {
        all: all.length,
        messages: messageCount,
        events: eventCount,
      },
    };
  }, [messages, history, documents, filter]);
}
