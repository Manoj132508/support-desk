# The AI service: retrieval, intent, the grounded answer and the proposal
# request. Advisory only; it holds no database credential (ADR 0002).
# Ported from Project 2's image. Build context: ai-service/.

FROM python:3.12-slim

# - PYTHONDONTWRITEBYTECODE: no .pyc files in the image.
# - PYTHONUNBUFFERED: logs reach `docker logs` as they happen.
# - PIP_NO_CACHE_DIR: pip's download cache is dead weight in an image.
# - HF_HOME: where the embedding model is stored, inside the image.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/models

WORKDIR /app

# torch from the CPU index, pinned to the version the escalation eval and the
# Phase 14 measurements ran with. The default Linux wheel bundles CUDA libraries
# -- gigabytes the embedder never uses -- and a different torch could change the
# embeddings the grounding threshold was tuned on. Installed first, so the
# requirements below find it already satisfied.
RUN pip install torch==2.13.0 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt ./
RUN pip install -r requirements.txt

# THE EMBEDDING MODEL IS BAKED IN, and the hub is switched off afterwards.
# Project 2 left this optional. Here it is not: the grounding threshold (0.51)
# was tuned against all-MiniLM-L6-v2's scores (Phase 13), so a container that
# fetched "whatever the hub serves" at startup could change which questions are
# answered and which are handed to a person, with nothing in the logs.
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')"
ENV HF_HUB_OFFLINE=1 \
    ANONYMIZED_TELEMETRY=False

COPY app ./app
COPY data/kb ./data/kb

# The index is derived from the help centre shipped above, so it lives in the
# container, not a volume: every start indexes the bundled articles into an
# empty index (Phase 15, ~0.3 s for the demo help centre), which also means it
# can never hold chunks of an article a newer image removed.
ENV AI_KB_PATH=/app/data/kb \
    AI_INDEX_PATH=/data/index

RUN useradd --system --create-home appuser \
    && mkdir -p /data/index \
    && chown -R appuser:appuser /app /data /opt/models
USER appuser

EXPOSE 8200

# /health needs no token. HTTP is not served until the embedder has loaded, so a
# healthy container can retrieve; the model warm-up continues in the background.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8200/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8200"]
