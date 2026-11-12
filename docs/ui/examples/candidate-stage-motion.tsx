// Synthetic data for ../gifs/candidate-stage-motion.gif; never used by the application.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  setApiBaseUrl,
  type CandidateDocumentSummaryDto,
  type ReviewStageCountsDto,
} from "@edo/api-client";
import { CandidateStageAccordion } from "../../../apps/web/src/components/CandidateStageAccordion";

setApiBaseUrl(location.origin);

const counts = (approved = 0, missing = 0): ReviewStageCountsDto => ({
  approved,
  reused: 0,
  signed: 0,
  inReview: 0,
  uploaded: 0,
  ocrPending: 0,
  ocrFailed: 0,
  returned: 0,
  expired: 0,
  draft: 0,
  missing,
});
const candidateDocument = (
  id: string,
  title: string,
  approved = true,
): CandidateDocumentSummaryDto => ({
  id,
  documentUid: id,
  documentTypeCode: id.toUpperCase(),
  title,
  status: approved ? "APPROVED" : "DRAFT",
  currentVersion: 1,
  deliveryStatus: approved ? "SENT" : null,
  uploadOrigin: "CANDIDATE",
  revision: 1,
  ocrStatus: null,
  ocrErrorCode: null,
  pendingDeliveryVersions: [],
  submittedAt: null,
  reviewedAt: null,
  reviewedBy: null,
});

function Preview() {
  const [openStages, setOpenStages] = useState<Record<number, boolean>>({
    2: true,
  });
  const toggle = (stage: number) =>
    setOpenStages((previous) => ({ ...previous, [stage]: !previous[stage] }));
  const renderStage = (stage: number, title: string, approved: number) => (
    <CandidateStageAccordion
      key={stage}
      stage={stage}
      title={`Этап ${stage}`}
      progress={{
        stage,
        required: { ...counts(approved, 1), draft: approved ? 0 : 1 },
        additional: counts(stage === 7 ? 1 : 0),
        deliveryProblemCount: stage === 7 ? 1 : 0,
      }}
      required={{
        documents: [candidateDocument(`doc-${stage}`, title, approved > 0)],
        missingDocuments: [
          title === "ИНН"
            ? { code: "SNILS", title: "СНИЛС" }
            : { code: "INN", title: "ИНН" },
        ],
      }}
      additional={{
        documents:
          stage === 7
            ? [
                {
                  ...candidateDocument("tachograph", "Карта тахографа"),
                  deliveryStatus: "FAILED",
                },
              ]
            : [],
        missingDocuments: [],
      }}
      previousDocuments={[]}
      candidateId="preview"
      isOpen={!!openStages[stage]}
      onToggle={() => toggle(stage)}
    />
  );

  return (
    <main
      style={{
        width: 352,
        padding: 14,
        background: "var(--background)",
        color: "var(--foreground)",
      }}
    >
      <h1 style={{ fontSize: 16, fontWeight: 600, marginBottom: 2 }}>
        Документы кандидата
      </h1>
      <p
        style={{
          fontSize: 11,
          color: "var(--muted-foreground)",
          marginBottom: 10,
        }}
      >
        Тестовый снимок · узкая панель 320 px
      </p>
      <div style={{ display: "grid", gap: 10 }}>
        {renderStage(1, "Паспорт гражданина РФ", 1)}
        {renderStage(2, "СНИЛС", 1)}
        {renderStage(3, "ИНН", 0)}
        {renderStage(4, "Водительское удостоверение", 1)}
        {renderStage(5, "Медицинская справка", 0)}
        {renderStage(6, "Справка о стаже", 0)}
        {renderStage(7, "Трудовая книжка", 1)}
        {renderStage(8, "Военный билет", 0)}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <Preview />
  </QueryClientProvider>,
);
