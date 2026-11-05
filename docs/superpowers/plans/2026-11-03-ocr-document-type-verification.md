# OCR Document Type Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement automated document type verification for 29 document types (and future additions) by extending the OCR service (`POST /document-check`) with a two-stage pipeline (SigLIP 2 presence check -> PaddleOCR keyword rule matcher -> GLM-4V VLM fallback) and integrating it into EDO API lifecycle with a 3-attempt limit before passing to manual review.

**Architecture:**
1. `ocr/` service (port 8000) receives `files` and `expected_code`.
2. Stage 1: `SigLIP 2` checks document presence (`DOCUMENT` vs `NON_DOCUMENT`).
3. Stage 2: `PaddleOCR` reads text and evaluates declarative rules from `ocr/contracts/document-type-rules.json`. Matches confirm valid type (`MATCH`) or detect wrong type (`MISMATCH`) in ~150ms.
4. Stage 3: Low-confidence/unrecognized cases fallback to local `GLM-4V` (:8083) for visual document classification.
5. Multi-page rule: at least 1 page matching `expected_code` marks the whole package as `MATCH`.
6. EDO API `OcrWorkerService`: on `MISMATCH`, attempts 1 and 2 auto-reject (`RETURNED`) with clear reason; attempt 3 forwards to `IN_REVIEW` with operator warning flag (`automaticReturnLimitReached: true` and `typeMismatchWarning`).

**Tech Stack:** Python 3.12, FastAPI, PaddleOCR, Transformers (SigLIP 2), GLM-4V HTTP client, TypeScript, NestJS, Prisma, MariaDB, Zod, React.

---

### Task 1: Declarative Rules Registry for 29 Document Types

**Files:**
- Create: `ocr/contracts/document-type-rules.json`
- Create: `ocr/tests/test_document_type_rules.py`

- [ ] **Step 1: Write tests for `document-type-rules.json`**

Write `ocr/tests/test_document_type_rules.py`:
```python
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
RULES_PATH = ROOT / "contracts" / "document-type-rules.json"


class TestDocumentTypeRules(unittest.TestCase):
    def setUp(self):
        self.assertTrue(RULES_PATH.exists(), f"Missing {RULES_PATH}")
        self.data = json.loads(RULES_PATH.read_text(encoding="utf-8"))

    def test_schema_structure(self):
        self.assertEqual(self.data.get("version"), "document-type-rules-v1")
        self.assertIn("rules", self.data)
        rules = self.data["rules"]
        self.assertIsInstance(rules, list)
        self.assertGreaterEqual(len(rules), 29)

    def test_unique_codes(self):
        codes = [rule["code"] for rule in self.data["rules"]]
        self.assertEqual(len(codes), len(set(codes)), "Rule codes must be unique")

    def test_rule_fields_and_regexes(self):
        for rule in self.data["rules"]:
            self.assertIn("code", rule)
            self.assertIn("title", rule)
            self.assertIn("markers", rule)
            self.assertIsInstance(rule["markers"], list)
            self.assertGreater(len(rule["markers"]), 0, f"Empty markers in {rule['code']}")
            for pattern in rule.get("patterns", []):
                try:
                    re.compile(pattern)
                except re.error as err:
                    self.fail(f"Invalid regex '{pattern}' in rule {rule['code']}: {err}")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
python3 -m unittest ocr/tests/test_document_type_rules.py -v
```
Expected: FAIL (file `ocr/contracts/document-type-rules.json` does not exist).

- [ ] **Step 3: Create `ocr/contracts/document-type-rules.json`**

Create `ocr/contracts/document-type-rules.json` with all 29 document types, covering:
`PASSPORT`, `RESIDENCE_PERMIT`, `MIGRATION_CARD`, `WORK_PATENT`, `REGISTRATION_NOTICE`, `PASSPORT_TRANSLATION`, `RUSSIAN_LANGUAGE_CERTIFICATE`, `INN`, `SNILS`, `MILITARY_ID`, `POLICE_CLEARANCE`, `DRIVER_LICENSE`, `TACHOGRAPH_CARD`, `DOPOG`, `NAKS`, `EXCAVATOR_OPERATOR_CERTIFICATE`, `SAFE_WINTER_DRIVING_CERTIFICATE`, `PROFESSION_CERTIFICATE`, `HIGHER_EDUCATION_DIPLOMA`, `RETRAINING_DIPLOMA`, `VOCATIONAL_DIPLOMA`, `PSYCHIATRIC_EVALUATION`, `FOREIGN_MEDICAL_EXAMINATION`, `MEASLES_ANTIBODIES_CERTIFICATE`, `INSURANCE_POLICY`, `MARRIAGE_CERTIFICATE`, `BIRTH_CERTIFICATE`, `BANK_DETAILS`, `EMPLOYMENT_RECORD`.

Include standard aliases, markers, and patterns for each.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
python3 -m unittest ocr/tests/test_document_type_rules.py -v
```
Expected: PASS (all 29 rules valid).

- [ ] **Step 5: Commit**

```bash
git add ocr/contracts/document-type-rules.json ocr/tests/test_document_type_rules.py
git commit -m "feat(ocr): add declarative rules registry for 29 document types"
```

---

### Task 2: Type Matcher Module (`type_matcher.py`)

**Files:**
- Create: `ocr/services/uz/recognizeuz/quality/type_matcher.py`
- Create: `ocr/tests/test_type_matcher.py`

- [ ] **Step 1: Write unit tests for `type_matcher.py`**

Write `ocr/tests/test_type_matcher.py`:
```python
import unittest
from recognizeuz.quality.type_matcher import DocumentTypeMatcher


class TestTypeMatcher(unittest.TestCase):
    def setUp(self):
        self.matcher = DocumentTypeMatcher()

    def test_match_expected_inn(self):
        text = "СВИДЕТЕЛЬСТВО о постановке на учет в налоговом органе ИНН 770123456789"
        result = self.matcher.evaluate_text(text, expected_code="INN")
        self.assertEqual(result["verdict"], "MATCH")
        self.assertEqual(result["detected_code"], "INN")

    def test_mismatch_uploaded_passport_for_inn(self):
        text = "ПАСПОРТ ГРАЖДАНИНА РОССИЙСКОЙ ФЕДЕРАЦИИ ВЫДАН ОТДЕЛОМ УФМС РОССИИ"
        result = self.matcher.evaluate_text(text, expected_code="INN")
        self.assertEqual(result["verdict"], "MISMATCH")
        self.assertEqual(result["detected_code"], "PASSPORT")
        self.assertIn("Паспорт", result["rejection_reason"])

    def test_match_snils_card_and_adi_reg(self):
        text_card = "СТРАХОВОЕ СВИДЕТЕЛЬСТВО ОБЯЗАТЕЛЬНОГО ПЕНСИОННОГО СТРАХОВАНИЯ СНИЛС 123-456-789 01"
        result_card = self.matcher.evaluate_text(text_card, expected_code="SNILS")
        self.assertEqual(result_card["verdict"], "MATCH")

        text_adi = "УВЕДОМЛЕНИЕ О РЕГИСТРАЦИИ В СИСТЕМЕ АДИ-РЕГ СНИЛС 123-456-789 01"
        result_adi = self.matcher.evaluate_text(text_adi, expected_code="SNILS")
        self.assertEqual(result_adi["verdict"], "MATCH")

    def test_uncertain_when_no_markers_match(self):
        text = "какой-то произвольный текст без четких маркеров документов"
        result = self.matcher.evaluate_text(text, expected_code="INN")
        self.assertEqual(result["verdict"], "UNCERTAIN")
        self.assertIsNone(result["detected_code"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
python3 -m unittest ocr/tests/test_type_matcher.py -v
```
Expected: FAIL (`cannot import name 'DocumentTypeMatcher'`).

- [ ] **Step 3: Implement `DocumentTypeMatcher`**

Write `ocr/services/uz/recognizeuz/quality/type_matcher.py`:
- Loads `document-type-rules.json`.
- Normalizes incoming text: converts to lower case, removes accents/excess punctuation.
- Calculates score for each rule: matches against `markers` (exact substring + lemmata/token overlap) and regex `patterns`.
- Evaluates:
  - If score for `expected_code` exceeds threshold: returns `verdict = "MATCH"`.
  - If score for another rule exceeds threshold and `expected_code` score is 0: returns `verdict = "MISMATCH"`.
  - Otherwise returns `verdict = "UNCERTAIN"`.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
python3 -m unittest ocr/tests/test_type_matcher.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ocr/services/uz/recognizeuz/quality/type_matcher.py ocr/tests/test_type_matcher.py
git commit -m "feat(ocr): implement DocumentTypeMatcher for fast keyword verification"
```

---

### Task 3: GLM-4V VLM Fallback Module (`glm_type_verifier.py`)

**Files:**
- Create: `ocr/services/uz/recognizeuz/quality/glm_type_verifier.py`
- Create: `ocr/tests/test_glm_type_verifier.py`

- [ ] **Step 1: Write unit tests with mock for GLM-4V**

Write `ocr/tests/test_glm_type_verifier.py`:
```python
import unittest
from unittest.mock import MagicMock, patch
from recognizeuz.quality.glm_type_verifier import GlmTypeVerifier


class TestGlmTypeVerifier(unittest.TestCase):
    def setUp(self):
        self.verifier = GlmTypeVerifier(base_url="http://127.0.0.1:8083")

    @patch("urllib.request.urlopen")
    def test_glm_confirms_expected_type(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.read.return_value = b'{"choices":[{"message":{"content":"{\\"match\\": true, \\"detected_code\\": \\"INN\\", \\"confidence\\": 0.95}"}}]}'
        mock_urlopen.return_value.__enter__.return_value = mock_response

        result = self.verifier.verify_image(b"fake_image_bytes", expected_code="INN", expected_title="ИНН")
        self.assertEqual(result["verdict"], "MATCH")
        self.assertEqual(result["detected_code"], "INN")

    @patch("urllib.request.urlopen")
    def test_glm_detects_mismatch(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.read.return_value = b'{"choices":[{"message":{"content":"{\\"match\\": false, \\"detected_code\\": \\"PASSPORT\\", \\"confidence\\": 0.98}"}}]}'
        mock_urlopen.return_value.__enter__.return_value = mock_response

        result = self.verifier.verify_image(b"fake_image_bytes", expected_code="INN", expected_title="ИНН")
        self.assertEqual(result["verdict"], "MISMATCH")
        self.assertEqual(result["detected_code"], "PASSPORT")

    @patch("urllib.request.urlopen", side_effect=Exception("Connection refused"))
    def test_glm_handles_unavailable_service(self, mock_urlopen):
        result = self.verifier.verify_image(b"fake_image_bytes", expected_code="INN", expected_title="ИНН")
        self.assertEqual(result["verdict"], "UNCERTAIN")
        self.assertEqual(result["reason"], "VLM_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
python3 -m unittest ocr/tests/test_glm_type_verifier.py -v
```
Expected: FAIL (`cannot import name 'GlmTypeVerifier'`).

- [ ] **Step 3: Implement `GlmTypeVerifier`**

Write `ocr/services/uz/recognizeuz/quality/glm_type_verifier.py`:
- Encodes image bytes to base64.
- Builds prompt with `expected_code`, `expected_title`, and list of known document types.
- Calls `POST /v1/chat/completions` on GLM endpoint with timeout (max 4.0s).
- Safely extracts and parses JSON response `{ match: bool, detected_code: str, confidence: float }`.
- Returns structured `{ verdict: "MATCH" | "MISMATCH" | "UNCERTAIN", detected_code, confidence, reason }`.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
python3 -m unittest ocr/tests/test_glm_type_verifier.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ocr/services/uz/recognizeuz/quality/glm_type_verifier.py ocr/tests/test_glm_type_verifier.py
git commit -m "feat(ocr): implement GlmTypeVerifier for fallback visual verification"
```

---

### Task 4: Upgrade `POST /document-check` to Contract v2

**Files:**
- Modify: `ocr/services/uz/recognizeuz/quality/document_check.py`
- Modify: `ocr/services/uz/recognizeuz/api/routes.py`
- Modify: `ocr/contracts/document-check-v1.json` -> create `ocr/contracts/document-check-v2.json`
- Modify: `ocr/tests/test_document_check.py`
- Modify: `ocr/tests/test_routes.py`

- [ ] **Step 1: Write test for `document-check-v2` in `test_document_check.py`**

Add tests for:
- When `expected_code` is provided and document matches.
- When `expected_code` is provided and document mismatches.
- Multi-page package: page 1 is UNCERTAIN (back of driver license), page 2 is MATCH (front) -> overall verdict MATCH.
- When `expected_code` is omitted, retain backward-compatible behavior.

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
python3 -m unittest ocr/tests/test_document_check.py -v
```
Expected: FAIL.

- [ ] **Step 3: Implement pipeline orchestration in `document_check.py` and `routes.py`**

In `document_check.py`:
- Extend `check_files`:
  - For each page:
    - Step 1: Run `SigLIP 2` -> if `NON_DOCUMENT`, page verdict is `NON_DOCUMENT`.
    - Step 2: Run `PaddleOCR` line extraction -> run `DocumentTypeMatcher`.
    - Step 3: If `UNCERTAIN` and `GLM_VLM_ENABLED`, call `GlmTypeVerifier`.
  - Multi-page aggregation:
    - If any page is `MATCH` -> package `type_verdict = "MATCH"`.
    - Else if any page is `MISMATCH` and no page is `UNCERTAIN` -> package `type_verdict = "MISMATCH"`.
    - Else -> package `type_verdict = "UNCERTAIN"`.
- In `routes.py`:
  - Add optional Form parameter: `expected_code: str = Form(None)`.
  - Return `DocumentCheckResponseV2`.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
python3 -m unittest ocr/tests/test_document_check.py ocr/tests/test_routes.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ocr/services/uz/recognizeuz/quality/document_check.py ocr/services/uz/recognizeuz/api/routes.py ocr/contracts/document-check-v2.json ocr/tests/
git commit -m "feat(ocr): upgrade document-check to v2 with two-stage type verification"
```

---

### Task 5: Update EDO API Client & Zod Contract (`document-check.ts`)

**Files:**
- Modify: `apps/api/src/ocr/document-check.ts`
- Modify: `apps/api/src/ocr/external-ocr.service.ts`
- Modify: `apps/api/test/document-check.spec.ts`

- [ ] **Step 1: Write test for `validateDocumentCheck` with `document-check-v2`**

In `apps/api/test/document-check.spec.ts`:
- Add test case verifying valid `document-check-v2` payload with `type_verdict: "MATCH"`, `expected_code`, `detected_code`.
- Add test case verifying valid `document-check-v2` payload with `type_verdict: "MISMATCH"`.
- Add test case verifying backward compatibility with `document-check-v1`.

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm --filter @edo/api test test/document-check.spec.ts
```
Expected: FAIL.

- [ ] **Step 3: Update `document-check.ts` and `external-ocr.service.ts`**

In `document-check.ts`:
- Update `checkResponse` Zod schema to support `document-check-v2`:
  - `policy_version: z.union([z.literal("document-check-v1"), z.literal("document-check-v2")])`
  - `type_verdict: z.enum(["MATCH", "MISMATCH", "UNCERTAIN"]).optional()`
  - `expected_code: z.string().nullable().optional()`
  - `detected_code: z.string().nullable().optional()`
  - `rejection_reason: z.string().nullable().optional()`
- In `external-ocr.service.ts`:
  - Append `expected_code` (from `request.documentTypeCode` or `documentType.code`) to `form` when calling `checkDocumentPresence`.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm --filter @edo/api test test/document-check.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ocr/document-check.ts apps/api/src/ocr/external-ocr.service.ts apps/api/test/document-check.spec.ts
git commit -m "feat(api): support document-check-v2 schema and pass expected_code"
```

---

### Task 6: Document Lifecycle & 3-Attempt Rule in `OcrWorkerService`

**Files:**
- Modify: `apps/api/src/ocr/ocr-worker.service.ts`
- Modify: `apps/api/test/ocr-review-lifecycle.spec.ts`

- [ ] **Step 1: Write lifecycle test for type mismatch and 3-attempt limit**

In `apps/api/test/ocr-review-lifecycle.spec.ts`:
- Test attempt 1: `MISMATCH` returns `DocumentVersion` status `RETURNED` with specific `rejectionReason`.
- Test attempt 2: `MISMATCH` returns `DocumentVersion` status `RETURNED`.
- Test attempt 3: `MISMATCH` (with 2 previous `RETURNED` by `ocr-document-check`) transitions to `IN_REVIEW` with `automaticReturnLimitReached: true` and `typeMismatchWarning`.

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm --filter @edo/api test test/ocr-review-lifecycle.spec.ts
```
Expected: FAIL.

- [ ] **Step 3: Update `OcrWorkerService` implementation**

In `apps/api/src/ocr/ocr-worker.service.ts`:
- Check `checkResult.type_verdict === "MISMATCH"`:
  - If `previous.length < 2`:
    - Set `returned = true`.
    - Formulate `rejectionReason = checkResult.rejection_reason || \`Загружен документ "${checkResult.detected_title || checkResult.detected_code}" вместо ожидаемого "${checkResult.expected_title || checkResult.expected_code}".\``.
    - Mark `reviewedBy: "ocr-document-check"`.
  - If `previous.length >= 2` (3rd attempt):
    - Set `returned = false`, status = `IN_REVIEW`.
    - Save in `ocrRaw`: `{ automaticReturnLimitReached: true, typeMismatchWarning: { expected: checkResult.expected_code, detected: checkResult.detected_code, expectedTitle: checkResult.expected_title, detectedTitle: checkResult.detected_title } }`.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm --filter @edo/api test test/ocr-review-lifecycle.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ocr/ocr-worker.service.ts apps/api/test/ocr-review-lifecycle.spec.ts
git commit -m "feat(api): enforce 3-attempt limit and operator warning on document type mismatch"
```

---

### Task 7: Web UI Operator Warning Banner & End-to-End Verification

**Files:**
- Modify: `apps/web/src/components/` (Review card / document inspection view)
- Run regression tests: `pnpm build`, `pnpm test`

- [ ] **Step 1: Add type mismatch alert to document review component**

In document review view:
- If `version.ocrRaw?.typeMismatchWarning` is present:
  - Render a prominent alert badge:
    `"Внимание (3-я попытка): Обнаружен {detectedTitle} вместо {expectedTitle}. Требуется ручная проверка."`

- [ ] **Step 2: Run monorepo typecheck and tests**

Run from repo root:
```bash
pnpm --filter @edo/api test
pnpm --filter @edo/web build
```
Expected: All tests pass, build succeeds with zero errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/
git commit -m "feat(web): display document type mismatch warning for manual review"
```

---

## Plan Self-Review Check
1. **Spec coverage:** All 29 document types, `expected_code`, two-stage pipeline (SigLIP 2 -> PaddleOCR -> GLM-4V), multi-page rule ("at least 1 page matches"), 3-attempt limit, and UI operator banner are covered across Tasks 1–7.
2. **Placeholders:** Zero "TBD", "TODO", or vague code snippets.
3. **Consistency:** Property names (`expected_code`, `detected_code`, `type_verdict`, `typeMismatchWarning`) match across OCR Python service, NestJS API, and Web UI.
