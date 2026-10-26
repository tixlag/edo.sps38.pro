# Candidate workspace: EDO acceptance and release notes

Implementation targets the ERP contract in `1c-erp/docs/integrations/edo-candidate-workspace.md`. No production deployment, shared migration or real document delivery is part of this change.

## Confirmed identity and direction

New candidate/person review subjects and documents store nullable `reviewGroup`. New values are assigned from ERP business identity: candidate recipient is RU, independent physical person recipient is IG. Citizenship, chat presence and employee code never determine direction. An existing document's confirmed direction cannot change during upload, profile refresh or linking.

Authenticated context, uploads and owner reads resolve `candidate-communications?action=identity&code1c=<verified JWT code>` before selecting local history. A current candidate uses its ERP candidate UID; an independent person uses its physical-person UID. `resolveCandidateIdentity` matches ERP UID, verified chat UID or immutable canonical identity and retains the existing EDO ID. Submission idempotency still uses separate `chat:` and `employee:` namespaces. A code may belong to multiple established admission cycles; the exact ERP current relation selects the cycle. Unresolved legacy employee history or conflicting strong references returns 409 instead of a second card or automatic merging.

RU/IG reviewers access all documents of their confirmed direction without location permissions. Unclassified historical documents cannot be approved. Full access can inspect them for diagnosis; independent audit/employee location policy stays intact.

## ERP and browser API

The existing candidate catalog includes empty-document candidates and supports name/status/manager/project filters. Workspace endpoints provide create, patch, full ERP statuses/history, reference choices, explicit person linking and cycle-specific previous-document review. The authenticated `getCandidateRequirements` endpoint resolves the current ERP position/citizenship and reuses the existing document catalog; browser clients never call the internal S2S catalog with a service secret. Creation/status/link mutations forward stable request UUIDs and verified actor identity to ERP. No mutation retries are automatic. Mentor and integration identities are read-only; a person choice is a short-lived, actor-bound server-signed token, not an arbitrary browser ERP UID.

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

The task's ignored `.cache/candidate-integration/run-isolated.py` overrides root environment credentials with explicit loopback/disabled values. Tests using the dedicated MariaDB instance require an explicit disposable URL and refuse production/shared addresses. No OCR inference, e2e, real LK/ERP requests or shared S3/RabbitMQ operations are needed for these checks.

Actual isolated 1C acceptance must still verify platform/metadata compilation, service role permissions, BSP disk volume ER-00000001 and MIME/size support, current-cycle identity before/after HR linking, IG physical-person storage, optional object CRUD, notifications and dispatcher transitions, full person documents/original access, and v2 receipt replay/conflicts/commit-response loss. Browser acceptance must exercise LK public and authenticated upload flows, RU identity continuity, IG isolation and workflow UI. Local mocks and isolated MariaDB checks do not substitute for those platform scenarios.
