from __future__ import annotations

from recognizeuz.documents.migration_card.constants import OUTPUT_FIELDS as MIGRATION_OUTPUT_FIELDS
from recognizeuz.documents.passport.constants import OUTPUT_FIELDS as PASSPORT_OUTPUT_FIELDS

FIELD_LABELS = {
    "pas_number": "passport number",
    "pas_surname": "surname",
    "pas_name": "given name",
    "pas_patronymic": "patronymic",
    "pas_nationality": "nationality",
    "pas_date_of_birth": "date of birth",
    "pas_sex": "sex",
    "pas_place_of_birth": "place of birth",
    "pas_date_of_issue": "date of issue",
    "pas_date_of_expiry": "date of expiry",
    "pas_authority": "issuing authority",
    "mg_series": "migration card series",
    "mg_number": "migration card number",
    "mg_surname": "surname in Cyrillic",
    "mg_surname_lat": "surname in Latin",
    "mg_name": "given name",
    "mg_patronymic": "patronymic",
    "mg_date_of_birth": "date of birth",
    "mg_nationality": "nationality",
    "mg_passport_number": "passport number",
    "mg_visa_number": "visa number",
    "mg_duration_from": "valid from date",
    "mg_duration_to": "valid to date",
}

DOC_OUTPUT_FIELDS = {
    "passport": list(PASSPORT_OUTPUT_FIELDS),
    "migration_card": list(MIGRATION_OUTPUT_FIELDS),
}

DATE_FIELD_NAMES = frozenset({
    "pas_date_of_birth",
    "pas_date_of_issue",
    "pas_date_of_expiry",
    "mg_date_of_birth",
    "mg_duration_from",
    "mg_duration_to",
})

SEX_FIELD_NAMES = frozenset({
    "pas_sex",
})

PERSON_NAME_FIELD_NAMES = frozenset({
    "pas_surname",
    "pas_name",
    "pas_patronymic",
    "mg_surname",
    "mg_surname_lat",
    "mg_name",
    "mg_patronymic",
})

NUMBERISH_FIELD_NAMES = frozenset({
    "pas_number",
    "mg_series",
    "mg_number",
    "mg_passport_number",
    "mg_visa_number",
})
