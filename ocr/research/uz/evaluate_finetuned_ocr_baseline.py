from __future__ import annotations

import argparse
import csv
import html
import json
import re
import shutil
import statistics
import sys
from argparse import Namespace
from pathlib import Path
from typing import Any

import cv2


PROJECT_ROOT = Path("/home/neuro/PycharmProjects/RecognizeUZ")

PADDLEOCR_ROOT = Path(
    "/home/neuro/PycharmProjects/createOCRDataset/PaddleOCR_training/PaddleOCR"
)

PASSPORT_DATASET = PROJECT_ROOT / "paddleocr_passport_rec_exp_b_photo_aug"
MIGRATION_DATASET = PROJECT_ROOT / "paddleocr_migration_rec"

PASSPORT_MODEL_DIR_DEFAULT = Path('/home/neuro/PycharmProjects/RecognizeUZ/paddleocr/inference/ocr/passport_rec_exp_c_latin_low_lr_more_aug')

MIGRATION_MODEL_DIR_DEFAULT = (
    PROJECT_ROOT / "paddleocr/inference/ocr/migration_rec_v3_fixed"
)

PASSPORT_MODEL_DIR_FALLBACK = (
    PROJECT_ROOT / "paddleocr/inference/ocr/passport_rec_v3"
)

MIGRATION_MODEL_DIR_FALLBACK = (
    PROJECT_ROOT / "paddleocr/inference/ocr/migration_rec_v3"
)

# PASSPORT_DICT = PASSPORT_DATASET / "dict.txt"
PASSPORT_DICT = Path('/home/neuro/PycharmProjects/createOCRDataset/PaddleOCR_training/PaddleOCR/ppocr/utils/dict/ppocrv5_latin_dict.txt')
MIGRATION_DICT = MIGRATION_DATASET / "dict.txt"

OUT_DIR = PROJECT_ROOT / "finetuned_ocr_eval"

USE_GPU = True
DEVICE_ID = 0
REC_IMAGE_SHAPE = "3,48,768"


sys.path.insert(0, str(PADDLEOCR_ROOT))

from tools.infer.predict_rec import TextRecognizer  # noqa: E402


def resolve_model_dir(primary: Path, fallback: Path) -> Path:
    if primary.exists():
        return primary

    if fallback.exists():
        return fallback

    raise FileNotFoundError(
        "No inference model dir found.\n"
        f"Primary:  {primary}\n"
        f"Fallback: {fallback}"
    )


def check_inference_dir(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(path)

    files = {p.name for p in path.iterdir() if p.is_file()}

    has_params = any(name.endswith(".pdiparams") for name in files)
    has_model = (
        any(name.endswith(".pdmodel") for name in files)
        or "inference.json" in files
        or "inference.yml" in files
    )

    if not has_params:
        raise RuntimeError(f"No .pdiparams in {path}. Files: {sorted(files)}")

    if not has_model:
        raise RuntimeError(
            f"No inference model description in {path}. Files: {sorted(files)}"
        )


def make_rec_args(
    *,
    rec_model_dir: Path,
    rec_char_dict_path: Path,
    rec_image_shape: str,
    use_gpu: bool,
    gpu_id: int,
    rec_batch_num: int = 1,
) -> Namespace:
    return Namespace(
        image_dir="",
        rec_algorithm="SVTR_LCNet",
        rec_model_dir=str(rec_model_dir),
        rec_image_shape=rec_image_shape,
        rec_char_dict_path=str(rec_char_dict_path),
        use_space_char=True,

        use_gpu=use_gpu,
        gpu_id=gpu_id,
        gpu_mem=500,
        use_tensorrt=False,
        use_fp16=False,
        precision="fp32",
        ir_optim=True,
        enable_mkldnn=False,
        cpu_threads=10,

        benchmark=False,
        save_log_path="./log_output/",
        show_log=False,

        det=False,
        rec=True,
        cls=False,
        use_angle_cls=False,

        drop_score=0.0,
        max_batch_size=rec_batch_num,
        rec_batch_num=rec_batch_num,

        use_onnx=False,
        enable_hpi=False,
        use_mp=False,
        total_process_num=1,
        process_id=0,
        warmup=False,
        min_subgraph_size=15,
        rec_yaml_path=None,

        # --- ДОБАВИТЬ ЭТИ ДВА ПАРАМЕТРА ---
        use_gcu=False,  # Исправляет ошибку AttributeError: 'use_gcu'
        return_word_box=False,  # Исправляет ошибку AttributeError: 'return_word_box'
    )


class FinetunedRecognizer:
    def __init__(
        self,
        *,
        name: str,
        model_dir: Path,
        dict_path: Path,
        rec_image_shape: str,
        use_gpu: bool,
        gpu_id: int,
    ):
        self.name = name
        self.model_dir = model_dir
        self.dict_path = dict_path

        check_inference_dir(model_dir)

        if not dict_path.exists():
            raise FileNotFoundError(dict_path)

        args = make_rec_args(
            rec_model_dir=model_dir,
            rec_char_dict_path=dict_path,
            rec_image_shape=rec_image_shape,
            use_gpu=use_gpu,
            gpu_id=gpu_id,
            rec_batch_num=1,
        )

        self.model = TextRecognizer(args)

    def predict(self, image_path: Path) -> tuple[str, float]:
        img = cv2.imread(str(image_path))

        if img is None:
            raise RuntimeError(f"Cannot read image: {image_path}")

        result, _ = self.model([img])

        if not result:
            return "", 0.0

        text, score = result[0]

        return str(text), float(score)


def normalize_strict(text: str) -> str:
    text = str(text).upper()
    text = text.replace("\t", " ")
    text = text.replace("\n", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def normalize_loose(text: str) -> str:
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


def cer(expected: str, predicted: str, *, loose: bool = False) -> float:
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


def read_label_file(dataset_dir: Path, label_file: Path) -> list[dict[str, Any]]:
    if not label_file.exists():
        raise FileNotFoundError(label_file)

    rows = []

    for line_no, line in enumerate(
        label_file.read_text(encoding="utf-8").splitlines(),
        start=1,
    ):
        if not line.strip():
            continue

        if "\t" not in line:
            raise ValueError(
                f"Bad label line without TAB: {label_file}:{line_no}: {line}"
            )

        image_rel, expected = line.split("\t", 1)
        image_path = dataset_dir / image_rel

        if not image_path.exists():
            raise FileNotFoundError(
                f"Image from label file not found: {image_path}"
            )

        rows.append(
            {
                "image_rel": image_rel,
                "image_path": image_path,
                "expected": expected,
                "field": extract_field_name(image_rel),
            }
        )

    return rows


def evaluate_dataset(
    *,
    dataset_name: str,
    dataset_dir: Path,
    recognizer: FinetunedRecognizer,
    out_dir: Path,
    limit: int,
) -> list[dict[str, Any]]:
    label_file = dataset_dir / "rec_gt_val.txt"
    rows = read_label_file(dataset_dir, label_file)

    if limit > 0:
        rows = rows[:limit]

    results = []

    for idx, row in enumerate(rows):
        image_rel = row["image_rel"]
        image_path = row["image_path"]
        expected = row["expected"]
        field = row["field"]

        predicted, score = recognizer.predict(image_path)

        strict_match = normalize_strict(expected) == normalize_strict(predicted)
        loose_match = normalize_loose(expected) == normalize_loose(predicted)

        if not normalize_strict(expected):
            status = "EMPTY_GT"
        elif strict_match:
            status = "OK"
        elif loose_match:
            status = "OK_SPACE_DIFF"
        else:
            status = "TEXT_MISMATCH"

        cer_strict = cer(expected, predicted, loose=False)
        cer_loose = cer(expected, predicted, loose=True)

        sample_rel = (
            Path("samples")
            / dataset_name
            / field
            / Path(image_rel).name
        )

        sample_abs = out_dir / sample_rel
        sample_abs.parent.mkdir(parents=True, exist_ok=True)

        if not sample_abs.exists():
            shutil.copy2(image_path, sample_abs)

        item = {
            "dataset": dataset_name,
            "status": status,
            "field": field,
            "image_rel": image_rel,
            "sample_rel": sample_rel.as_posix(),
            "expected": expected,
            "predicted": predicted,
            "ocr_conf": score,
            "cer": cer_strict,
            "cer_loose": cer_loose,
            "model_dir": str(recognizer.model_dir),
        }

        results.append(item)

        print(
            f"[{dataset_name} {idx + 1}/{len(rows)}] "
            f"{status} | {field} | "
            f"GT={expected!r} | PRED={predicted!r} | "
            f"conf={score:.4f} | CER={cer_strict:.3f}"
        )

    return results


def summarize_group(items: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(items)

    if total == 0:
        return {
            "total": 0,
            "strict_acc": 0.0,
            "ok_or_space_diff_acc": 0.0,
            "avg_cer": None,
            "avg_cer_loose": None,
        }

    strict_ok = sum(1 for r in items if r["status"] == "OK")
    ok_or_space = sum(
        1
        for r in items
        if r["status"] in {"OK", "OK_SPACE_DIFF"}
    )

    cer_values = [
        float(r["cer"])
        for r in items
        if r["status"] != "EMPTY_GT"
    ]

    cer_loose_values = [
        float(r["cer_loose"])
        for r in items
        if r["status"] != "EMPTY_GT"
    ]

    return {
        "total": total,
        "strict_acc": strict_ok / total,
        "ok_or_space_diff_acc": ok_or_space / total,
        "avg_cer": statistics.mean(cer_values) if cer_values else None,
        "avg_cer_loose": statistics.mean(cer_loose_values) if cer_loose_values else None,
    }


def build_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    dataset_counts: dict[str, int] = {}
    status_counts: dict[str, int] = {}
    field_counts: dict[str, dict[str, int]] = {}

    by_dataset: dict[str, list[dict[str, Any]]] = {}
    by_field: dict[str, list[dict[str, Any]]] = {}

    validation_text_rows = [
        r for r in rows
        if r["status"] != "EMPTY_GT"
    ]

    for r in rows:
        dataset = r["dataset"]
        status = r["status"]
        field = r["field"]

        dataset_counts[dataset] = dataset_counts.get(dataset, 0) + 1
        status_counts[status] = status_counts.get(status, 0) + 1

        field_counts.setdefault(field, {})
        field_counts[field][status] = field_counts[field].get(status, 0) + 1

        by_dataset.setdefault(dataset, []).append(r)
        by_field.setdefault(f"{dataset}:{field}", []).append(r)

    ok_or_space = sum(
        1
        for r in validation_text_rows
        if r["status"] in {"OK", "OK_SPACE_DIFF"}
    )

    cer_values = [
        float(r["cer"])
        for r in validation_text_rows
    ]

    summary = {
        "total_rows": len(rows),
        "dataset_counts": dict(sorted(dataset_counts.items())),
        "status_counts": dict(sorted(status_counts.items())),
        "validation_text_rows": len(validation_text_rows),
        "validation_text_accuracy_ok_or_space_diff": (
            ok_or_space / len(validation_text_rows)
            if validation_text_rows
            else 0.0
        ),
        "validation_avg_cer": (
            statistics.mean(cer_values)
            if cer_values
            else None
        ),
        "field_counts": {
            field: dict(sorted(counts.items()))
            for field, counts in sorted(field_counts.items())
        },
        "metrics": {
            "overall": summarize_group(rows),
            "by_dataset": {
                key: summarize_group(value)
                for key, value in sorted(by_dataset.items())
            },
            "by_field": {
                key: summarize_group(value)
                for key, value in sorted(by_field.items())
            },
        },
    }

    return summary


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    if not rows:
        path.write_text("", encoding="utf-8")
        return

    keys = [
        "dataset",
        "status",
        "field",
        "expected",
        "predicted",
        "ocr_conf",
        "cer",
        "cer_loose",
        "image_rel",
        "sample_rel",
        "model_dir",
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


def write_html(
    path: Path,
    rows: list[dict[str, Any]],
    summary: dict[str, Any],
    max_rows: int,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    errors = [
        r for r in rows
        if r["status"] == "TEXT_MISMATCH"
    ]

    space_diff = [
        r for r in rows
        if r["status"] == "OK_SPACE_DIFF"
    ]

    ok = [
        r for r in rows
        if r["status"] == "OK"
    ]

    empty = [
        r for r in rows
        if r["status"] == "EMPTY_GT"
    ]

    shown = (errors + space_diff + ok + empty)[:max_rows]

    def img_tag(rel: str) -> str:
        return (
            f'<a href="{html.escape(rel)}" target="_blank">'
            f'<img src="{html.escape(rel)}" height="56">'
            f"</a>"
        )

    html_rows = []

    for r in shown:
        status = r["status"]

        if status == "OK":
            color = "#e8ffe8"
        elif status == "OK_SPACE_DIFF":
            color = "#fff7dc"
        elif status == "EMPTY_GT":
            color = "#f4f4f4"
        else:
            color = "#ffe8e8"

        html_rows.append(
            f"""
            <tr style="background:{color}">
                <td>{html.escape(str(r["dataset"]))}</td>
                <td>{html.escape(str(r["status"]))}</td>
                <td>{html.escape(str(r["field"]))}</td>
                <td><b>{html.escape(str(r["expected"]))}</b></td>
                <td><b>{html.escape(str(r["predicted"]))}</b></td>
                <td>{float(r["ocr_conf"]):.4f}</td>
                <td>{float(r["cer"]):.4f}</td>
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
        <title>Fine-tuned OCR evaluation</title>
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
        <h1>Fine-tuned OCR evaluation</h1>

        <h2>Summary</h2>
        <pre>{html.escape(json.dumps(summary, ensure_ascii=False, indent=2))}</pre>

        <p>
            Сначала показаны ошибки, затем OK_SPACE_DIFF, затем OK.
            Полные результаты: <code>metrics.csv</code>, <code>details.jsonl</code>, <code>summary.json</code>.
        </p>

        <table>
            <thead>
                <tr>
                    <th>Dataset</th>
                    <th>Status</th>
                    <th>Field</th>
                    <th>Expected</th>
                    <th>Predicted</th>
                    <th>OCR Conf</th>
                    <th>CER</th>
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
        "--passport",
        action="store_true",
    )

    parser.add_argument(
        "--migration",
        action="store_true",
    )

    parser.add_argument(
        "--limit",
        type=int,
        default=100,
        help="0 = all validation OCR crops",
    )

    parser.add_argument(
        "--html-max-rows",
        type=int,
        default=1500,
    )

    parser.add_argument(
        "--cpu",
        action="store_true",
    )

    parser.add_argument(
        "--rec-image-shape",
        type=str,
        default=REC_IMAGE_SHAPE,
    )

    parser.add_argument(
        "--passport-model-dir",
        type=Path,
        default=None,
    )

    parser.add_argument(
        "--migration-model-dir",
        type=Path,
        default=None,
    )

    args = parser.parse_args()

    if not args.passport and not args.migration:
        args.passport = True
        args.migration = True

    args.out_dir.mkdir(parents=True, exist_ok=True)

    use_gpu = not args.cpu

    passport_model_dir = (
        args.passport_model_dir
        if args.passport_model_dir is not None
        else resolve_model_dir(
            PASSPORT_MODEL_DIR_DEFAULT,
            PASSPORT_MODEL_DIR_FALLBACK,
        )
    )

    migration_model_dir = (
        args.migration_model_dir
        if args.migration_model_dir is not None
        else resolve_model_dir(
            MIGRATION_MODEL_DIR_DEFAULT,
            MIGRATION_MODEL_DIR_FALLBACK,
        )
    )

    print(f"PaddleOCR root: {PADDLEOCR_ROOT}")
    print(f"Passport model dir: {passport_model_dir}")
    print(f"Migration model dir: {migration_model_dir}")
    print(f"rec_image_shape: {args.rec_image_shape}")
    print(f"use_gpu: {use_gpu}")

    all_rows = []

    passport_recognizer = None
    migration_recognizer = None

    if args.passport:
        passport_recognizer = FinetunedRecognizer(
            name="passport",
            model_dir=passport_model_dir,
            dict_path=PASSPORT_DICT,
            rec_image_shape=args.rec_image_shape,
            use_gpu=use_gpu,
            gpu_id=DEVICE_ID,
        )

        all_rows.extend(
            evaluate_dataset(
                dataset_name="passport",
                dataset_dir=PASSPORT_DATASET,
                recognizer=passport_recognizer,
                out_dir=args.out_dir,
                limit=args.limit,
            )
        )

    if args.migration:
        migration_recognizer = FinetunedRecognizer(
            name="migration",
            model_dir=migration_model_dir,
            dict_path=MIGRATION_DICT,
            rec_image_shape=args.rec_image_shape,
            use_gpu=use_gpu,
            gpu_id=DEVICE_ID,
        )

        all_rows.extend(
            evaluate_dataset(
                dataset_name="migration",
                dataset_dir=MIGRATION_DATASET,
                recognizer=migration_recognizer,
                out_dir=args.out_dir,
                limit=args.limit,
            )
        )

    summary = build_summary(all_rows)

    write_csv(
        args.out_dir / "metrics.csv",
        all_rows,
    )

    write_jsonl(
        args.out_dir / "details.jsonl",
        all_rows,
    )

    (args.out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    write_html(
        args.out_dir / "report.html",
        all_rows,
        summary,
        max_rows=args.html_max_rows,
    )

    print()
    print("Done")
    print(f"Report: {args.out_dir / 'report.html'}")
    print(f"CSV: {args.out_dir / 'metrics.csv'}")
    print(f"JSONL: {args.out_dir / 'details.jsonl'}")
    print(f"Summary: {args.out_dir / 'summary.json'}")
    print()
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
