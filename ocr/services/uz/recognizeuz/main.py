from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

from recognizeuz.api.routes import router
from recognizeuz.core.resources import cleanup_models, load_models


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_models()
    yield
    cleanup_models()


app = FastAPI(
    title="RecognizeUZ OCR API",
    version="1.0.0",
    lifespan=lifespan,
)
app.include_router(router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "recognizeuz.main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
        workers=1,
    )
