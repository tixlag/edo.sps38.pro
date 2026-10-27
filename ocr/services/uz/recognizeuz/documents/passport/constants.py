from __future__ import annotations

FIELD_NAMES = frozenset({
    "pas_number",
    "pas_surname",
    "pas_name",
    "pas_patronymic",
    "pas_nationality",
    "pas_date_of_birth",
    "pas_sex",
    "pas_place_of_birth",
    "pas_date_of_issue",
    "pas_date_of_expiry",
    "pas_authority",
    "pas_photo",
    "pas_mrz",
})

INTERNAL_ONLY_FIELDS = frozenset({"pas_mrz"})

SKIP_OCR_FIELDS = frozenset({
    "pas_photo",
    *INTERNAL_ONLY_FIELDS,
})

OUTPUT_FIELDS = (
    "pas_number",
    "pas_surname",
    "pas_name",
    "pas_patronymic",
    "pas_nationality",
    "pas_date_of_birth",
    "pas_sex",
    "pas_place_of_birth",
    "pas_date_of_issue",
    "pas_date_of_expiry",
    "pas_authority",
)
