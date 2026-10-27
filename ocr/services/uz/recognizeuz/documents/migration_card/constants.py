from __future__ import annotations

FIELD_NAMES = frozenset({
    "mg_series",
    "mg_number",
    "mg_surname",
    "mg_surname_lat",
    "mg_name",
    "mg_patronymic",
    "mg_date_of_birth",
    "mg_nationality",
    "mg_passport_number",
    "mg_visa_number",
    "mg_duration_from",
    "mg_duration_to",
})

INTERNAL_ONLY_FIELDS = frozenset()
SKIP_OCR_FIELDS = frozenset()

OUTPUT_FIELDS = (
    "mg_series",
    "mg_number",
    "mg_surname",
    "mg_surname_lat",
    "mg_name",
    "mg_patronymic",
    "mg_date_of_birth",
    "mg_nationality",
    "mg_passport_number",
    "mg_visa_number",
    "mg_duration_from",
    "mg_duration_to",
)

FIO_FIELDS = frozenset({
    "mg_surname",
    "mg_surname_lat",
    "mg_name",
    "mg_patronymic",
})
