from __future__ import annotations

import sys
from argparse import Namespace
from pathlib import Path

from recognizeuz.core.config import DEVICE, PADDLEOCR_ROOT, USE_GPU

sys.path.insert(0, str(PADDLEOCR_ROOT))

from tools.infer.predict_rec import TextRecognizer  # noqa: E402

def make_rec_args(
    *,
    rec_model_dir: Path,
    rec_char_dict_path: Path,
) -> Namespace:
    return Namespace(
        image_dir="",
        rec_algorithm="SVTR_LCNet",
        rec_model_dir=str(rec_model_dir),
        rec_image_shape="3,48,768",
        rec_char_dict_path=str(rec_char_dict_path),
        use_space_char=True,

        use_gpu=USE_GPU,
        gpu_id=DEVICE,
        gpu_mem=500,
        use_tensorrt=False,
        use_fp16=False,
        ir_optim=True,
        enable_mkldnn=False,
        cpu_threads=10,

        benchmark=False,
        save_log_path="./log_output/",
        show_log=False,

        # Эти параметры нужны parse/utility, даже если recognition их не использует.
        det=False,
        rec=True,
        cls=False,
        use_angle_cls=False,
        drop_score=0.0,
        max_batch_size=1,
        rec_batch_num=1,

        # Paddle static predictor ожидает эти поля в разных версиях PaddleOCR.
        use_onnx=False,
        precision="fp32",
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
        # ----------------------------------
    )
