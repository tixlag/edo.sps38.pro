from __future__ import annotations

from pathlib import Path
from typing import Any
import argparse
import csv
import html
import json
import re
import shutil
import statistics

from paddleocr import TextRecognition


PROJECT_ROOT = Path("/home/neuro/PycharmProjects/RecognizeUZ")

PASSPORT_DATASET = PROJECT_ROOT / "paddleocr_passport_rec"
MIGRATION_DATASET = PROJECT_ROOT / "paddleocr_migration_rec"

OUT_DIR = PROJECT_ROOT / "pretrained_ocr_eval"

TARGET_HEIGHT = 48
MAX_WIDTH = 768

USE_GPU = True
DEVICE_ID = 0


PASSPORT_MODEL_NAME = "latin_PP-OCRv5_mobile_rec"

# Для миграционной карты лучше гибрид:
# - кириллица: cyrillic model
# - латиница/цифры: latin model
CYRILLIC_MODEL_NAME = "cyrillic_PP-OCRv5_mobile_rec"
LATIN_MODEL_NAME = "latin_PP-OCRv5_mobile_rec"


CYRILLIC_MIGRATION_FIELDS = {
    "mg_surname",
    "mg_name",
    "mg_patronymic",
    "mg_nationality",
}

LATIN_MIGRATION_FIELDS = {
    "mg_series",
    "mg_number",
    "mg_surname_lat",
    "mg_date_of_birth",
    "mg_passport_number",
    "mg_visa_number",
    "mg_duration_from",
    "mg_duration_to",
}


def normalize_strict(text: str) -> str:
    text = str(text).upper()
    text = text.replace("\t", " ")
    text = text.replace("\n", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def normalize_loose(text: str) -> str:
    """
    Мягкое сравнение:
    - убираем пробелы;
    - убираем точки;
    - приводим к upper.

    Нужно, чтобы:
      20 08 1999
      20.08.1999
      20081999

    не считались радикально разными.
    """
    text = normalize_strict(text)
    text = text.replace(" ", "")
    text = text.replace(".", "")
    text = text.replace("-", "")
    return text


def edit_distance(a: str, b: str) -> int:
    if a == b:
        return 0

    if not a:
        return len(b)

    if not b:
        return len(a)

    prev = list(range(len(b) + 1))

    for i, ca in enumerate(a, start=1):
        cur = [i]

        for j, cb in enumerate(b, start=1):
            cur.append(
                min(
                    cur[j - 1] + 1,
                    prev[j] + 1,
                    prev[j - 1] + (ca != cb),
                )
            )

        prev = cur

    return prev[-1]


def cer(expected: str, predicted: str, loose: bool = False) -> float:
    if loose:
        e = normalize_loose(expected)
        p = normalize_loose(predicted)
    else:
        e = normalize_strict(expected)
        p = normalize_strict(predicted)

    if not e:
        return 0.0 if not p else 1.0

    return edit_distance(e, p) / max(1, len(e))


def extract_field_name(image_rel: str) -> str:
    """
    Пример:
    train/xxx__passport_0__3_pas_surname__line_1__sample_5__orig.png
    -> pas_surname
    """

    name = Path(image_rel).name

    match = re.search(
        r"__(?:\d+_)?([a-z]+_[a-z0-9_]+)__line_",
        name,
    )

    if match:
        return match.group(1)

    if "_synthetic_qw" in image_rel:
        return "synthetic_qw"

    return "unknown"


def read_label_file(dataset_dir: Path, label_file: Path) -> list[dict[str, str]]:
    rows = []

    for line_no, line in enumerate(label_file.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue

        if "\t" not in line:
            raise ValueError(
                f"Bad label line without TAB: {label_file}:{line_no}: {line}"
            )

        image_rel, text = line.split("\t", 1)
        image_path = dataset_dir / image_rel

        if not image_path.exists():
            raise FileNotFoundError(
                f"Image from label file not found: {image_path}"
            )

        rows.append(
            {
                "image_rel": image_rel,
                "image_path": str(image_path),
                "expected": text,
                "field": extract_field_name(image_rel),
            }
        )

    return rows


class PretrainedRecognizerPool:
    def __init__(
        self,
        *,
        device: str,
        latin_model_dir: str | None = None,
        cyrillic_model_dir: str | None = None,
        input_shape: tuple[int, int, int] | None = (3, TARGET_HEIGHT, MAX_WIDTH),
    ):
        self.device = device
        self.latin_model_dir = latin_model_dir
        self.cyrillic_model_dir = cyrillic_model_dir
        self.input_shape = input_shape
        self.models: dict[str, Any] = {}

    def get(self, key: str):
        if key in self.models:
            return self.models[key]

        if key == "latin":
            model_name = LATIN_MODEL_NAME
            model_dir = self.latin_model_dir
        elif key == "cyrillic":
            model_name = CYRILLIC_MODEL_NAME
            model_dir = self.cyrillic_model_dir
        else:
            raise ValueError(f"Unknown OCR model key: {key}")

        kwargs: dict[str, Any] = {
            "model_name": model_name,
            "device": self.device,
        }

        if model_dir:
            kwargs["model_dir"] = model_dir

        if self.input_shape is not None:
            kwargs["input_shape"] = self.input_shape

        try:
            model = TextRecognition(**kwargs)
        except TypeError:
            # На случай другой версии PaddleOCR, где input_shape не принимается.
            kwargs.pop("input_shape", None)
            model = TextRecognition(**kwargs)

        self.models[key] = model
        return model

    def predict(self, model_key: str, image_path: str) -> tuple[str, float]:
        model = self.get(model_key)

        try:
            raw = model.predict(
                input=image_path,
                batch_size=1,
            )
        except TypeError:
            raw = model.predict(
                image_path,
                batch_size=1,
            )

        return parse_text_recognition_result(raw)


def parse_text_recognition_result(raw: Any) -> tuple[str, float]:
    if raw is None:
        return "", 0.0

    if isinstance(raw, list) and not raw:
        return "", 0.0

    item = raw[0] if isinstance(raw, list) else raw

    candidates = []

    if hasattr(item, "json"):
        try:
            candidates.append(item.json)
        except Exception:
            pass

    if hasattr(item, "to_dict"):
        try:
            candidates.append(item.to_dict())
        except Exception:
            pass

    if isinstance(item, dict):
        candidates.append(item)

    if hasattr(item, "__dict__"):
        candidates.append(item.__dict__)

    def find_rec(obj: Any) -> tuple[str, float] | None:
        if isinstance(obj, dict):
            if "rec_text" in obj:
                return (
                    str(obj.get("rec_text", "")),
                    float(obj.get("rec_score", 0.0)),
                )

            if "res" in obj:
                found = find_rec(obj["res"])
                if found is not None:
                    return found

            for value in obj.values():
                found = find_rec(value)
                if found is not None:
                    return found

        elif isinstance(obj, (list, tuple)):
            if (
                len(obj) >= 2
                and isinstance(obj[0], str)
                and isinstance(obj[1], (float, int))
            ):
                return str(obj[0]), float(obj[1])

            for value in obj:
                found = find_rec(value)
                if found is not None:
                    return found

        return None

    for candidate in candidates:
        found = find_rec(candidate)
        if found is not None:
            return found

    return "", 0.0


def choose_model_key(dataset_name: str, field_name: str, migration_mode: str) -> str:
    if dataset_name == "passport":
        return "latin"

    if dataset_name == "migration":
        if migration_mode == "latin":
            return "latin"

        if migration_mode == "cyrillic":
            return "cyrillic"

        if migration_mode == "hybrid":
            if field_name in CYRILLIC_MIGRATION_FIELDS:
                return "cyrillic"
            return "latin"

    raise ValueError(
        f"Unsupported dataset/mode: dataset={dataset_name}, migration_mode={migration_mode}"
    )


def evaluate_rows(
    *,
    dataset_name: str,
    rows: list[dict[str, str]],
    pool: PretrainedRecognizerPool,
    out_dir: Path,
    migration_mode: str,
    limit: int,
) -> list[dict[str, Any]]:
    if limit > 0:
        rows = rows[:limit]

    results = []

    for idx, row in enumerate(rows):
        image_path = row["image_path"]
        image_rel = row["image_rel"]
        expected = row["expected"]
        field = row["field"]

        model_key = choose_model_key(
            dataset_name=dataset_name,
            field_name=field,
            migration_mode=migration_mode,
        )

        predicted, score = pool.predict(
            model_key=model_key,
            image_path=image_path,
        )

        strict_expected = normalize_strict(expected)
        strict_predicted = normalize_strict(predicted)

        loose_expected = normalize_loose(expected)
        loose_predicted = normalize_loose(predicted)

        strict_match = strict_expected == strict_predicted
        loose_match = loose_expected == loose_predicted

        cer_strict = cer(expected, predicted, loose=False)
        cer_loose = cer(expected, predicted, loose=True)

        status = "OK" if strict_match else "OK_LOOSE" if loose_match else "MISMATCH"

        sample_rel = Path("samples") / dataset_name / Path(image_rel).name
        sample_abs = out_dir / sample_rel
        sample_abs.parent.mkdir(parents=True, exist_ok=True)

        if not sample_abs.exists():
            shutil.copy2(image_path, sample_abs)

        item = {
            "dataset": dataset_name,
            "status": status,
            "field": field,
            "model_key": model_key,
            "image_rel": image_rel,
            "sample_rel": sample_rel.as_posix(),
            "expected": expected,
            "predicted": predicted,
            "score": score,
            "cer_strict": cer_strict,
            "cer_loose": cer_loose,
        }

        results.append(item)

        print(
            f"[{dataset_name} {idx + 1}/{len(rows)}] "
            f"{status} | {field} | "
            f"GT={expected!r} | PRED={predicted!r} | "
            f"score={score:.4f} | CER={cer_strict:.3f}"
        )

    return results


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    by_dataset: dict[str, list[dict[str, Any]]] = {}
    by_field: dict[str, list[dict[str, Any]]] = {}

    for r in results:
        by_dataset.setdefault(r["dataset"], []).append(r)
        by_field.setdefault(f"{r['dataset']}:{r['field']}", []).append(r)

    def summarize_group(items: list[dict[str, Any]]) -> dict[str, Any]:
        total = len(items)
        strict_ok = sum(1 for r in items if r["status"] == "OK")
        loose_ok = sum(1 for r in items if r["status"] in {"OK", "OK_LOOSE"})

        cer_strict_values = [float(r["cer_strict"]) for r in items]
        cer_loose_values = [float(r["cer_loose"]) for r in items]

        return {
            "total": total,
            "strict_acc": strict_ok / total if total else 0.0,
            "loose_acc": loose_ok / total if total else 0.0,
            "avg_cer_strict": statistics.mean(cer_strict_values) if cer_strict_values else None,
            "avg_cer_loose": statistics.mean(cer_loose_values) if cer_loose_values else None,
        }

    return {
        "overall": summarize_group(results),
        "by_dataset": {
            k: summarize_group(v)
            for k, v in sorted(by_dataset.items())
        },
        "by_field": {
            k: summarize_group(v)
            for k, v in sorted(by_field.items())
        },
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return

    path.parent.mkdir(parents=True, exist_ok=True)

    keys = [
        "dataset",
        "status",
        "field",
        "model_key",
        "expected",
        "predicted",
        "score",
        "cer_strict",
        "cer_loose",
        "image_rel",
        "sample_rel",
    ]

    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=keys)
        writer.writeheader()
        writer.writerows(rows)


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def write_html(path: Path, rows: list[dict[str, Any]], summary: dict[str, Any], max_rows: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    errors = [r for r in rows if r["status"] == "MISMATCH"]
    ok_loose = [r for r in rows if r["status"] == "OK_LOOSE"]
    ok = [r for r in rows if r["status"] == "OK"]

    shown = (errors + ok_loose + ok)[:max_rows]

    def img_tag(rel: str) -> str:
        return (
            f'<a href="{html.escape(rel)}" target="_blank">'
            f'<img src="{html.escape(rel)}" height="56">'
            f"</a>"
        )

    html_rows = []

    for r in shown:
        if r["status"] == "OK":
            color = "#e8ffe8"
        elif r["status"] == "OK_LOOSE":
            color = "#fff7dc"
        else:
            color = "#ffe8e8"

        html_rows.append(
            f"""
            <tr style="background:{color}">
                <td>{html.escape(str(r["dataset"]))}</td>
                <td>{html.escape(str(r["status"]))}</td>
                <td>{html.escape(str(r["field"]))}</td>
                <td>{html.escape(str(r["model_key"]))}</td>
                <td><b>{html.escape(str(r["expected"]))}</b></td>
                <td><b>{html.escape(str(r["predicted"]))}</b></td>
                <td>{float(r["score"]):.4f}</td>
                <td>{float(r["cer_strict"]):.4f}</td>
                <td>{float(r["cer_loose"]):.4f}</td>
                <td>{img_tag(r["sample_rel"])}</td>
            </tr>
            """
        )

    text = f"""
    <!doctype html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Pretrained OCR baseline</title>
        <style>
            body {{
                font-family: Arial, sans-serif;
                font-size: 14px;
                margin: 24px;
            }}
            table {{
                border-collapse: collapse;
                width: 100%;
            }}
            th, td {{
                border: 1px solid #ccc;
                padding: 6px;
                vertical-align: top;
            }}
            th {{
                background: #eee;
                position: sticky;
                top: 0;
            }}
            code {{
                background: #f5f5f5;
                padding: 2px 4px;
            }}
        </style>
    </head>
    <body>
        <h1>Pretrained OCR baseline</h1>

        <h2>Summary</h2>
        <pre>{html.escape(json.dumps(summary, ensure_ascii=False, indent=2))}</pre>

        <p>
            Сначала показаны ошибки, потом OK_LOOSE, потом OK.
            Полные результаты смотри в <code>metrics.csv</code> и <code>details.jsonl</code>.
        </p>

        <table>
            <thead>
                <tr>
                    <th>Dataset</th>
                    <th>Status</th>
                    <th>Field</th>
                    <th>Model</th>
                    <th>Expected</th>
                    <th>Predicted</th>
                    <th>Score</th>
                    <th>CER strict</th>
                    <th>CER loose</th>
                    <th>Image</th>
                </tr>
            </thead>
            <tbody>
                {"".join(html_rows)}
            </tbody>
        </table>
    </body>
    </html>
    """

    path.write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--out-dir",
        type=Path,
        default=OUT_DIR,
    )

    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="0 = all validation samples",
    )

    parser.add_argument(
        "--passport",
        action="store_true",
        help="Evaluate passport val",
    )

    parser.add_argument(
        "--migration",
        action="store_true",
        help="Evaluate migration val",
    )

    parser.add_argument(
        "--migration-mode",
        choices=["latin", "cyrillic", "hybrid"],
        default="hybrid",
    )

    parser.add_argument(
        "--cpu",
        action="store_true",
    )

    parser.add_argument(
        "--latin-model-dir",
        type=str,
        default="",
        help="Optional local pretrained latin inference model dir",
    )

    parser.add_argument(
        "--cyrillic-model-dir",
        type=str,
        default="",
        help="Optional local pretrained cyrillic inference model dir",
    )

    args = parser.parse_args()

    if not args.passport and not args.migration:
        args.passport = True
        args.migration = True

    args.out_dir.mkdir(parents=True, exist_ok=True)

    device = "cpu" if args.cpu else f"gpu:{DEVICE_ID}"

    pool = PretrainedRecognizerPool(
        device=device,
        latin_model_dir=args.latin_model_dir or None,
        cyrillic_model_dir=args.cyrillic_model_dir or None,
        input_shape=(3, TARGET_HEIGHT, MAX_WIDTH),
    )

    all_results = []

    if args.passport:
        passport_rows = read_label_file(
            PASSPORT_DATASET,
            PASSPORT_DATASET / "rec_gt_val.txt",
        )

        all_results.extend(
            evaluate_rows(
                dataset_name="passport",
                rows=passport_rows,
                pool=pool,
                out_dir=args.out_dir,
                migration_mode=args.migration_mode,
                limit=args.limit,
            )
        )

    if args.migration:
        migration_rows = read_label_file(
            MIGRATION_DATASET,
            MIGRATION_DATASET / "rec_gt_val.txt",
        )

        all_results.extend(
            evaluate_rows(
                dataset_name="migration",
                rows=migration_rows,
                pool=pool,
                out_dir=args.out_dir,
                migration_mode=args.migration_mode,
                limit=args.limit,
            )
        )

    summary = summarize(all_results)

    write_csv(
        args.out_dir / "metrics.csv",
        all_results,
    )

    write_jsonl(
        args.out_dir / "details.jsonl",
        all_results,
    )

    (args.out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    write_html(
        args.out_dir / "report.html",
        all_results,
        summary,
        max_rows=1500,
    )

    print()
    print("Done")
    print(f"Report: {args.out_dir / 'report.html'}")
    print(f"CSV: {args.out_dir / 'metrics.csv'}")
    print(f"JSONL: {args.out_dir / 'details.jsonl'}")
    print()
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
