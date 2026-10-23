FROM vllm/vllm-openai@sha256:8f571a5bce7c762c1b7f88c21b92cad74ceb1bcd70d91c99d58f94104a5bfa05
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && uv pip install --system --upgrade \
       'git+https://github.com/huggingface/transformers.git@7b87f642106825b5dc8f1dd2e705f9075bc2b0f4'
