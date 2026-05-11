# --- Base image ---
# python:3.11-slim is fine for the stub backend.
# For BACKEND=qwen, swap to a CUDA image (e.g. nvidia/cuda:12.4.1-runtime-ubuntu22.04
# + python install) and rebuild — see notes at the bottom of this file.
FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# --- Dependency layer ---
# Core deps cached separately from heavy ML deps so the stub-only image is small
# and the qwen layer only invalidates when its requirements change.
FROM base AS deps
COPY requirements.txt ./
RUN pip install -r requirements.txt

# Claude SDK — small dep, installed by default so BACKEND=claude works
# out of the box once ANTHROPIC_API_KEY is set. ~5 MB.
COPY requirements-claude.txt ./
RUN pip install -r requirements-claude.txt

# Heavy ML deps for the Qwen-VL backend. To skip (stub/claude-only image):
# comment the next two lines and rebuild. The runtime layer below copies
# site-packages so nothing else needs to change.
COPY requirements-qwen.txt ./
RUN pip install -r requirements-qwen.txt

# --- Runtime layer ---
FROM base AS runtime

# Pillow runtime needs libjpeg/libpng — already pulled in by the wheel,
# nothing to add here for image-only flow. If the qwen backend hits libgl
# errors when loading certain images, add libgl1-mesa-glx.

COPY --from=deps /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=deps /usr/local/bin /usr/local/bin

COPY src ./src
COPY pyproject.toml ./

# Non-root user
RUN useradd --create-home --uid 1000 inference && \
    mkdir -p /app/.hf-cache && \
    chown -R inference:inference /app
USER inference

EXPOSE 8000
CMD ["uvicorn", "inference_service.main:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "src"]

# --- GPU notes ---
# To run Qwen2.5-VL on GPU:
#   1. Replace the FROM line at the top with:
#        FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04 AS base
#        RUN apt-get update && apt-get install -y python3.11 python3.11-venv python3-pip
#   2. Add `--gpus all` (or service-level deploy.resources.reservations) to compose.
#   3. Set BACKEND=qwen in .env. First call will download ~7-15GB of weights into HF_HOME.
