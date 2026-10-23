from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import tempfile
import time
import unicodedata
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

import cv2
import numpy as np
import requests
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

from recognizeuz.core.config import *
from recognizeuz.image.preprocessing import prepare_ocr_image_array
from recognizeuz.ocr.glm import clean_glm_text, glm_ocr_field
from recognizeuz.ocr.paddle import recognize_prepared_image_with_paddle
from recognizeuz.text.normalization import normalize_ocr_phrase_for_token_repair, normalize_ocr_text_for_match
from recognizeuz.text.transliteration import (
    _RU_MIGRATION_COMMON_EXACT,
    _RU_MIGRATION_FIELD_EXACT_OVERRIDES,
    _RU_MIGRATION_NATIONALITY_EXACT,
    _RU_MIGRATION_PLACE_EXACT,
    _migration_dictionary_key,
    _lookup_russian_migration_dictionary,
)
from recognizeuz.utils.timing import elapsed_seconds, score_to_unit


DATE_FIELD_NAMES = {
    "pas_date_of_birth",
    "pas_date_of_issue",
    "pas_date_of_expiry",
    "mg_date_of_birth",
    "mg_duration_from",
    "mg_duration_to",
}

SEX_FIELD_NAMES = {
    "pas_sex",
}

PERSON_NAME_FIELD_NAMES = {
    "pas_surname",
    "pas_name",
    "pas_patronymic",
    "mg_surname",
    "mg_surname_lat",
    "mg_name",
    "mg_patronymic",
}

NUMBERISH_FIELD_NAMES = {
    "pas_number",
    "mg_series",
    "mg_number",
    "mg_passport_number",
    "mg_visa_number",
}


def collapse_label_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", clean_glm_text(text)).strip()


def has_any_letter_or_digit(text: str) -> bool:
    return bool(re.search(r"[0-9A-Za-zА-Яа-яЁё]", text))


def looks_like_glm_explanation_or_markup(text: str) -> bool:
    stripped = text.strip()
    lowered = stripped.lower()

    if not stripped:
        return False

    if stripped.startswith(("{", "[", "```")):
        return True

    banned_fragments = {
        "document type",
        "field:",
        "requested document field",
        "return only",
        "visible text",
        "the text is",
        "i can",
        "i cannot",
        "не могу",
        "на изображении",
        "текст:",
        "поле:",
    }

    return any(fragment in lowered for fragment in banned_fragments)


def validate_glm_label_for_field(
    *,
    doc_type: str,
    field_name: str,
    glm_text: str,
) -> tuple[str | None, str | None]:
    """
    Возвращает (label, reject_reason).

    Это защита от случаев, когда YOLO вырезал не текстовое поле или GLM
    начал объяснять/галлюцинировать. Правила специально мягкие: лучше
    сохранить чуть меньше, чем положить в датасет мусор с неправильной меткой.
    """

    label = collapse_label_spaces(glm_text)

    if not label:
        return None, "empty_glm_text"

    if len(label) > OCR_IMPROVE_MAX_LABEL_LEN:
        return None, "glm_text_too_long"

    if "\n" in clean_glm_text(glm_text):
        return None, "glm_text_multiline"

    if looks_like_glm_explanation_or_markup(label):
        return None, "glm_explanation_or_markup"

    if not has_any_letter_or_digit(label):
        return None, "glm_text_without_letters_or_digits"

    normalized = normalize_ocr_text_for_match(label)

    if field_name in DATE_FIELD_NAMES:
        # Принимаем 01.02.1999 / 01-02-1999 / 01 02 1999 / 1.2.99.
        if not re.fullmatch(r"\d{1,2}[./\- ]\d{1,2}[./\- ]\d{2,4}", label):
            return None, "invalid_date_format"

    elif field_name in SEX_FIELD_NAMES:
        allowed = {
            "M",
            "F",
            "М",
            "Ж",
            "MALE",
            "FEMALE",
            "ERKAK",
            "AYOL",
            "МУЖ",
            "ЖЕН",
            "МУЖСКОЙ",
            "ЖЕНСКИЙ",
        }
        if normalized not in allowed:
            return None, "invalid_sex_value"

    elif field_name in PERSON_NAME_FIELD_NAMES:
        # ФИО не должны состоять только из цифр/символов.
        if not re.search(r"[A-Za-zА-Яа-яЁё]", label):
            return None, "name_without_letters"
        if not re.fullmatch(r"[A-Za-zА-Яа-яЁёʻʼ‘’`´ʹ'\- .]+", label):
            return None, "name_has_forbidden_chars"

    elif field_name in NUMBERISH_FIELD_NAMES:
        # Номера могут содержать буквы, цифры, пробелы и дефисы.
        if not re.fullmatch(r"[A-Za-zА-Яа-яЁё0-9\- /]+", label):
            return None, "number_has_forbidden_chars"
        if len(normalized) < 1:
            return None, "number_too_short"

    else:
        # Адреса/органы выдачи/национальность — шире, но без явного мусора.
        if not re.fullmatch(r"[A-Za-zА-Яа-яЁё0-9ʻʼ‘’`´ʹ'\- ./,№()]+", label):
            return None, "text_has_forbidden_chars"

    return label, None


# ---------------------------------------------------------------------
# OCR QUALITY / TTA / SAFE REPAIR
# ---------------------------------------------------------------------

PASSPORT_NUMBER_RE = re.compile(r"^[A-Z]{2}\d{7}$")
PASSPORT_DATE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")

PASSPORT_AUTHORITY_RE = re.compile(r"^[A-Z]{3}\s+\d{5}$")
PASSPORT_AUTHORITY_KNOWN_PREFIXES = {
    item.strip().upper()
    for item in os.getenv("PASSPORT_AUTHORITY_KNOWN_PREFIXES", "MIA,PSC").split(",")
    if item.strip()
}


STRICT_FORMAT_FIELD_NAMES = {
    "pas_number",
    "pas_authority",
    *DATE_FIELD_NAMES,
    *SEX_FIELD_NAMES,
}

OCR_DICTIONARY_REPAIR_FIELD_NAMES = {
    "pas_nationality",
    "mg_nationality",
    "pas_place_of_birth",
}

# Token-level dictionary repair is weaker than exact field dictionary repair:
# it only repairs a broken token when the repaired token is in a small allow-list
# (REGIQON -> REGION, REGI0N -> REGION, etc.).
# Keep it disabled for names, dates, sex, and numeric/id fields, but allow it for
# free text fields such as place/authority even if field_name was not in
# OCR_DICTIONARY_REPAIR_FIELD_NAMES.
def should_allow_dictionary_token_repair(field_name: str) -> bool:
    if field_name in SKIP_OCR_FIELDS:
        return False

    if field_name in PERSON_NAME_FIELD_NAMES:
        return False

    if field_name in DATE_FIELD_NAMES:
        return False

    if field_name in SEX_FIELD_NAMES:
        return False

    if field_name in NUMBERISH_FIELD_NAMES:
        return False

    return True

# Значения, где безопасно исправлять ровно один лишний повтор,
# если кандидат после удаления повтора попадает в словарь.
# ФИО сюда намеренно не включаем: ABDULLAEV/ALLABERGANOV могут быть нормой.
OCR_SAFE_REPAIR_ENGLISH_PLACE_VALUES = {
    "TASHKENT REGION",
    "SAMARKAND REGION",
    "BUKHARA REGION",
    "ANDIJAN REGION",
    "FERGANA REGION",
    "NAMANGAN REGION",
    "JIZZAKH REGION",
    "NAVOI REGION",
    "KASHKADARYA REGION",
    "SURKHANDARYA REGION",
    "SYRDARYA REGION",
    "KHOREZM REGION",
    "REPUBLIC OF KARAKALPAKSTAN",
    "KARAKALPAKSTAN REPUBLIC",
    "TASHKENT CITY",
}

OCR_SAFE_REPAIR_EXACT_VALUES = {
    *_RU_MIGRATION_COMMON_EXACT.keys(),
    *_RU_MIGRATION_PLACE_EXACT.keys(),
    *_RU_MIGRATION_NATIONALITY_EXACT.keys(),
    *OCR_SAFE_REPAIR_ENGLISH_PLACE_VALUES,
    "UZBEKISTAN",
    "KARAKALPAKSTAN",
    "QORAQALPOGISTON",
    "KARAKALPAK",
    "QORAQALPOQ",
    "UZBEK",
    "TAJIK",
    "KYRGYZ",
    "KAZAKH",
    "TURKMAN",
    "RUSSIAN",
}

# Token dictionary used for safe repair inside longer place/nationality phrases.
# Examples:
#   KASHKADARYA REGIQON -> KASHKADARYA REGION  (delete extra Q)
#   SURKHANDARYA REGI0N -> SURKHANDARYA REGION (0 -> O)
def _build_safe_repair_token_values() -> set[str]:
    values: set[str] = set()

    for phrase in OCR_SAFE_REPAIR_EXACT_VALUES:
        norm = normalize_ocr_phrase_for_token_repair(str(phrase))
        for token in re.findall(r"[A-Z0-9]+", norm):
            if len(token) >= 2:
                values.add(token)

    values.update(
        {
            # English administrative words commonly printed in passport place fields.
            "REGION",
            "REPUBLIC",
            "DISTRICT",
            "CITY",
            "TOWN",
            "VILLAGE",
            "PROVINCE",
            "AREA",

            # Uzbek administrative words, in case the OCR reads the Uzbek/Latin line.
            "VILOYATI",
            "TUMANI",
            "SHAHRI",
            "RESPUBLIKASI",

            # Common English spellings of Uzbekistan regions/cities.
            "KASHKADARYA",
            "SURKHANDARYA",
            "SYRDARYA",
            "TASHKENT",
            "SAMARKAND",
            "BUKHARA",
            "ANDIJAN",
            "FERGANA",
            "JIZZAKH",
            "NAVOI",
            "KHOREZM",
            "KARSHI",
            "NUKUS",
            "TERMEZ",
            "URGENCH",
            "GULISTAN",
            "CHIRCHIK",
            "KOKAND",
            "MARGILAN",
            "SHAHRISABZ",
            "KARAKALPAKSTAN",
        }
    )

    return values


OCR_SAFE_REPAIR_TOKEN_VALUES = _build_safe_repair_token_values()

# Confusable substitutions are used only when the resulting token is in
# OCR_SAFE_REPAIR_TOKEN_VALUES, so this does not globally rewrite valid Q.
OCR_TOKEN_CONFUSABLE_REPLACEMENTS = {
    "0": {"O"},
    "О": {"O"},
    "Q": {"O"},  # REGIQN -> REGION; not applied unless REGION is a known token.
    "1": {"I", "L"},
    "I": {"1"},
    "L": {"I"},
    "5": {"S"},
    "8": {"B"},
}


def normalize_numberish_for_schema(text: str) -> str:
    value = normalize_ocr_text_for_match(text)
    value = re.sub(r"[-_/ ]+", "", value)
    return value

def _latinize_authority_text(text: str) -> str:
    """
    Безопасно приводит похожие кириллические/латинские символы к латинице
    именно для authority-кода.

    Важно: эта функция НЕ исправляет длину и НЕ угадывает префикс.
    Она только нормализует похожие символы.
    """

    value = unicodedata.normalize("NFKC", str(text or "")).upper()

    table = str.maketrans(
        {
            # Cyrillic -> Latin lookalikes
            "А": "A",
            "В": "B",
            "Е": "E",
            "К": "K",
            "М": "M",
            "Н": "H",
            "О": "O",
            "Р": "P",
            "С": "C",
            "Т": "T",
            "Х": "X",
            "І": "I",
            "И": "I",

            # Greek lookalikes, на всякий случай после OCR
            "Α": "A",
            "Β": "B",
            "Ε": "E",
            "Η": "H",
            "Ι": "I",
            "Κ": "K",
            "Μ": "M",
            "Ν": "N",
            "Ο": "O",
            "Ρ": "P",
            "Τ": "T",
            "Χ": "X",
        }
    )

    return value.translate(table)


def split_authority_prefix_and_digits(text: str) -> tuple[str | None, str | None]:
    """
    Возвращает (prefix, digits) для authority-поля.

    Примеры:
      MIA 35000   -> ("MIA", "35000")
      MIA35000    -> ("MIA", "35000")
      MIA 350000  -> ("MIA", "350000")
      MILA 10208  -> ("MILA", "10208")

    Здесь можно нормализовать OCR-confusions внутри цифровой части:
      O/Q -> 0
      I/L -> 1
      S -> 5
      B -> 8

    Но prefix не исправляем: MILA остаётся MILA.
    """

    value = _latinize_authority_text(text)
    compact = re.sub(r"[^A-Z0-9]", "", value)

    match = re.fullmatch(r"([A-Z]+)([0-9OQISBL]+)", compact)
    if not match:
        return None, None

    prefix, digits = match.groups()

    digit_table = str.maketrans(
        {
            "O": "0",
            "Q": "0",
            "I": "1",
            "L": "1",
            "S": "5",
            "B": "8",
        }
    )
    digits = digits.translate(digit_table)

    return prefix, digits


def normalize_authority_for_schema(text: str) -> str:
    """
    Канонизация pas_authority.

    Важно:
    - НЕ исправляет MILA -> MIA.
    - НЕ исправляет MIA 350000 -> MIA 35000.
    - Только приводит к виду PREFIX DIGITS, чтобы валидация могла сказать invalid.

    Примеры:
      MIA35000    -> MIA 35000     valid
      MIA 35000   -> MIA 35000     valid
      MIA 350000  -> MIA 350000    invalid
      MILA 10208  -> MILA 10208    invalid
      мусор       -> МУСОР/исходная нормализованная строка, invalid
    """

    prefix, digits = split_authority_prefix_and_digits(text)

    if prefix is not None and digits is not None:
        return f"{prefix} {digits}"

    # Если не смогли разобрать как prefix+digits — возвращаем нормализованный текст.
    # Он НЕ пройдёт PASSPORT_AUTHORITY_RE и останется invalid.
    return collapse_label_spaces(_latinize_authority_text(text))


def normalize_date_for_schema(text: str) -> str:
    value = clean_glm_text(str(text)).strip()
    value = unicodedata.normalize("NFKC", value)
    value = re.sub(r"[\s/\-]+", ".", value)
    value = re.sub(r"\.+", ".", value).strip(".")

    m = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.(\d{2,4})", value)
    if not m:
        return value

    day, month, year = m.groups()
    if len(year) == 2:
        year = "19" + year if int(year) > 30 else "20" + year

    return f"{int(day):02d}.{int(month):02d}.{int(year):04d}"


def normalize_sex_for_schema(text: str) -> str:
    value = normalize_ocr_text_for_match(text)
    mapping = {
        "M": "M",
        "MALE": "M",
        "ERKAK": "M",
        "М": "M",
        "МУЖ": "M",
        "МУЖСКОЙ": "M",
        "F": "F",
        "FEMALE": "F",
        "AYOL": "F",
        "Ж": "F",
        "ЖЕН": "F",
        "ЖЕНСКИЙ": "F",
    }
    return mapping.get(value, value)


def canonical_text_for_field_schema(field_name: str, text: str) -> str:
    if field_name == "pas_number":
        return normalize_numberish_for_schema(text)

    if field_name == "pas_authority":
        return normalize_authority_for_schema(text)

    if field_name in DATE_FIELD_NAMES:
        return normalize_date_for_schema(text)

    if field_name in SEX_FIELD_NAMES:
        return normalize_sex_for_schema(text)

    return collapse_label_spaces(text)


def validate_ocr_text_for_field(
    *,
    doc_type: str,
    field_name: str,
    text: str,
) -> tuple[bool, str | None, str]:
    """
    Строгая валидация финального OCR-значения.
    В отличие от validate_glm_label_for_field(), здесь есть бизнес-форматы:
    номер паспорта, дата, пол. Для свободных текстов правила мягкие.
    """

    value = canonical_text_for_field_schema(field_name, text)
    normalized = normalize_ocr_text_for_match(value)

    if field_name in SKIP_OCR_FIELDS:
        return True, None, value

    if not value:
        return False, "empty_text", value

    if looks_like_glm_explanation_or_markup(value):
        return False, "looks_like_explanation_or_markup", value

    if field_name == "pas_number":
        if not PASSPORT_NUMBER_RE.fullmatch(value):
            return False, "invalid_passport_number_format", value
        return True, None, value

    if field_name == "pas_authority":
        if not PASSPORT_AUTHORITY_RE.fullmatch(value):
            return False, "invalid_passport_authority_format", value
        return True, None, value

    if field_name in DATE_FIELD_NAMES:
        if not PASSPORT_DATE_RE.fullmatch(value):
            return False, "invalid_date_format", value
        try:
            datetime.strptime(value, "%d.%m.%Y")
        except ValueError:
            return False, "invalid_date_value", value
        return True, None, value

    if field_name in SEX_FIELD_NAMES:
        if value not in {"M", "F"}:
            return False, "invalid_sex_value", value
        return True, None, value

    if field_name in PERSON_NAME_FIELD_NAMES:
        if not re.search(r"[A-Za-zА-Яа-яЁё]", value):
            return False, "name_without_letters", value
        if not re.fullmatch(r"[A-Za-zА-Яа-яЁёʻʼ‘’`´ʹ'\- .]+", value):
            return False, "name_has_forbidden_chars", value
        return True, None, value

    if field_name in NUMBERISH_FIELD_NAMES:
        if not re.fullmatch(r"[A-Za-zА-Яа-яЁё0-9\- /]+", value):
            return False, "number_has_forbidden_chars", value
        if len(normalized) < 1:
            return False, "number_too_short", value
        return True, None, value

    if not has_any_letter_or_digit(value):
        return False, "text_without_letters_or_digits", value

    if not re.fullmatch(r"[A-Za-zА-Яа-яЁё0-9ʻʼ‘’`´ʹ'\- ./,№()]+", value):
        return False, "text_has_forbidden_chars", value

    return True, None, value


def build_one_extra_repeat_candidates(text: str) -> list[str]:
    """Кандидаты, полученные удалением ровно одного повторного символа."""

    value = normalize_ocr_text_for_match(text)
    candidates: list[str] = []
    seen: set[str] = set()

    for i in range(1, len(value)):
        if value[i] != value[i - 1]:
            continue

        candidate = value[:i] + value[i + 1:]
        if candidate and candidate not in seen:
            candidates.append(candidate)
            seen.add(candidate)

    return candidates


def build_one_deleted_char_candidates(text: str) -> list[str]:
    """Кандидаты, полученные удалением ровно одного символа в любом месте."""

    value = normalize_ocr_text_for_match(text)
    candidates: list[str] = []
    seen: set[str] = set()

    for i in range(len(value)):
        candidate = value[:i] + value[i + 1:]
        if candidate and candidate not in seen:
            candidates.append(candidate)
            seen.add(candidate)

    return candidates


def build_one_confusable_replacement_candidates(text: str) -> list[str]:
    """Кандидаты, полученные одной безопасной confusable-заменой."""

    value = normalize_ocr_text_for_match(text)
    candidates: list[str] = []
    seen: set[str] = set()

    for i, ch in enumerate(value):
        for repl in OCR_TOKEN_CONFUSABLE_REPLACEMENTS.get(ch, set()):
            if repl == ch:
                continue
            candidate = value[:i] + repl + value[i + 1:]
            if candidate and candidate not in seen:
                candidates.append(candidate)
                seen.add(candidate)

    return candidates


def get_safe_token_repair_candidates(token: str) -> list[dict[str, str]]:
    """
    Repair one token only when the target is an exact known token.

    This catches non-repeat insertions like REGIQON -> REGION:
      REGIQON --delete Q--> REGION

    It also catches classic OCR confusions when the result is known:
      REGI0N --0->O--> REGION
      REGIQN --Q->O--> REGION

    We keep this token-level and dictionary-level to avoid dangerous global
    replacements such as rewriting every Q in Uzbek names/places.
    """

    value = normalize_ocr_text_for_match(token)
    if len(value) < 5:
        return []

    if value in OCR_SAFE_REPAIR_TOKEN_VALUES:
        return []

    found: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(candidate: str, reason: str) -> None:
        candidate = normalize_ocr_text_for_match(candidate)
        if candidate in OCR_SAFE_REPAIR_TOKEN_VALUES and candidate not in seen:
            found.append({"text": candidate, "reason": reason})
            seen.add(candidate)

    for candidate in build_one_deleted_char_candidates(value):
        add(candidate, "dictionary_token_one_extra_char")

    for candidate in build_one_confusable_replacement_candidates(value):
        add(candidate, "dictionary_token_confusable_char")

    return found


def try_safe_repair_dictionary_phrase_tokens(text: str) -> tuple[str | None, str | None, list[dict[str, Any]]]:
    """
    Repairs known tokens inside longer phrases.

    Example:
      KASHKADARYA REGIQON -> KASHKADARYA REGION

    If any token has multiple possible repairs, the whole phrase repair is
    considered ambiguous and must go to TTA/GLM/manual review.
    """

    if not OCR_SAFE_REPAIR_DICTIONARY_TOKENS:
        return None, None, []

    src = normalize_ocr_phrase_for_token_repair(text)
    if not src:
        return None, None, []

    repairs: list[dict[str, Any]] = []
    ambiguous: list[dict[str, Any]] = []

    def replace_token(match: re.Match[str]) -> str:
        token = match.group(0)
        token_candidates = get_safe_token_repair_candidates(token)
        if len(token_candidates) == 1:
            candidate = token_candidates[0]
            repairs.append(
                {
                    "from": token,
                    "to": candidate["text"],
                    "reason": candidate["reason"],
                }
            )
            return candidate["text"]

        if len(token_candidates) > 1:
            ambiguous.append(
                {
                    "token": token,
                    "candidates": token_candidates,
                }
            )

        return token

    repaired = re.sub(r"[A-Z0-9]+", replace_token, src)

    if ambiguous:
        return None, "dictionary_token_repair_ambiguous", ambiguous

    if not repairs or repaired == src:
        return None, None, []

    reasons = sorted({str(r["reason"]) for r in repairs})
    return repaired, "+".join(reasons), repairs


def has_dictionary_token_repair_candidate(*, field_name: str, text: str) -> bool:
    if not should_allow_dictionary_token_repair(field_name):
        return False

    repaired, _, _ = try_safe_repair_dictionary_phrase_tokens(text)
    return repaired is not None

def build_one_confusable_authority_prefix_candidates(prefix: str) -> list[str]:
    """
    Кандидаты prefix после одной confusable-замены.

    Это НЕ применяется вслепую. Итоговый prefix потом должен попасть
    в PASSPORT_AUTHORITY_KNOWN_PREFIXES.
    """

    value = normalize_ocr_text_for_match(_latinize_authority_text(prefix))

    replacements = {
        "1": {"I"},
        "I": {"1"},
        "L": {"I"},
        "0": {"O"},
        "O": {"0"},
    }

    candidates: list[str] = []
    seen: set[str] = set()

    for i, ch in enumerate(value):
        for repl in replacements.get(ch, set()):
            candidate = value[:i] + repl + value[i + 1:]
            if candidate and candidate not in seen:
                candidates.append(candidate)
                seen.add(candidate)

    return candidates


def get_pas_authority_repair_candidates(text: str) -> list[dict[str, str]]:
    """
    Безопасный repair для pas_authority.

    Формат итогового значения:
      3 латинские буквы + 5 цифр

    Безопасно исправляет:
      MIA 350000 -> MIA 35000

    Исправляет prefix 4->3 только через allow-list:
      MILA 10208 -> MIA 10208
    только если MIA есть в PASSPORT_AUTHORITY_KNOWN_PREFIXES.

    Не угадывает произвольные prefix:
      ABCD 10208 не будет превращён в ABC/ABD/ACD/BCD,
      если ровно один кандидат не найден в allow-list.
    """

    prefix, digits = split_authority_prefix_and_digits(text)
    if not prefix or not digits:
        return []

    prefix_candidates: list[tuple[str, str]] = []

    if re.fullmatch(r"[A-Z]{3}", prefix):
        prefix_candidates.append((prefix, "authority_prefix_exact"))

    elif re.fullmatch(r"[A-Z]{4}", prefix):
        deleted_candidates = sorted(
            {
                candidate
                for candidate in build_one_deleted_char_candidates(prefix)
                if re.fullmatch(r"[A-Z]{3}", candidate)
            }
        )

        known_deleted_candidates = [
            candidate
            for candidate in deleted_candidates
            if candidate in PASSPORT_AUTHORITY_KNOWN_PREFIXES
        ]

        if len(known_deleted_candidates) == 1:
            prefix_candidates.append(
                (
                    known_deleted_candidates[0],
                    "authority_prefix_one_extra_char_known",
                )
            )

        confusable_candidates = sorted(
            {
                candidate
                for candidate in build_one_confusable_authority_prefix_candidates(prefix)
                if re.fullmatch(r"[A-Z]{3}", candidate)
                and candidate in PASSPORT_AUTHORITY_KNOWN_PREFIXES
            }
        )

        if len(confusable_candidates) == 1:
            prefix_candidates.append(
                (
                    confusable_candidates[0],
                    "authority_prefix_confusable_char_known",
                )
            )

    digit_candidates: list[tuple[str, str]] = []

    if re.fullmatch(r"\d{5}", digits):
        digit_candidates.append((digits, "authority_code_exact"))

    else:
        # Пример:
        #   350000 -> 35000
        # Только если удаление одного повторного символа даёт единственный
        # 5-значный кандидат.
        code_candidates = sorted(
            {
                candidate
                for candidate in build_one_extra_repeat_candidates(digits)
                if re.fullmatch(r"\d{5}", candidate)
            }
        )

        if len(code_candidates) == 1:
            digit_candidates.append(
                (
                    code_candidates[0],
                    "authority_code_one_extra_repeat",
                )
            )

    found: list[dict[str, str]] = []
    seen: set[str] = set()

    for prefix_candidate, prefix_reason in prefix_candidates:
        for digit_candidate, digit_reason in digit_candidates:
            candidate_text = f"{prefix_candidate} {digit_candidate}"

            if not PASSPORT_AUTHORITY_RE.fullmatch(candidate_text):
                continue

            if candidate_text in seen:
                continue

            reason_parts: list[str] = []

            if prefix_reason != "authority_prefix_exact":
                reason_parts.append(prefix_reason)

            if digit_reason != "authority_code_exact":
                reason_parts.append(digit_reason)

            found.append(
                {
                    "text": candidate_text,
                    "reason": "+".join(reason_parts) or "authority_schema_normalized",
                }
            )
            seen.add(candidate_text)

    return found


def has_suspicious_alpha_triple(text: str) -> bool:
    value = normalize_ocr_text_for_match(text)
    return bool(re.search(r"([A-Z])\1{2,}", value))


def is_safe_dictionary_value_for_field(
    *,
    field_name: str,
    text: str,
) -> bool:
    if field_name not in OCR_DICTIONARY_REPAIR_FIELD_NAMES:
        return False

    value = normalize_ocr_text_for_match(
        canonical_text_for_field_schema(field_name, text)
    )

    if not value:
        return False

    if value in OCR_SAFE_REPAIR_EXACT_VALUES:
        return True

    return _lookup_russian_migration_dictionary(
        value,
        field_name=field_name,
    ) is not None


def has_dictionary_one_extra_repeat_candidate(
    *,
    field_name: str,
    text: str,
) -> bool:
    if field_name not in OCR_DICTIONARY_REPAIR_FIELD_NAMES:
        return False

    # Если текущее значение уже точное словарное — не считаем его подозрительным
    # только из-за наличия внутренних повторов.
    if is_safe_dictionary_value_for_field(field_name=field_name, text=text):
        return False

    for candidate in build_one_extra_repeat_candidates(text):
        if is_safe_dictionary_value_for_field(field_name=field_name, text=candidate):
            return True

    return False


def levenshtein_distance(
    a: str,
    b: str,
    *,
    max_distance: int | None = None,
) -> int:
    """Bounded Levenshtein distance for small OCR dictionaries."""

    a = str(a)
    b = str(b)

    if a == b:
        return 0

    if max_distance is not None and abs(len(a) - len(b)) > max_distance:
        return max_distance + 1

    previous = list(range(len(b) + 1))

    for i, ca in enumerate(a, 1):
        current = [i]
        row_min = current[0]

        for j, cb in enumerate(b, 1):
            value = min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + (0 if ca == cb else 1),
            )
            current.append(value)
            row_min = min(row_min, value)

        if max_distance is not None and row_min > max_distance:
            return max_distance + 1

        previous = current

    return previous[-1]


def get_dictionary_nearest_values_for_field(field_name: str) -> set[str]:
    """
    Small allow-list for edit-distance repair.

    This is intentionally limited to fields with stable dictionaries. It must
    NOT be used for personal names, because edit-distance repair can corrupt
    real surnames and given names.
    """

    values: set[str] = set()

    if field_name in {"pas_nationality", "mg_nationality"}:
        values.update(_RU_MIGRATION_NATIONALITY_EXACT.keys())
        values.update(
            {
                "UZBEKISTAN",
                "UZBEK",
                "KARAKALPAKSTAN",
                "KARAKALPAK",
                "QORAQALPOGISTON",
                "QORAQALPOQ",
                "TAJIK",
                "KYRGYZ",
                "KAZAKH",
                "TURKMAN",
                "RUSSIAN",
            }
        )

    if field_name == "pas_place_of_birth":
        values.update(_RU_MIGRATION_COMMON_EXACT.keys())
        values.update(_RU_MIGRATION_PLACE_EXACT.keys())
        values.update(OCR_SAFE_REPAIR_ENGLISH_PLACE_VALUES)

    return {collapse_label_spaces(v).upper() for v in values if collapse_label_spaces(v)}


def get_dictionary_nearest_repair_candidates_for_field(
    *,
    field_name: str,
    text: str,
) -> list[dict[str, str]]:
    """
    Safe dictionary repair by edit distance <= N.

    Examples:
      UZBEKISTNAAN -> UZBEKISTAN  (distance 2)
      KASHKADARYA REGIQON -> KASHKADARYA REGION

    Applied only when the nearest candidate is unique.
    """

    if not OCR_SAFE_REPAIR_DICTIONARY_NEAREST:
        return []

    if field_name not in OCR_DICTIONARY_REPAIR_FIELD_NAMES:
        return []

    source = collapse_label_spaces(canonical_text_for_field_schema(field_name, text)).upper()
    source_norm = normalize_ocr_text_for_match(source)

    if len(source_norm) < 5:
        return []

    dictionary_values = get_dictionary_nearest_values_for_field(field_name)
    if not dictionary_values:
        return []

    normalized_to_display: dict[str, str] = {}
    for value in dictionary_values:
        norm = normalize_ocr_text_for_match(value)
        if not norm:
            continue
        # Prefer the first display form; duplicates are equivalent for repair.
        normalized_to_display.setdefault(norm, value)

    if source_norm in normalized_to_display:
        return []

    max_distance = max(1, int(OCR_DICTIONARY_NEAREST_MAX_DISTANCE))
    best_distance = max_distance + 1
    best_norms: list[str] = []

    for candidate_norm in normalized_to_display:
        distance = levenshtein_distance(
            source_norm,
            candidate_norm,
            max_distance=max_distance,
        )

        if distance > max_distance:
            continue

        if distance < best_distance:
            best_distance = distance
            best_norms = [candidate_norm]
        elif distance == best_distance:
            best_norms.append(candidate_norm)

    if len(best_norms) != 1:
        return []

    winner = normalized_to_display[best_norms[0]]
    return [
        {
            "text": winner,
            "reason": f"dictionary_nearest_distance_{best_distance}",
        }
    ]


def has_dictionary_nearest_repair_candidate(
    *,
    field_name: str,
    text: str,
) -> bool:
    return bool(
        get_dictionary_nearest_repair_candidates_for_field(
            field_name=field_name,
            text=text,
        )
    )


def get_safe_repair_candidates_for_field(
    *,
    doc_type: str,
    field_name: str,
    text: str,
) -> list[dict[str, str]]:
    """
    Возвращает все валидные repair-кандидаты.

    ВАЖНО: для строгих полей repair безопасен только если кандидат ровно один.
    Пример опасности:
      FK00055527 -> FK0055527  # удалить один 0
      FK00055527 -> FK0005527  # удалить одну 5
    Оба формально валидны как AA + 7 цифр, но правильный только второй.
    Поэтому multiple candidates => не правим автоматически, зовём GLM/оставляем suspicious.
    """

    if not OCR_SAFE_REPAIR_ENABLED:
        return []

    original_valid, _, original_canonical = validate_ocr_text_for_field(
        doc_type=doc_type,
        field_name=field_name,
        text=text,
    )

    # pas_authority — строгое поле: 3 латинские буквы + 5 цифр.
    # Если уже валидно, не пытаемся чинить.
    if original_valid and field_name == "pas_authority":
        return []

    allow_token_repair = should_allow_dictionary_token_repair(field_name)

    # Для строгих форматов валидное значение уже считаем безопасным.
    # Для словарных/token-level полей valid=True не всегда означает,
    # что текст семантически правильный.
    if (
        original_valid
        and field_name not in OCR_DICTIONARY_REPAIR_FIELD_NAMES
        and not allow_token_repair
    ):
        return []

    found: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(candidate: str, reason: str) -> None:
        candidate = canonical_text_for_field_schema(field_name, candidate)

        if candidate and candidate not in seen:
            found.append({"text": candidate, "reason": reason})
            seen.add(candidate)

    # Орган выдачи паспорта: 3 латинские буквы + 5 цифр.
    # Примеры:
    #   MIA 350000 -> MIA 35000
    #   MILA 10208 -> MIA 10208, только если MIA в allow-list.
    if field_name == "pas_authority":
        for candidate in get_pas_authority_repair_candidates(original_canonical):
            valid, _, canonical = validate_ocr_text_for_field(
                doc_type=doc_type,
                field_name=field_name,
                text=candidate["text"],
            )
            if valid:
                add(canonical, candidate["reason"])

    # Паспортный номер: AA + 7 цифр. Правим только если будет ровно один
    # валидный кандидат. Если кандидатов несколько — это неоднозначность.
    if field_name == "pas_number":
        for candidate in build_one_extra_repeat_candidates(original_canonical):
            candidate = normalize_numberish_for_schema(candidate)
            if PASSPORT_NUMBER_RE.fullmatch(candidate):
                add(candidate, "passport_number_one_extra_repeat")

    # Словарные поля: национальность/место рождения.
    # Здесь valid=True не гарантирует корректность: KARAKALPAKSSTAN формально
    # валидная строка, но семантически это один лишний повтор относительно
    # словарного KARAKALPAKSTAN. Поэтому разрешаем repair и для valid=True,
    # но только если текущее значение само НЕ является точным словарным и
    # кандидат после удаления одного повтора попадает в точный словарь.
    if field_name in OCR_DICTIONARY_REPAIR_FIELD_NAMES:
        if not is_safe_dictionary_value_for_field(
            field_name=field_name,
            text=original_canonical,
        ):
            for candidate in build_one_extra_repeat_candidates(original_canonical):
                if is_safe_dictionary_value_for_field(
                    field_name=field_name,
                    text=candidate,
                ):
                    add(candidate, "dictionary_one_extra_repeat")

    # Dictionary nearest repair catches non-repeat sequence errors in stable
    # dictionary fields, for example UZBEKISTNAAN -> UZBEKISTAN.
    if field_name in OCR_DICTIONARY_REPAIR_FIELD_NAMES:
        for candidate in get_dictionary_nearest_repair_candidates_for_field(
            field_name=field_name,
            text=original_canonical,
        ):
            valid, _, canonical = validate_ocr_text_for_field(
                doc_type=doc_type,
                field_name=field_name,
                text=candidate["text"],
            )
            if valid:
                add(canonical, candidate["reason"])

    # Token-level repair inside longer phrases. This fixes cases where the
    # whole phrase is not in an exact dictionary, but one administrative
    # token is clearly broken: REGIQON -> REGION. Unlike exact dictionary
    # repair, this is allowed for free-text fields too (for example if the
    # detector/OCR mapped the phrase to pas_authority or another text field).
    if allow_token_repair:
        phrase_candidate, phrase_reason, _ = try_safe_repair_dictionary_phrase_tokens(
            original_canonical
        )
        if phrase_candidate is not None and phrase_reason is not None:
            valid, _, canonical = validate_ocr_text_for_field(
                doc_type=doc_type,
                field_name=field_name,
                text=phrase_candidate,
            )
            if valid:
                add(canonical, phrase_reason)

    # Опционально: только тройные буквы в ФИО. По умолчанию выключено, потому
    # что лучше отдавать такие случаи в TTA/GLM, а не править имена regex'ом.
    if (
        OCR_SAFE_REPAIR_PERSON_TRIPLE
        and field_name in PERSON_NAME_FIELD_NAMES
        and has_suspicious_alpha_triple(original_canonical)
    ):
        candidate = re.sub(
            r"([A-Z])\1{2,}",
            r"\1\1",
            normalize_ocr_text_for_match(original_canonical),
        )
        valid, _, canonical = validate_ocr_text_for_field(
            doc_type=doc_type,
            field_name=field_name,
            text=candidate,
        )
        if valid:
            add(canonical, "person_name_triple_alpha_to_double")

    return found


def try_safe_repair_field_text(
    *,
    doc_type: str,
    field_name: str,
    text: str,
) -> tuple[str | None, str | None]:
    """
    Безопасный repair только там, где есть ровно один валидный кандидат.

    Если кандидатов несколько, repair считается НЕбезопасным:
    FK00055527 может стать и FK0055527, и FK0005527.
    В такой ситуации нужно TTA/GLM/ручная проверка, но не автозамена.
    """

    candidates = get_safe_repair_candidates_for_field(
        doc_type=doc_type,
        field_name=field_name,
        text=text,
    )

    if len(candidates) != 1:
        return None, None

    candidate = candidates[0]
    return candidate["text"], candidate["reason"]


def build_ocr_quality_report(
    *,
    doc_type: str,
    field_name: str,
    text: str,
    paddle_score: float | None = None,
) -> dict[str, Any]:
    valid, invalid_reason, canonical = validate_ocr_text_for_field(
        doc_type=doc_type,
        field_name=field_name,
        text=text,
    )

    flags: list[str] = []

    if paddle_score is not None and score_to_unit(float(paddle_score)) < GLM_FIELD_FALLBACK_THRESHOLD:
        flags.append("paddle_score_low")

    if not valid:
        flags.append("schema_invalid")

    if has_suspicious_alpha_triple(text):
        flags.append("suspicious_alpha_triple")

    if has_dictionary_one_extra_repeat_candidate(field_name=field_name, text=text):
        flags.append("dictionary_one_extra_repeat_candidate")

    if has_dictionary_token_repair_candidate(field_name=field_name, text=text):
        flags.append("dictionary_token_repair_candidate")

    if has_dictionary_nearest_repair_candidate(field_name=field_name, text=text):
        flags.append("dictionary_nearest_repair_candidate")

    repair_candidates = get_safe_repair_candidates_for_field(
        doc_type=doc_type,
        field_name=field_name,
        text=text,
    )
    repair_text = None
    repair_reason = None

    if len(repair_candidates) == 1:
        flags.append("safe_repair_available")
        repair_text = repair_candidates[0]["text"]
        repair_reason = repair_candidates[0]["reason"]
    elif len(repair_candidates) > 1:
        flags.append("safe_repair_ambiguous")
        repair_reason = "multiple_valid_one_extra_repeat_candidates"

    return {
        "enabled": bool(OCR_VERIFY_ENABLED),
        "text": text,
        "canonical_text": canonical,
        "normalized_text": normalize_ocr_text_for_match(canonical),
        "valid": bool(valid),
        "invalid_reason": invalid_reason,
        "flags": sorted(set(flags)),
        "repair_candidate": repair_text,
        "repair_candidates": repair_candidates,
        "repair_reason": repair_reason,
    }


def ocr_quality_needs_attention(report: dict[str, Any]) -> bool:
    if not OCR_VERIFY_ENABLED:
        return False

    attention_flags = {
        "paddle_score_low",
        "schema_invalid",
        "suspicious_alpha_triple",
        "dictionary_one_extra_repeat_candidate",
        "dictionary_token_repair_candidate",
        "dictionary_nearest_repair_candidate",
        "safe_repair_available",
        "safe_repair_ambiguous",
    }
    return bool(attention_flags & set(report.get("flags", [])))


def build_ocr_tta_prepared_variants(
    field_crop_bgr: np.ndarray,
    *,
    base_prepared_bgr: np.ndarray | None = None,
) -> list[dict[str, Any]]:
    variants: list[dict[str, Any]] = []

    if base_prepared_bgr is not None:
        variants.append(
            {
                "variant": "orig",
                "image": base_prepared_bgr,
                "settings": "already_prepared_default",
            }
        )

    # Мягкие варианты препроцесса. Не меняем геометрию сильно: цель — проверить,
    # не родил ли конкретный preprocess лишний штрих/лишний CTC-step.
    variant_configs = [
        {
            "variant": "no_bg_norm_soft_contrast",
            "normalize_background": False,
            "contrast_enhance": 1.10,
            "pad_x": OCR_PAD_X,
            "pad_y": OCR_PAD_Y,
            "grayscale": True,
        },
        {
            "variant": "bg_norm_soft_contrast",
            "normalize_background": True,
            "contrast_enhance": 1.10,
            "pad_x": OCR_PAD_X,
            "pad_y": OCR_PAD_Y,
            "grayscale": True,
        },
        {
            "variant": "bg_norm_strong_contrast",
            "normalize_background": True,
            "contrast_enhance": 1.35,
            "pad_x": OCR_PAD_X,
            "pad_y": OCR_PAD_Y,
            "grayscale": True,
        },
        {
            "variant": "less_padding_no_bg_norm",
            "normalize_background": False,
            "contrast_enhance": 1.15,
            "pad_x": max(1, OCR_PAD_X // 2),
            "pad_y": max(1, OCR_PAD_Y // 2),
            "grayscale": True,
        },
    ]

    used_names = {str(v["variant"]) for v in variants}
    for cfg in variant_configs:
        if len(variants) >= max(1, OCR_TTA_MAX_VARIANTS):
            break
        if cfg["variant"] in used_names:
            continue

        prepared = prepare_ocr_image_array(
            field_crop_bgr,
            pad_x=int(cfg["pad_x"]),
            pad_y=int(cfg["pad_y"]),
            grayscale=bool(cfg["grayscale"]),
            normalize_background=bool(cfg["normalize_background"]),
            contrast_enhance=float(cfg["contrast_enhance"]),
        )
        variants.append(
            {
                "variant": cfg["variant"],
                "image": prepared,
                "settings": {
                    k: v
                    for k, v in cfg.items()
                    if k != "variant"
                },
            }
        )

    return variants[:max(1, OCR_TTA_MAX_VARIANTS)]


def choose_ocr_tta_winner(
    *,
    doc_type: str,
    field_name: str,
    results: list[dict[str, Any]],
    current_text: str,
) -> dict[str, Any]:
    non_empty = [r for r in results if normalize_ocr_text_for_match(str(r.get("text", "")))]
    if not non_empty:
        return {
            "accepted": False,
            "reason": "no_non_empty_tta_results",
            "winner_text": None,
            "winner_score": 0.0,
            "winner_count": 0,
        }

    grouped: dict[str, list[dict[str, Any]]] = {}
    for result in non_empty:
        canonical = canonical_text_for_field_schema(field_name, str(result.get("text", "")))
        norm = normalize_ocr_text_for_match(canonical)
        grouped.setdefault(norm, []).append({**result, "canonical_text": canonical})

    def group_rank(item: tuple[str, list[dict[str, Any]]]) -> tuple[int, float, float]:
        _, rows = item
        scores = [float(r.get("score", 0.0)) for r in rows]
        return (
            len(rows),
            float(np.mean(scores)) if scores else 0.0,
            max(scores) if scores else 0.0,
        )

    winner_norm, winner_rows = max(grouped.items(), key=group_rank)
    winner_counter = Counter(str(r["canonical_text"]) for r in winner_rows)
    winner_text = winner_counter.most_common(1)[0][0]
    winner_score = max(float(r.get("score", 0.0)) for r in winner_rows)
    winner_count = len(winner_rows)

    current_norm = normalize_ocr_text_for_match(
        canonical_text_for_field_schema(field_name, current_text)
    )
    winner_valid, winner_invalid_reason, winner_canonical = validate_ocr_text_for_field(
        doc_type=doc_type,
        field_name=field_name,
        text=winner_text,
    )
    current_valid, _, _ = validate_ocr_text_for_field(
        doc_type=doc_type,
        field_name=field_name,
        text=current_text,
    )

    accepted = False
    reason = "winner_is_current"

    if winner_norm != current_norm:
        if winner_count >= max(1, OCR_TTA_MIN_MAJORITY) and winner_valid:
            accepted = True
            reason = "tta_majority_valid"
        elif not current_valid and winner_valid:
            accepted = True
            reason = "tta_valid_candidate_over_invalid_current"
        else:
            reason = winner_invalid_reason or "tta_no_safe_majority"

    return {
        "accepted": bool(accepted),
        "reason": reason,
        "winner_text": winner_canonical if winner_valid else winner_text,
        "winner_score": winner_score,
        "winner_count": winner_count,
        "winner_valid": bool(winner_valid),
        "winner_invalid_reason": winner_invalid_reason,
        "groups": [
            {
                "normalized": norm,
                "count": len(rows),
                "texts": sorted({str(r.get("canonical_text", r.get("text", ""))) for r in rows}),
                "max_score": max(float(r.get("score", 0.0)) for r in rows),
            }
            for norm, rows in sorted(grouped.items(), key=group_rank, reverse=True)
        ],
    }


def recognize_field_text_tta(
    *,
    doc_type: str,
    field_name: str,
    field_crop_bgr: np.ndarray,
    base_prepared_bgr: np.ndarray | None,
    base_text: str,
    base_score: float,
) -> dict[str, Any]:
    started = time.perf_counter()
    preprocess_seconds = 0.0
    paddle_seconds = 0.0
    results: list[dict[str, Any]] = []

    if field_name in SKIP_OCR_FIELDS:
        return {
            "enabled": False,
            "reason": "skipped_field",
            "accepted": False,
            "results": [],
            "seconds": 0.0,
        }

    variants_started = time.perf_counter()
    variants = build_ocr_tta_prepared_variants(
        field_crop_bgr,
        base_prepared_bgr=base_prepared_bgr,
    )
    preprocess_seconds += elapsed_seconds(variants_started)

    for variant in variants:
        variant_name = str(variant.get("variant", "variant"))

        if variant_name == "orig" and base_text is not None:
            results.append(
                {
                    "variant": variant_name,
                    "text": str(base_text),
                    "score": score_to_unit(float(base_score)),
                    "used_existing_result": True,
                }
            )
            continue

        paddle_started = time.perf_counter()
        text, score = recognize_prepared_image_with_paddle(
            doc_type,
            variant["image"],
        )
        paddle_seconds += elapsed_seconds(paddle_started)
        results.append(
            {
                "variant": variant_name,
                "text": text,
                "score": score_to_unit(float(score)),
                "used_existing_result": False,
            }
        )

    winner = choose_ocr_tta_winner(
        doc_type=doc_type,
        field_name=field_name,
        results=results,
        current_text=base_text,
    )

    return {
        "enabled": True,
        "accepted": bool(winner.get("accepted")),
        "reason": winner.get("reason"),
        "winner_text": winner.get("winner_text"),
        "winner_score": winner.get("winner_score"),
        "winner_count": winner.get("winner_count"),
        "winner_valid": winner.get("winner_valid"),
        "winner_invalid_reason": winner.get("winner_invalid_reason"),
        "groups": winner.get("groups", []),
        "results": results,
        "variants_count": len(variants),
        "preprocess_seconds": preprocess_seconds,
        "paddle_seconds": paddle_seconds,
        "seconds": elapsed_seconds(started),
    }


def ensure_item_quality(item: dict[str, Any], doc_type: str) -> dict[str, Any]:
    quality = item.get("quality")
    if not isinstance(quality, dict):
        quality = {}
        item["quality"] = quality

    report = build_ocr_quality_report(
        doc_type=doc_type,
        field_name=item["field_name"],
        text=item.get("final_text", ""),
        paddle_score=float(item.get("paddle_score", 0.0)),
    )
    quality["current"] = report
    return quality


def append_quality_event(item: dict[str, Any], event: dict[str, Any]) -> None:
    quality = item.setdefault("quality", {})
    events = quality.setdefault("events", [])
    events.append(event)


def apply_safe_repair_to_item(
    *,
    item: dict[str, Any],
    doc_type: str,
) -> bool:
    field_name = item["field_name"]
    repair_text, repair_reason = try_safe_repair_field_text(
        doc_type=doc_type,
        field_name=field_name,
        text=item.get("final_text", ""),
    )

    if repair_text is None:
        return False

    before = item.get("final_text", "")
    item["final_text"] = repair_text
    item["source"] = "safe_repair"
    append_quality_event(
        item,
        {
            "action": "safe_repair_applied",
            "reason": repair_reason,
            "before": before,
            "after": repair_text,
        },
    )
    ensure_item_quality(item, doc_type)
    return True


def apply_tta_to_item(
    *,
    item: dict[str, Any],
    doc_type: str,
) -> bool:
    if not OCR_TTA_ENABLED:
        return False

    tta_started = time.perf_counter()
    tta_result = recognize_field_text_tta(
        doc_type=doc_type,
        field_name=item["field_name"],
        field_crop_bgr=item["field_crop"],
        base_prepared_bgr=item.get("field_crop_prepared"),
        base_text=str(item.get("final_text", item.get("paddle_text", ""))),
        base_score=float(item.get("paddle_score", 0.0)),
    )
    item["tta"] = tta_result
    item["timing"]["tta_seconds"] = elapsed_seconds(tta_started)
    item["timing"]["tta_preprocess_seconds"] = float(tta_result.get("preprocess_seconds", 0.0))
    item["timing"]["tta_paddle_seconds"] = float(tta_result.get("paddle_seconds", 0.0))
    item["timing"]["tta_variants_count"] = int(tta_result.get("variants_count", 0))

    if not tta_result.get("accepted") or not tta_result.get("winner_text"):
        append_quality_event(
            item,
            {
                "action": "tta_checked",
                "accepted": False,
                "reason": tta_result.get("reason"),
            },
        )
        return False

    before = item.get("final_text", "")
    item["final_text"] = str(tta_result["winner_text"])
    item["source"] = "paddle_tta"
    append_quality_event(
        item,
        {
            "action": "tta_applied",
            "reason": tta_result.get("reason"),
            "before": before,
            "after": item["final_text"],
            "winner_count": tta_result.get("winner_count"),
            "winner_score": tta_result.get("winner_score"),
        },
    )
    ensure_item_quality(item, doc_type)
    return True


def should_accept_glm_text_for_field(
    *,
    doc_type: str,
    field_name: str,
    glm_text: str,
) -> tuple[str | None, str | None]:
    label, reject_reason = validate_glm_label_for_field(
        doc_type=doc_type,
        field_name=field_name,
        glm_text=glm_text,
    )
    if reject_reason is not None or label is None:
        return None, reject_reason or "invalid_glm_label"

    if OCR_ACCEPT_GLM_ONLY_IF_VALID:
        valid, invalid_reason, canonical = validate_ocr_text_for_field(
            doc_type=doc_type,
            field_name=field_name,
            text=label,
        )
        if not valid and field_name in STRICT_FORMAT_FIELD_NAMES:
            return None, invalid_reason or "invalid_glm_schema"
        return canonical if valid else label, None

    return label, None


def apply_glm_text_to_item(
    *,
    item: dict[str, Any],
    doc_type: str,
    glm_text: str | None,
    source: str,
) -> bool:
    item["glm_text"] = glm_text or ""

    if not glm_text:
        item["source"] = "paddle_glm_empty"
        append_quality_event(
            item,
            {
                "action": "glm_checked",
                "accepted": False,
                "reason": "empty_glm_text",
                "source": source,
            },
        )
        return False

    accepted_text, reject_reason = should_accept_glm_text_for_field(
        doc_type=doc_type,
        field_name=item["field_name"],
        glm_text=glm_text,
    )

    if accepted_text is None:
        item["source"] = "paddle_glm_invalid"
        append_quality_event(
            item,
            {
                "action": "glm_checked",
                "accepted": False,
                "reason": reject_reason,
                "source": source,
                "glm_text": glm_text,
            },
        )
        return False

    before = item.get("final_text", "")
    item["final_text"] = accepted_text
    item["source"] = source
    append_quality_event(
        item,
        {
            "action": "glm_applied",
            "source": source,
            "before": before,
            "after": accepted_text,
            "glm_text": glm_text,
        },
    )
    ensure_item_quality(item, doc_type)
    return True


def apply_quality_verification_to_item(
    *,
    item: dict[str, Any],
    doc_type: str,
) -> bool:
    """
    Production decision layer:
      Paddle -> quality flags -> TTA -> safe repair -> GLM fallback.
    Возвращает True, если итоговое значение изменилось.
    """

    if not OCR_VERIFY_ENABLED or item["field_name"] in SKIP_OCR_FIELDS:
        return False

    changed = False
    before_all = item.get("final_text", "")

    quality = ensure_item_quality(item, doc_type)
    initial_report = quality.get("current", {})

    if not ocr_quality_needs_attention(initial_report):
        append_quality_event(
            item,
            {
                "action": "quality_fast_path",
                "reason": "no_attention_flags",
            },
        )
        return False

    # 1. Safe repair сначала: он дешёвый и словарно/схемно ограниченный.
    # Это ускоряет production-путь: KARAKALPAKSSTAN/UZBEKISTNAAN исправятся
    # без дополнительных Paddle TTA-прогонов и без GLM.
    if apply_safe_repair_to_item(item=item, doc_type=doc_type):
        changed = True

    current_report = ensure_item_quality(item, doc_type).get("current", {})
    if not ocr_quality_needs_attention(current_report):
        append_quality_event(
            item,
            {
                "action": "quality_resolved_by_safe_repair",
                "before": before_all,
                "after": item.get("final_text", ""),
            },
        )
        return changed or before_all != item.get("final_text", "")

    # 2. TTA: несколько мягких препроцессов и голосование самой PaddleOCR-модели.
    if apply_tta_to_item(item=item, doc_type=doc_type):
        changed = True

    # 3. После TTA повторяем safe repair: TTA может дать новый кандидат,
    # который уже однозначно ремонтируется словарём/схемой.
    if apply_safe_repair_to_item(item=item, doc_type=doc_type):
        changed = True

    current_report = ensure_item_quality(item, doc_type).get("current", {})
    if not ocr_quality_needs_attention(current_report):
        append_quality_event(
            item,
            {
                "action": "quality_resolved_without_glm",
                "before": before_all,
                "after": item.get("final_text", ""),
            },
        )
        return changed or before_all != item.get("final_text", "")

    # 4. GLM fallback не только по low score, но и по quality-флагам.
    if OCR_GLM_ON_QUALITY_FLAGS:
        glm_started = time.perf_counter()
        try:
            # Для GLM/VLM лучше RAW crop: prepared 48px полезен PaddleOCR,
            # но может убивать мелкие визуальные различия между 00055 и 00555.
            glm_input = item["field_crop"]

            glm_text = glm_ocr_field(
                doc_type=doc_type,
                field_name=item["field_name"],
                field_crop_bgr=glm_input,
            )
            item["timing"]["glm_ocr_seconds"] = round(
                float(item["timing"].get("glm_ocr_seconds", 0.0))
                + elapsed_seconds(glm_started),
                6,
            )
            item["timing"]["glm_ocr_scope"] = "field_quality"
            changed = apply_glm_text_to_item(
                item=item,
                doc_type=doc_type,
                glm_text=glm_text,
                source="glm_quality",
            ) or changed

        except Exception as exc:
            item["timing"]["glm_ocr_seconds"] = round(
                float(item["timing"].get("glm_ocr_seconds", 0.0))
                + elapsed_seconds(glm_started),
                6,
            )
            item["timing"]["glm_ocr_scope"] = "field_quality"
            item["glm_error"] = str(exc)
            append_quality_event(
                item,
                {
                    "action": "glm_failed",
                    "source": "glm_quality",
                    "error": str(exc),
                },
            )

    ensure_item_quality(item, doc_type)
    return changed or before_all != item.get("final_text", "")
