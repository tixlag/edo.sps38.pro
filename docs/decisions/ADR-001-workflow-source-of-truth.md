# ADR-001: Backend source of truth for workflow

Frontend never hardcodes onboarding path rules. Backend returns current stage,
required documents, available actions and blockers; frontend only renders them.
