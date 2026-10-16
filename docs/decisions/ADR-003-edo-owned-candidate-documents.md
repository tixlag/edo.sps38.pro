# ADR-003: EDO owns candidate documents

Accepted: 2026-10-16.

Surveys was a document BFF because its adaptation module already knew candidate
chats and ERP Candidate. That made document availability depend on adaptation.

EDO now owns candidate context, document catalog/forms, grants, upload, draft,
review, SSE and ERP delivery. Public LK calls the generated EDO browser client.
LK PHP exposes only canonical chat identity and employee-to-chat lookup through
the narrow authenticated API. It never proxies document payloads. EDO does not
read LK tables. Chat-server retains its atomic employee-link outbox and worker.

Auth-service remains the only user JWT issuer; EDO verifies HS256/issuer/expiry
locally. Employee self-service derives code1c from the JWT and needs no reviewer
permission. Candidate chat links retain their existing guest-capability model.
Administrative EDO actions retain access rules and location scope. Upload/SSE
capabilities and service credentials remain separate from the login JWT.

Surveys retains the whole adaptation constructor and runtime, including
{{documents}} and DOCUMENTS markers, contact resolution, files, questionnaires,
progress and results. Only the EDO document proxy and its code-generation glue
are removed. Document entry through the chat remains available without surveys;
the adaptation page itself still requires its adaptation backend.

No database migration or document transfer is needed. Old document URLs are
removed; users must reload the page or update the installed app. Roll out LK
identity API, EDO, public_next, then remove the old surveys proxy. Generated
OpenAPI snapshots are the contracts in both repositories.
