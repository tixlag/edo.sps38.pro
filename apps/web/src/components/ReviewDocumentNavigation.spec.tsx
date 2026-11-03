import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CandidateDocumentSummaryDto } from "@edo/api-client";
import { ReviewDocumentNavigation } from "./ReviewDocumentNavigation";

const state = vi.hoisted(() => ({
  details: vi.fn(),
  refetch: vi.fn(),
  isLoading: false,
  isError: false,
  documents: [] as CandidateDocumentSummaryDto[],
}));
vi.mock("@edo/api-client", () => ({
  useGetCandidateDetails: (...args: unknown[]) => {
    state.details(...args);
    return {
      data: state.isLoading ? undefined : { documents: state.documents },
      isLoading: state.isLoading,
      isError: state.isError,
      refetch: state.refetch,
    };
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function doc(id: string, title: string, status = "IN_REVIEW", version = 1) {
  return {
    id,
    title,
    status,
    currentVersion: version,
  } as CandidateDocumentSummaryDto;
}

let root: Root;
let container: HTMLDivElement;
const onSelect = vi.fn();
function TestNavigation(props: {
  documentId: string;
  busy: boolean;
  liveStatus?: "APPROVED";
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ReviewDocumentNavigation
      candidateId="candidate-1"
      documentId={props.documentId}
      currentTitle="Паспорт"
      currentDocument={
        props.liveStatus
          ? {
              documentId: props.documentId,
              version: 1,
              status: props.liveStatus,
            }
          : undefined
      }
      expanded={expanded}
      onExpandedChange={setExpanded}
      busy={props.busy}
      onSelect={onSelect}
    />
  );
}
async function render(documentId = "b", busy = false, liveStatus?: "APPROVED") {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () =>
    root.render(
      <TestNavigation
        documentId={documentId}
        busy={busy}
        liveStatus={liveStatus}
      />,
    ),
  );
  return container;
}
function toggle() {
  return container.querySelector<HTMLButtonElement>("[aria-expanded]")!;
}
function nextButton() {
  return [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Следующий на проверке"),
  )!;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined as never;
  state.documents = [];
  state.isLoading = false;
  state.isError = false;
  vi.clearAllMocks();
});

describe("ReviewDocumentNavigation", () => {
  it("starts collapsed and expands all documents with statuses in a stable title order", async () => {
    state.documents = [
      doc("c", "СНИЛС", "APPROVED"),
      doc("b", "Паспорт"),
      doc("a", "Анкета", "RETURNED", 3),
    ];
    await render();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Документы сотрудника · 3");
    expect(container.querySelector("ul")).toBeNull();
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const rows = [...container.querySelectorAll("li")];
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Анкета"),
      expect.stringContaining("Паспорт"),
      expect.stringContaining("СНИЛС"),
    ]);
    expect(
      container.querySelector('[aria-current="page"]')?.textContent,
    ).toContain("Паспорт");
    expect(rows[0].textContent).toContain("Версия 3");
    expect(rows[0].textContent).toContain("Документ не принят");
    expect(rows[2].textContent).toContain("Документ принят");
    expect(state.details).toHaveBeenCalledWith("candidate-1");
    await act(async () => rows[0].querySelector("button")!.click());
    expect(onSelect).toHaveBeenCalledWith(state.documents[2]);
  });

  it("wraps to the next pending document, excluding the current document and all other statuses", async () => {
    state.documents = [
      doc("a", "Анкета", "IN_REVIEW", 4),
      doc("b", "Паспорт"),
      doc("c", "СНИЛС", "OCR_PENDING"),
    ];
    await render();
    await act(async () => nextButton().click());
    expect(onSelect).toHaveBeenCalledWith(state.documents[0]);
  });

  it("uses the id as a stable tie breaker for identical titles", async () => {
    state.documents = [
      doc("c", "Документ"),
      doc("b", "Документ"),
      doc("a", "Документ"),
    ];
    await render();
    await act(async () => nextButton().click());
    expect(onSelect).toHaveBeenCalledWith(state.documents[0]);
  });

  it("keeps the list expanded when navigating and updating an approved status", async () => {
    state.documents = [doc("a", "Анкета"), doc("b", "Паспорт")];
    await render();
    await act(async () => toggle().click());
    await render("a", false, "APPROVED");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector('[aria-current="page"]')?.textContent,
    ).toContain("Документ принят");
    expect(container.textContent).toContain("На проверке: 1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not offer a next document when only the current document awaits review", async () => {
    state.documents = [doc("b", "Паспорт"), doc("a", "Анкета", "APPROVED")];
    await render();
    expect(nextButton()).toBeUndefined();
    expect(container.textContent).toContain(
      "Других документов на проверке нет",
    );
  });

  it("disables document selections while an operation is pending", async () => {
    state.documents = [doc("b", "Паспорт"), doc("a", "Анкета")];
    await render("b", true);
    await act(async () => toggle().click());
    expect(nextButton().disabled).toBe(true);
    expect(
      [...container.querySelectorAll("li button")].every(
        (b) => (b as HTMLButtonElement).disabled,
      ),
    ).toBe(true);
  });

  it("shows loading and a retryable error independently of the current document", async () => {
    state.isLoading = true;
    await render();
    expect(container.textContent).toContain("Загрузка списка документов");
    state.isLoading = false;
    state.isError = true;
    await render();
    expect(container.textContent).toContain(
      "Не удалось загрузить список документов",
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent === "Повторить")!
        .click(),
    );
    expect(state.refetch).toHaveBeenCalledOnce();
  });

  it("does not replace a current status with the status of a historical version", async () => {
    state.documents = [doc("b", "Паспорт", "IN_REVIEW", 2)];
    await render("b", false, "APPROVED");
    await act(async () => toggle().click());
    expect(
      container.querySelector('[aria-current="page"]')?.textContent,
    ).toContain("Ожидает проверки");
  });
});
