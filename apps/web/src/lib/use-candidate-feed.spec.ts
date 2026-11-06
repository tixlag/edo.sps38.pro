import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatMessageDto,
  CandidateStatusHistoryDto,
  CandidateDocumentSummaryDto,
} from "@edo/api-client";
import {
  buildCandidateFeed,
  useCandidateFeed,
  type CandidateFeedMessageItem,
  type CandidateFeedStatusItem,
  type CandidateFeedDocumentSubmittedItem,
  type CandidateFeedDocumentReviewedItem,
  type CandidateFeedDocumentReturnedItem,
  type CandidateFeedFilter,
} from "./use-candidate-feed";

describe("buildCandidateFeed", () => {
  const sampleMessages: ChatMessageDto[] = [
    {
      id: "msg-1",
      channel: "lk",
      outgoing: false,
      author: "Кандидат",
      createdAt: "2026-10-20T10:00:00Z",
      text: "Здравствуйте, прикрепил документы",
      attachments: [],
    },
    {
      id: "msg-2",
      channel: "lk",
      outgoing: true,
      author: "HR Менеджер",
      createdAt: "2026-10-20T12:00:00Z",
      text: "Спасибо, передали на верификацию",
      attachments: [],
    },
  ];

  const sampleHistory: CandidateStatusHistoryDto[] = [
    {
      date: "2026-10-19T08:00:00Z",
      author: "Система",
      statusId: "INVITED",
      statusName: "Приглашён",
      comment: "Кандидат зарегистрирован в системе",
    },
    {
      date: "2026-10-20T11:00:00Z",
      author: "HR Менеджер",
      statusId: "ONBOARDING",
      statusName: "Оформление",
      comment: "",
    },
  ];

  const sampleDocuments: CandidateDocumentSummaryDto[] = [
    {
      id: "doc-passport",
      title: "Паспорт РФ",
      status: "APPROVED",
      currentVersion: 2,
      revision: 2,
      submittedAt: "2026-10-20T09:00:00Z",
      reviewedAt: "2026-10-20T13:00:00Z",
      reviewedBy: "Верификатор 1",
      documentTypeCode: "passport_ru",
      documentUid: null,
      deliveryStatus: null,
      ocrStatus: null,
      ocrErrorCode: null,
      pendingDeliveryVersions: [],
      returnedVersions: [
        {
          version: 1,
          submittedAt: "2026-10-19T09:00:00Z",
          reviewedAt: "2026-10-19T15:00:00Z",
          reviewedBy: "Верификатор 2",
          rejectionReason: "Нечеткое фото главной страницы",
          supersededByVersion: 2,
        },
      ],
    },
  ];

  it("merges messages, status changes, and documents chronologically", () => {
    const feed = buildCandidateFeed({
      messages: sampleMessages,
      history: sampleHistory,
      documents: sampleDocuments,
    });

    expect(feed.map((f) => f.id)).toEqual([
      "status-2026-10-19T08:00:00Z-INVITED",
      "doc-ret-doc-passport-1",
      "doc-sub-doc-passport-2026-10-20T09:00:00Z",
      "msg-msg-1",
      "status-2026-10-20T11:00:00Z-ONBOARDING",
      "msg-msg-2",
      "doc-rev-doc-passport-2026-10-20T13:00:00Z",
    ]);

    const statusItem = feed[0] as CandidateFeedStatusItem;
    expect(statusItem.kind).toBe("status_change");
    expect(statusItem.statusName).toBe("Приглашён");
    expect(statusItem.author).toBe("Система");
    expect(statusItem.comment).toBe("Кандидат зарегистрирован в системе");

    const retItem = feed[1] as CandidateFeedDocumentReturnedItem;
    expect(retItem.kind).toBe("document_returned");
    expect(retItem.documentTitle).toBe("Паспорт РФ");
    expect(retItem.version).toBe(1);
    expect(retItem.reason).toBe("Нечеткое фото главной страницы");

    const subItem = feed[2] as CandidateFeedDocumentSubmittedItem;
    expect(subItem.kind).toBe("document_submitted");
    expect(subItem.documentTitle).toBe("Паспорт РФ");
    expect(subItem.version).toBe(2);

    const msgItem = feed[3] as CandidateFeedMessageItem;
    expect(msgItem.kind).toBe("message");
    expect(msgItem.message.text).toBe("Здравствуйте, прикрепил документы");

    const revItem = feed[6] as CandidateFeedDocumentReviewedItem;
    expect(revItem.kind).toBe("document_reviewed");
    expect(revItem.documentTitle).toBe("Паспорт РФ");
    expect(revItem.status).toBe("APPROVED");
    expect(revItem.reviewedBy).toBe("Верификатор 1");
  });

  it("filters feed by 'messages' only", () => {
    const feed = buildCandidateFeed({
      messages: sampleMessages,
      history: sampleHistory,
      documents: sampleDocuments,
      filter: "messages",
    });

    expect(feed).toHaveLength(2);
    expect(feed.every((f) => f.kind === "message")).toBe(true);
  });

  it("filters feed by 'events' only", () => {
    const feed = buildCandidateFeed({
      messages: sampleMessages,
      history: sampleHistory,
      documents: sampleDocuments,
      filter: "events",
    });

    expect(feed).toHaveLength(5);
    expect(feed.every((f) => f.kind !== "message")).toBe(true);
  });

  it("deduplicates items with identical IDs", () => {
    const feed = buildCandidateFeed({
      messages: [...sampleMessages, sampleMessages[0]],
      history: [...sampleHistory, sampleHistory[0]],
    });

    const msg1Count = feed.filter((f) => f.id === "msg-msg-1").length;
    expect(msg1Count).toBe(1);

    const status1Count = feed.filter(
      (f) => f.id === "status-2026-10-19T08:00:00Z-INVITED",
    ).length;
    expect(status1Count).toBe(1);
  });

  it("handles null or undefined collections gracefully", () => {
    const feed = buildCandidateFeed({});
    expect(feed).toEqual([]);
  });
});

describe("useCandidateFeed hook", () => {
  let root: Root, host: HTMLDivElement;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("computes counts and respects filter prop", async () => {
    let currentFeed: ReturnType<typeof useCandidateFeed> | undefined;

    function TestHarness({ filter }: { filter: CandidateFeedFilter }) {
      currentFeed = useCandidateFeed({
        messages: [
          {
            id: "1",
            channel: "lk",
            outgoing: false,
            author: "Кандидат",
            createdAt: "2026-10-20T10:00:00Z",
            text: "Тест",
            attachments: [],
          },
        ],
        history: [
          {
            date: "2026-10-20T11:00:00Z",
            author: "Система",
            statusId: "INVITED",
            statusName: "Приглашён",
            comment: "",
          },
        ],
        filter,
      });
      return createElement("div", { "data-count": currentFeed.items.length });
    }

    await act(async () => {
      root.render(createElement(TestHarness, { filter: "all" }));
    });

    expect(currentFeed?.counts).toEqual({
      all: 2,
      messages: 1,
      events: 1,
    });
    expect(currentFeed?.items).toHaveLength(2);

    await act(async () => {
      root.render(createElement(TestHarness, { filter: "messages" }));
    });
    expect(currentFeed?.items).toHaveLength(1);
    expect(currentFeed?.items[0].kind).toBe("message");
    expect(currentFeed?.counts.all).toBe(2);

    await act(async () => {
      root.render(createElement(TestHarness, { filter: "events" }));
    });
    expect(currentFeed?.items).toHaveLength(1);
    expect(currentFeed?.items[0].kind).toBe("status_change");
    expect(currentFeed?.counts.all).toBe(2);
  });
});
