# Candidate workspace: EDO acceptance and release notes

Implementation targets the ERP contract in `1c-erp/docs/integrations/edo-candidate-workspace.md`. No production deployment, shared migration or real document delivery is part of this change.

## Confirmed identity and direction

New candidate/person review subjects and documents store nullable `reviewGroup`. New values are assigned from ERP business identity: candidate recipient is RU, independent physical person recipient is IG. Citizenship, chat presence and employee code never determine direction. An existing document's confirmed direction cannot change during upload, profile refresh or linking.

Authenticated context, uploads and owner reads resolve `candidate-communications?action=identity&code1c=<verified JWT code>` before selecting local history. A native ERP physical-person link alone is deliberately insufficient to prove the current admission cycle: identity returns `CURRENT_CANDIDATE_CONFIRMATION_REQUIRED`. The candidate card keeps an explicit person-confirmation action available even when the native link already exists; the manager searches ERP and confirms the signed choice for this cycle. This does not execute HR admission. A current candidate uses its ERP candidate UID; an independent person uses its physical-person UID. `resolveCandidateIdentity` matches ERP UID, verified chat UID or immutable canonical identity and retains the existing EDO ID. Submission idempotency still uses separate `chat:` and `employee:` namespaces. A code may belong to multiple established admission cycles; the exact ERP current relation selects the cycle. Unresolved legacy employee history or conflicting strong references returns 409 instead of a second card or automatic merging.

RU/IG reviewers access all documents of their confirmed direction without location permissions. Unclassified historical documents cannot be approved. Full access can inspect them for diagnosis; independent audit/employee location policy stays intact.

## ERP and browser API

The existing candidate catalog includes empty-document candidates and supports name/status/manager/project filters. Workspace endpoints provide create, patch, full ERP statuses/history, reference choices, explicit person linking and cycle-specific previous-document review. Creation can include a confirmed existing-person choice for a new admission cycle; the manager does not have to locate an earlier candidate card. The authenticated `getCandidateRequirements` endpoint resolves the current ERP position/citizenship and reuses the existing document catalog; browser clients never call the internal S2S catalog with a service secret. Creation/status/link mutations forward stable request UUIDs and verified actor identity to ERP. No mutation retries are automatic. Mentor and integration identities are read-only; a person choice is a short-lived, actor-bound server-signed token, not an arbitrary browser ERP UID.

Card responses show confirmed ERP values and preserve omitted fields on patch. Sparse historical cards permit null position/status so a manager can repair them. Upload context retains the actionable incomplete-position error. Position changes update the projection used by the existing requirements catalog. Prior ERP document sources/originals are retained; new-cycle review is stored separately in `candidate_previous_documents`, initially requiring review. No old decision is overwritten or automatically approved.

New v2 deliveries freeze their business recipient when approval creates the delivery: RU uses trusted `candidateUid` plus its chat UID when available; IG uses `recipientType=person,personUid,code1c`. Both use the existing multipart receiver, immutable artifact hash/size and receipts. Receipt recipient/hash/size/MIME/filename and duplicate status must match; uncertain results require manual reconciliation. Existing v1 deliveries remain unchanged. Keep `ERP_DOCUMENTS_TRANSPORT=multipart-v2` and `ERP_DOCUMENTS_V2_AUTO_RETRY=false` until actual 1C acceptance.

## Migration and historical diagnosis

Apply additive `20261026120000_candidate_business_identity` only after testing the complete feature migration chain on an isolated clone. It adds no bulk classification or merging. With explicit owner approval, unreleased `20261020160000_candidate_communications` now preserves both OCR audit enum values. Applied main migrations were not changed. Upgrade verification applied the exact 17 main migrations, inserted existing OCR retry/request audit rows, then applied both feature migrations (19 total): the rows survived and no schema drift was added relative to main. Disposable acceptance databases created from the previous feature checksum must be recreated; never edit checksums or reset a shared database.

Read-only diagnosis (do not print private personal data into CI logs):

```sql
SELECT c.id, c.reviewGroup, COUNT(d.id) AS unclassifiedDocuments
FROM candidates c
LEFT JOIN documents d ON d.candidateId = c.id AND d.reviewGroup IS NULL
WHERE c.reviewGroup IS NULL OR d.id IS NOT NULL
GROUP BY c.id, c.reviewGroup;

SELECT code1c, COUNT(*) AS unresolvedOwners
FROM candidates
WHERE code1c IS NOT NULL AND erpUid IS NULL AND reviewGroup IS NULL
GROUP BY code1c;
```

For a candidate whose exact ERP UID is already confirmed, an ERP card refresh can classify its still-null documents as RU under audit; already classified documents are never moved. Employee-only legacy rows require point reconciliation against the trusted current ERP relation before further upload. Do not bulk merge/delete or infer direction from citizenship/chat.

## Isolated checks and remaining acceptance

The task's ignored `.cache/candidate-integration/run-isolated.py` overrides root environment credentials with explicit loopback/disabled values. Tests using the dedicated MariaDB instance require an explicit disposable URL and refuse production/shared addresses. No OCR inference, e2e, live LK/ERP requests or shared S3/RabbitMQ operations were used for these checks. The Go chat fixture was started from the LK checkout against a separate schema in the disposable task database; it did not use the running LK stack.

Actual isolated 1C acceptance must still verify platform/metadata compilation, service role permissions, BSP disk volume ER-00000001 and MIME/size support, current-cycle identity before/after HR linking, IG physical-person storage, optional object CRUD, notifications and dispatcher transitions, full person documents/original access, and v2 receipt replay/conflicts/commit-response loss. Browser acceptance must exercise LK public and authenticated upload flows, RU identity continuity, IG isolation and workflow UI. Local mocks and isolated MariaDB checks do not substitute for those platform scenarios.


## Verification evidence (2026-10-26)

| Scope | Executed check | Result |
| --- | --- | --- |
| EDO API business, direction, v2 receipts, unchanged single-file artifacts, PDF composition and OCR lifecycle | 15 targeted Vitest suites | 247 passed, 9 S3-dependent tests skipped |
| Exact RU identity before/after code1c, multiple admission cycles, ambiguous linkage, CRUD, scoped requirements, previous-document review and audit direction | 4 Vitest suites against task-only MariaDB | 41 passed |
| Legacy LK protocol from the EDO adapter | Real Go HTTP/WebSocket handlers, task-only MariaDB and synthetic uploads | 4 passed: history, concurrent windows, text and binary file |
| EDO web | Full Vitest suite, TypeScript/Vite build and lint | 153 tests in 18 suites passed; build and lint passed |
| Schema upgrade | Exact main migrations → two feature migrations, with pre-existing OCR audit rows | 19 migrations applied; OCR rows preserved; no added schema drift relative to main |
| API contract | OpenAPI export and Orval regeneration, API build/lint | Passed |
| EDO CI | Existing external edo.yml template inspected; feature MR has no head pipeline | Build jobs only run for the default branch. CI was not changed, bypassed or disabled; no main build/deploy was triggered |
| ERP | 7 static contract checks, affected metadata XML and targeted BSL analysis | Passed static checks; no platform execution |
| ERP CI | Final pipeline 4039 (after merging develop f4493db3) | `validate:mr` and `scope:erpdev-profi` passed; `review-policy:mr` remains a manual gate |
| LK chat | Core Go tests, independent disconnect under race detector, targeted build/vet, real-handler multi-window fixture | Passed; full `go build ./...` remains blocked by the pre-existing missing broadcasts/usecases package |
| LK rights | PHP syntax and isolated PHPUnit, without application bootstrap/.env | 2 tests, 49 assertions passed |

[Candidate card and person selection screenshots](screenshots/candidate-workspace/README.md) were captured in a local browser preview with synthetic data and no external service calls. RU/IG queues were opened with both review permissions and **zero location permissions**. Desktop (1440px) and mobile (390px) views were inspected. These screenshots demonstrate UI layout, not successful live ERP acceptance.

## Related delivery branches

- EDO: [MR !16](https://glab.sps38.pro/webdevs/edo.sps38.pro/-/merge_requests/16), `feat/candidate-chat-workspace` → `main`.
- ERP: [MR !1349](https://glab.sps38.pro/1cdevs/1c-erp/-/merge_requests/1349), `feature/1C-452367-edo-candidate-integration` → `develop`. It supersedes !1286; the actual supplied task is 1C-452367.
- LK: [PR #2559](https://github.com/websps/lk.sps38.pro/pull/2559), `fix/candidate-chat-multiple-sessions` → `main`, and [PR #2596](https://github.com/websps/lk.sps38.pro/pull/2596), `feat/edo-review-ru-ig` → `main`.

## Before release

1. Complete the 1C platform acceptance described above on an isolated test base. Publish the changed metadata/service roles there and configure the BSP disk volume; do not assume an existing code1c establishes a current candidate cycle. Verify native HR linking and the explicit current-cycle confirmation path, including rejection of historical ambiguity.
2. Exercise both document upload paths with synthetic people: RU chat upload → HR/person confirmation → authenticated LK upload must keep the same EDO Candidate.id and RU history. Independently test IG upload without chat, denied RU access, and physical-person document storage.
3. Verify actual document replay, altered-content conflict and lost response after commit against 1C v2; retain `ERP_DOCUMENTS_V2_AUTO_RETRY=false`. A local mock receipt does not authorize enabling automatic retries.
4. Back up and review the complete EDO migration plan before the separately authorized release. New production work is additive; the approved correction concerns only the unreleased communications migration. Reconcile unresolved historical identities individually, without mass merges, deletions or citizenship-based classification.
5. Verify the existing server-only ERP communications/base URLs, credentials and S2S upload-grant tokens are paired for the test environment. Preserve document upload-grants, existing client upload limits and `ERP_DOCUMENTS_TRANSPORT=multipart-v2`. No new operator chat token/grant is required; LK has no new migrations or runtime settings for these PRs.
6. Finish the manual ERP review gate. The existing EDO template only builds the default branch, so it creates no feature-branch pipeline; local build/test evidence is recorded above. The owner must account for this limitation during acceptance rather than treating an absent pipeline as passed. Merge and deployment are separate owner actions; neither was performed by this task.
