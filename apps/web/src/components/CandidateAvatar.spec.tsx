import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CandidateAvatar } from "./CandidateAvatar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

describe("CandidateAvatar", () => {
  it("renders initials when no candidateId or photoPath is provided", async () => {
    await act(async () => {
      root?.render(<CandidateAvatar fullName="Иванов Иван Иванович" />);
    });

    expect(container?.textContent).toContain("ИИ");
    expect(container?.querySelector("img")).toBeNull();
  });

  it("renders img tag with derived relative URL when candidateId is provided", async () => {
    await act(async () => {
      root?.render(
        <CandidateAvatar candidateId="cand-123" fullName="Петр Сидоров" size="sm" />,
      );
    });

    const img = container?.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("/api/v1/candidates/cand-123/photo?size=thumb");
    expect(img?.getAttribute("alt")).toBe("Фото: Петр Сидоров");
  });

  it("uses full size for lg/xl avatars", async () => {
    await act(async () => {
      root?.render(
        <CandidateAvatar candidateId="cand-123" fullName="Петр Сидоров" size="lg" />,
      );
    });

    const img = container?.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/api/v1/candidates/cand-123/photo?size=full");
  });

  it("uses direct photoPath if it starts with /api/", async () => {
    await act(async () => {
      root?.render(
        <CandidateAvatar
          candidateId="cand-123"
          fullName="Петр Сидоров"
          photoPath="/api/v1/candidates/cand-123/photo?v=1730000000"
        />,
      );
    });

    const img = container?.querySelector("img");
    expect(img?.getAttribute("src")).toBe(
      "/api/v1/candidates/cand-123/photo?v=1730000000",
    );
  });

  it("falls back to initials on img error", async () => {
    await act(async () => {
      root?.render(
        <CandidateAvatar candidateId="cand-123" fullName="Сергей Васильев" />,
      );
    });

    const img = container?.querySelector("img");
    expect(img).not.toBeNull();

    await act(async () => {
      img?.dispatchEvent(new Event("error"));
    });

    expect(container?.querySelector("img")).toBeNull();
    expect(container?.textContent).toContain("СВ");
  });

  it("renders edit button and triggers onUploadClick in editable mode", async () => {
    const onUploadClick = vi.fn();
    await act(async () => {
      root?.render(
        <CandidateAvatar
          candidateId="cand-123"
          fullName="Анна Смирнова"
          editable
          onUploadClick={onUploadClick}
        />,
      );
    });

    const editBtn = container?.querySelector("button[aria-label='Сменить фото кандидата']");
    expect(editBtn).not.toBeNull();

    await act(async () => {
      (editBtn as HTMLButtonElement).click();
    });

    expect(onUploadClick).toHaveBeenCalledTimes(1);
  });
});
