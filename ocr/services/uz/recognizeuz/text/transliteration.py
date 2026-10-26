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

_UZ_APOSTROPHES = "ʻʼ‘’`´ʹ'"

_UZ_LATIN_TO_RUSSIAN_CYRILLIC_SINGLE = {
    "a": "а",
    "b": "б",
    "c": "с",
    "d": "д",
    "e": "е",
    "f": "ф",
    "g": "г",
    # Для миграционной карты нужен русский вариант, без узбекской Ҳ.
    "h": "х",
    "i": "и",
    # В русской записи узбекских ФИО J чаще выглядит как ДЖ:
    # JASUR -> ДЖАСУР, JURAEV -> ДЖУРАЕВ.
    "j": "дж",
    "k": "к",
    "l": "л",
    "m": "м",
    "n": "н",
    "o": "о",
    "p": "п",
    # В русской миграционной записи не используем Қ.
    "q": "к",
    "r": "р",
    "s": "с",
    "t": "т",
    "u": "у",
    "v": "в",
    "w": "в",
    "x": "х",
    "y": "й",
    "z": "з",
}

_RUSSIAN_CYRILLIC_VOWELS = set("аеёиоуыэюяАЕЁИОУЫЭЮЯ")

_RU_MIGRATION_COMMON_EXACT = {
    # Страна / республика
    "UZBEKISTAN": "УЗБЕКИСТАН",
    "O'ZBEKISTON": "УЗБЕКИСТАН",
    "OZBEKISTON": "УЗБЕКИСТАН",
    "UZB": "УЗБЕКИСТАН",

    # Города / области / регионы Узбекистана
    "TOSHKENT": "ТАШКЕНТ",
    "TASHKENT": "ТАШКЕНТ",
    "SAMARQAND": "САМАРКАНД",
    "SAMARKAND": "САМАРКАНД",
    "BUXORO": "БУХАРА",
    "BUKHARA": "БУХАРА",
    "ANDIJON": "АНДИЖАН",
    "ANDIZHAN": "АНДИЖАН",
    "FARG'ONA": "ФЕРГАНА",
    "FARGONA": "ФЕРГАНА",
    "FERGANA": "ФЕРГАНА",
    "NAMANGAN": "НАМАНГАН",
    "JIZZAX": "ДЖИЗАК",
    "JIZZAKH": "ДЖИЗАК",
    "NAVOIY": "НАВОИ",
    "NAVOI": "НАВОИ",
    "NUKUS": "НУКУС",
    "QARSHI": "КАРШИ",
    "KARSHI": "КАРШИ",
    "TERMIZ": "ТЕРМЕЗ",
    "TERMEZ": "ТЕРМЕЗ",
    "URGANCH": "УРГЕНЧ",
    "URGENCH": "УРГЕНЧ",
    "GULISTON": "ГУЛИСТАН",
    "GULISTAN": "ГУЛИСТАН",
    "ANGREN": "АНГРЕН",
    "OLMALIQ": "АЛМАЛЫК",
    "ALMALYK": "АЛМАЛЫК",
    "QO'QON": "КОКАНД",
    "QOQON": "КОКАНД",
    "KOKAND": "КОКАНД",
    "CHIRCHIQ": "ЧИРЧИК",
    "CHIRCHIK": "ЧИРЧИК",
    "MARG'ILON": "МАРГИЛАН",
    "MARGILON": "МАРГИЛАН",
    "SHAHRISABZ": "ШАХРИСАБЗ",
    "ZARAFSHON": "ЗАРАФШАН",
    "ZARAFSHAN": "ЗАРАФШАН",
    "DENOV": "ДЕНАУ",
    "DENAU": "ДЕНАУ",
    "BEKOBOD": "БЕКАБАД",
    "BEKABAD": "БЕКАБАД",
    "KATTAQO'RG'ON": "КАТТАКУРГАН",
    "KATTAQORGON": "КАТТАКУРГАН",
    "KATTAKURGAN": "КАТТАКУРГАН",
    "QASHQADARYO": "КАШКАДАРЬЯ",
    "KASHKADARYA": "КАШКАДАРЬЯ",
    "SURXONDARYO": "СУРХАНДАРЬЯ",
    "SURKHANDARYA": "СУРХАНДАРЬЯ",
    "SIRDARYO": "СЫРДАРЬЯ",
    "SYRDARYA": "СЫРДАРЬЯ",
    "XORAZM": "ХОРЕЗМ",
    "KHOREZM": "ХОРЕЗМ",
    "QORAQALPOG'ISTON": "КАРАКАЛПАКСТАН",
    "QORAQALPOGISTON": "КАРАКАЛПАКСТАН",
    "KARAKALPAKSTAN": "КАРАКАЛПАКСТАН",
}

_RU_MIGRATION_PLACE_EXACT = {
    **_RU_MIGRATION_COMMON_EXACT,

    # Области. В документах РФ обычно пишут русскую традиционную форму.
    "TOSHKENT VILOYATI": "ТАШКЕНТСКАЯ ОБЛАСТЬ",
    "TASHKENT VILOYATI": "ТАШКЕНТСКАЯ ОБЛАСТЬ",
    "SAMARQAND VILOYATI": "САМАРКАНДСКАЯ ОБЛАСТЬ",
    "SAMARKAND VILOYATI": "САМАРКАНДСКАЯ ОБЛАСТЬ",
    "BUXORO VILOYATI": "БУХАРСКАЯ ОБЛАСТЬ",
    "BUKHARA VILOYATI": "БУХАРСКАЯ ОБЛАСТЬ",
    "ANDIJON VILOYATI": "АНДИЖАНСКАЯ ОБЛАСТЬ",
    "ANDIZHAN VILOYATI": "АНДИЖАНСКАЯ ОБЛАСТЬ",
    "FARG'ONA VILOYATI": "ФЕРГАНСКАЯ ОБЛАСТЬ",
    "FARGONA VILOYATI": "ФЕРГАНСКАЯ ОБЛАСТЬ",
    "FERGANA VILOYATI": "ФЕРГАНСКАЯ ОБЛАСТЬ",
    "NAMANGAN VILOYATI": "НАМАНГАНСКАЯ ОБЛАСТЬ",
    "JIZZAX VILOYATI": "ДЖИЗАКСКАЯ ОБЛАСТЬ",
    "JIZZAKH VILOYATI": "ДЖИЗАКСКАЯ ОБЛАСТЬ",
    "NAVOIY VILOYATI": "НАВОИЙСКАЯ ОБЛАСТЬ",
    "NAVOI VILOYATI": "НАВОИЙСКАЯ ОБЛАСТЬ",
    "QASHQADARYO VILOYATI": "КАШКАДАРЬИНСКАЯ ОБЛАСТЬ",
    "KASHKADARYA VILOYATI": "КАШКАДАРЬИНСКАЯ ОБЛАСТЬ",
    "SURXONDARYO VILOYATI": "СУРХАНДАРЬИНСКАЯ ОБЛАСТЬ",
    "SURKHANDARYA VILOYATI": "СУРХАНДАРЬИНСКАЯ ОБЛАСТЬ",
    "SIRDARYO VILOYATI": "СЫРДАРЬИНСКАЯ ОБЛАСТЬ",
    "SYRDARYA VILOYATI": "СЫРДАРЬИНСКАЯ ОБЛАСТЬ",
    "XORAZM VILOYATI": "ХОРЕЗМСКАЯ ОБЛАСТЬ",
    "KHOREZM VILOYATI": "ХОРЕЗМСКАЯ ОБЛАСТЬ",

    # Республика Каракалпакстан.
    "QORAQALPOG'ISTON RESPUBLIKASI": "РЕСПУБЛИКА КАРАКАЛПАКСТАН",
    "QORAQALPOGISTON RESPUBLIKASI": "РЕСПУБЛИКА КАРАКАЛПАКСТАН",
    "KARAKALPAKSTAN RESPUBLIKASI": "РЕСПУБЛИКА КАРАКАЛПАКСТАН",

    # Город Ташкент.
    "TOSHKENT SHAHRI": "Г. ТАШКЕНТ",
    "TASHKENT SHAHRI": "Г. ТАШКЕНТ",
    "TOSHKENT SH": "Г. ТАШКЕНТ",
    "TASHKENT SH": "Г. ТАШКЕНТ",
    "TOSHKENT CITY": "Г. ТАШКЕНТ",
    "TASHKENT CITY": "Г. ТАШКЕНТ",
}

_RU_MIGRATION_NATIONALITY_EXACT = {
    # Национальность / гражданство в русской форме.
    "O'ZBEK": "УЗБЕК",
    "OZBEK": "УЗБЕК",
    "UZBEK": "УЗБЕК",
    "O'ZBEKISTON": "УЗБЕКИСТАН",
    "OZBEKISTON": "УЗБЕКИСТАН",
    "UZBEKISTAN": "УЗБЕКИСТАН",
    "TOJIK": "ТАДЖИК",
    "TAJIK": "ТАДЖИК",
    "QIRG'IZ": "КИРГИЗ",
    "QIRGIZ": "КИРГИЗ",
    "KYRGYZ": "КИРГИЗ",
    "QOZOQ": "КАЗАХ",
    "QAZAQ": "КАЗАХ",
    "KAZAKH": "КАЗАХ",
    "TURKMAN": "ТУРКМЕН",
    "RUS": "РУССКИЙ",
    "RUSSIAN": "РУССКИЙ",
    "QORAQALPOQ": "КАРАКАЛПАК",
    "QORAQALPOG'": "КАРАКАЛПАК",
    "QORAQALPOG": "КАРАКАЛПАК",
    "KARAKALPAK": "КАРАКАЛПАК",
}

_RU_MIGRATION_FIELD_EXACT_OVERRIDES = {
    "pas_place_of_birth": _RU_MIGRATION_PLACE_EXACT,
    "pas_nationality": _RU_MIGRATION_NATIONALITY_EXACT,
    "mg_nationality": _RU_MIGRATION_NATIONALITY_EXACT,
}

_RU_MIGRATION_CYRILLIC_PHRASE_REPLACEMENTS = {
    "ТОШКЕНТ": "ТАШКЕНТ",
    "ТОШКЕНТСКАЯ": "ТАШКЕНТСКАЯ",
    "САМАРКАНД": "САМАРКАНД",
    "БУХОРО": "БУХАРА",
    "АНДИЖОН": "АНДИЖАН",
    "ФАРГОНА": "ФЕРГАНА",
    "ДЖИЗЗАХ": "ДЖИЗАК",
    "НАВОИЙ": "НАВОИ",
    "КАШКАДАРЁ": "КАШКАДАРЬЯ",
    "КАШКАДАРЙО": "КАШКАДАРЬЯ",
    "СУРХОНДАРЁ": "СУРХАНДАРЬЯ",
    "СУРХОНДАРЙО": "СУРХАНДАРЬЯ",
    "СИРДАРЁ": "СЫРДАРЬЯ",
    "СИРДАРЙО": "СЫРДАРЬЯ",
    "ХОРАЗМ": "ХОРЕЗМ",
    "КОРАКАЛПОГИСТОН": "КАРАКАЛПАКСТАН",
    "КОРАКАЛПОК": "КАРАКАЛПАК",
    "КОКОН": "КОКАНД",
    "МАРГИЛОН": "МАРГИЛАН",
    "ЗАРАФШОН": "ЗАРАФШАН",
    "БЕКОБОД": "БЕКАБАД",
    "КАТТАКОРГОН": "КАТТАКУРГАН",
    "ТЕРМИЗ": "ТЕРМЕЗ",
    "ЯНГИЮЛ": "ЯНГИЮЛЬ",
    "ЯНГИЙУЛ": "ЯНГИЮЛЬ",
    "ВИЛОЯТИ": "ОБЛАСТЬ",
    "ТУМАНИ": "РАЙОН",
    "ШАХРИ": "Г.",
    "РЕСПУБЛИКАСИ": "РЕСПУБЛИКА",
}

_UZ_LATIN_TO_RUSSIAN_CYRILLIC_TRIPLETS = {
    "yo'": "ю",
}

_UZ_LATIN_TO_RUSSIAN_CYRILLIC_PAIRS = {
    # Passport / MRZ-style Latin variants.
    "kh": "х",  # KHUDAYBERGENOV -> ХУДАЙБЕРГЕНОВ, not КХ...
    "zh": "ж",
    "dj": "дж",

    # Uzbek/common digraphs.
    "sh": "ш",
    "ch": "ч",

    # Iotated vowels / common transliteration pairs.
    "yo": "йо",
    "yu": "ю",
    "ya": "я",
    "ye": "е",
    "ts": "ц",
}

def _migration_dictionary_key(text: str) -> str:
    key = unicodedata.normalize("NFKC", str(text)).strip().upper()

    for apostrophe in _UZ_APOSTROPHES:
        key = key.replace(apostrophe, "'")

    # Убираем мусор OCR, но оставляем апостроф, потому что O' / G' значимы.
    key = key.replace("–", "-").replace("—", "-")
    key = re.sub(r"[.,;:()\[\]{}\"“”]+", " ", key)
    key = re.sub(r"[-_/]+", " ", key)
    key = re.sub(r"\s+", " ", key).strip()

    # Частые сокращения из адресных строк.
    key = re.sub(r"\bVIL\b", "VILOYATI", key)
    key = re.sub(r"\bTUM\b", "TUMANI", key)
    key = re.sub(r"\bRESP\b", "RESPUBLIKASI", key)

    return key

def _apply_dictionary_text_case(src: str, dst: str) -> str:
    letters = [ch for ch in src if ch.isalpha()]

    if letters and all(ch.isupper() for ch in letters):
        return dst.upper()

    if src[:1].isupper() and not src.isupper():
        # Для "Toshkent" вернём "Ташкент", но аббревиатуры типа "Г."
        # останутся корректными через title() не всегда, поэтому обрабатываем
        # только простые строки без точки.
        if "." not in dst:
            return dst.title()

    return dst

def _lookup_russian_migration_dictionary(
    text: str,
    *,
    field_name: str | None = None,
) -> str | None:
    key = _migration_dictionary_key(text)

    if not key:
        return None

    if field_name:
        field_dict = _RU_MIGRATION_FIELD_EXACT_OVERRIDES.get(field_name)
        if field_dict and key in field_dict:
            return _apply_dictionary_text_case(text, field_dict[key])

    if key in _RU_MIGRATION_COMMON_EXACT:
        return _apply_dictionary_text_case(text, _RU_MIGRATION_COMMON_EXACT[key])

    return None

def _normalize_latin_migration_text_for_replacements(text: str) -> str:
    result = unicodedata.normalize("NFKC", str(text))

    for apostrophe in _UZ_APOSTROPHES:
        result = result.replace(apostrophe, "'")

    # Приводим частые сокращения к полной форме, чтобы словарь сработал
    # и на "TOSHKENT VIL." / "TOSHKENT SH.".
    result = re.sub(r"\bVIL\.", "VILOYATI", result, flags=re.IGNORECASE)
    result = re.sub(r"\bTUM\.", "TUMANI", result, flags=re.IGNORECASE)
    result = re.sub(r"\bRESP\.", "RESPUBLIKASI", result, flags=re.IGNORECASE)
    result = re.sub(r"\bSH\.", "SHAHRI", result, flags=re.IGNORECASE)

    return result

def _latin_dictionary_pattern(key: str) -> str:
    escaped_parts = [re.escape(part) for part in key.split()]
    body = r"\s+".join(escaped_parts)
    return rf"(?<![A-Za-z0-9']){body}(?![A-Za-z0-9'])"

def _apply_latin_migration_phrase_replacements(
    text: str,
    *,
    field_name: str | None = None,
) -> str:
    """
    Заменяет известные латинские фразы до посимвольной транслитерации.
    Это позволяет нормально обработать длинные строки:
      TOSHKENT VILOYATI YANGIYUL TUMANI
      -> ТАШКЕНТСКАЯ ОБЛАСТЬ ЯНГИЮЛЬ РАЙОН
    """

    result = _normalize_latin_migration_text_for_replacements(text)

    replacement_dicts: list[dict[str, str]] = []

    if field_name:
        field_dict = _RU_MIGRATION_FIELD_EXACT_OVERRIDES.get(field_name)
        if field_dict:
            replacement_dicts.append(field_dict)

    replacement_dicts.append(_RU_MIGRATION_COMMON_EXACT)

    seen: set[str] = set()
    replacements: list[tuple[str, str]] = []

    for dictionary in replacement_dicts:
        for key, value in dictionary.items():
            if key in seen:
                continue
            seen.add(key)
            replacements.append((key, value))

    for key, value in sorted(
        replacements,
        key=lambda item: len(item[0]),
        reverse=True,
    ):
        result = re.sub(
            _latin_dictionary_pattern(key),
            value,
            result,
            flags=re.IGNORECASE,
        )

    return result

def _apply_russian_migration_post_replacements(text: str) -> str:
    result = text

    for src, dst in sorted(
        _RU_MIGRATION_CYRILLIC_PHRASE_REPLACEMENTS.items(),
        key=lambda item: len(item[0]),
        reverse=True,
    ):
        pattern = rf"(?<!\w){re.escape(src)}(?!\w)"
        result = re.sub(pattern, dst, result, flags=re.IGNORECASE)

    return result

def _apply_case(src: str, dst: str) -> str:
    if src.isupper():
        return dst.upper()

    if len(src) > 1 and src[0].isupper():
        return dst[:1].upper() + dst[1:]

    return dst

def _is_word_start(src: str, index: int) -> bool:
    j = index - 1

    while j >= 0:
        ch = src[j]

        if ch.isspace() or ch in "-_/.,;:()[]{}\"'":
            return True

        if ch.isalnum():
            return False

        j -= 1

    return True

def transliterate_uz_latin_to_russian_cyrillic(text: str) -> str:
    """
    Узбекская латиница -> русская кириллица для формы, похожей на
    миграционную карту РФ.

    Это не узбекская кириллица. Специально не используем Қ/Ғ/Ў/Ҳ:
      Q -> К
      G' -> Г
      O' -> У
      H -> Х
      X -> Х
      J -> ДЖ

    Для ФИО этого обычно достаточно. Для населённых пунктов идеального
    алгоритма нет: TOSHKENT формально даст ТОШКЕНТ, а в русском документе
    часто нужен традиционный вариант ТАШКЕНТ. Такие случаи лучше закрывать
    отдельным словарём нормализации поверх этой функции.
    """

    if not text:
        return ""

    src = text
    for apostrophe in _UZ_APOSTROPHES:
        src = src.replace(apostrophe, "'")

    out: list[str] = []
    i = 0

    while i < len(src):
        ch = src[i]
        low = ch.lower()

        # O' / G' в российской миграционной записи не должны становиться
        # Ў / Ғ. Используем приближённую русскую запись.
        if (
            i + 1 < len(src)
            and src[i + 1] == "'"
            and low in {"o", "g"}
        ):
            repl = "у" if low == "o" else "г"
            out.append(_apply_case(ch, repl))
            i += 2
            continue

        if i + 2 < len(src):
            triplet = src[i:i + 3]
            triplet_low = triplet.lower()

            repl = _UZ_LATIN_TO_RUSSIAN_CYRILLIC_TRIPLETS.get(triplet_low)
            if repl is not None:
                out.append(_apply_case(triplet, repl))
                i += 3
                continue

        if i + 1 < len(src):
            pair = src[i:i + 2]
            pair_low = pair.lower()

            repl = _UZ_LATIN_TO_RUSSIAN_CYRILLIC_PAIRS.get(pair_low)
            if repl is not None:
                out.append(_apply_case(pair, repl))
                i += 2
                continue

        if low == "e" and _is_word_start(src, i):
            out.append(_apply_case(ch, "э"))
            i += 1
            continue

        repl = _UZ_LATIN_TO_RUSSIAN_CYRILLIC_SINGLE.get(low)
        if repl is None:
            out.append(ch)
        else:
            out.append(_apply_case(ch, repl))

        i += 1

    return "".join(out)

def transliterate_uz_latin_to_russian_migration_cyrillic(
    text: str,
    *,
    field_name: str | None = None,
) -> str:
    """
    Узбекская латиница -> русская кириллица в стиле миграционной карты РФ.

    Порядок:
      1. точное совпадение по полевому словарю;
      2. точное совпадение по общему словарю;
      3. алгоритмическая транслитерация;
      4. пост-замены традиционных русских форм внутри длинной строки.
    """

    dictionary_value = _lookup_russian_migration_dictionary(
        text,
        field_name=field_name,
    )

    if dictionary_value is not None:
        return dictionary_value

    preprocessed = _apply_latin_migration_phrase_replacements(
        text,
        field_name=field_name,
    )
    transliterated = transliterate_uz_latin_to_russian_cyrillic(preprocessed)
    return _apply_russian_migration_post_replacements(transliterated)

def transliterate_uz_latin_to_cyrillic(text: str) -> str:
    return transliterate_uz_latin_to_russian_migration_cyrillic(text)
