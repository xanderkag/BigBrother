FROM node:22-slim AS base

# System dependencies for OCR pipeline:
#   tesseract-ocr             — OCR engine binary (called via node-tesseract-ocr)
#   tesseract-ocr-rus/eng     — language packs (Россия + ENG для смешанных)
#   tesseract-ocr-chi-sim     — F23 (SLAI ТЗ Фаза 2): китайский упрощённый
#                                для упаковочных листов AliExpress / 1688
#   tesseract-ocr-tur         — F24: турецкий для импорта из Турции
#   tesseract-ocr-pol         — F25: польский для торговли с Польшей
#   poppler-utils             — pdftoppm / pdfinfo, rasterize PDF → PNG для tesseract
#   libheif-examples          — heif-convert для HEIC/HEIF (iPhone-фото) → JPG.
#                                См. src/pipeline/preprocess/heic.ts
#   catdoc                    — legacy .doc (Word 97-2003 binary) → text.
#                                cp1251-aware, ~200 KB. См. src/pipeline/ocr/doc.ts
#   ca-certificates           — outbound TLS to LLM/Yandex
#
# По дефолту TESSERACT_LANGS=rus+eng в .env (без китайского/турецкого/польского,
# чтобы не тратить время на лишние языки). Per-job override через
# metadata.tesseract_langs (F26).
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-rus \
    tesseract-ocr-eng \
    tesseract-ocr-chi-sim \
    tesseract-ocr-tur \
    tesseract-ocr-pol \
    poppler-utils \
    libheif-examples \
    catdoc \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Dependency layer (cached separately from source) ---
# Включаем dev-deps — tailwindcss нужен на build-stage для CSS precompile.
# В runtime-стейдже node_modules копируется из prod-deps без dev-deps.
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# --- Build layer ---
# Две задачи:
#   1. TS → dist/ (backend код)
#   2. Vite build → ui/dist/ (React UI — раздаётся на /ui/*)
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# UI v2 (React + Vite) — отдельный package.json/node_modules чтобы не
# раздувать backend deps библиотеками react/pdfjs/tanstack-query. В
# runtime-stage берём только готовый `ui/dist/`.
COPY ui/package.json ui/package-lock.json* ./ui/
RUN cd ui && (npm ci || npm install)
COPY ui ./ui
RUN cd ui && npm run build

# --- Prod-deps layer (без dev-deps) ---
FROM base AS prod-deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --omit=optional || npm install --omit=dev --omit=optional

# --- Runtime layer ---
FROM base AS runtime
ENV NODE_ENV=production

# Build-time git metadata for GET /version (EPIC-7). Docker не видит .git
# внутри образа, поэтому коммит/ветку/время прокидываем через --build-arg из
# GHA deploy-parsdocs.yml. Без них /version отдаёт фолбэк "unknown".
ARG APP_VERSION=0.1.0
ARG GIT_COMMIT=unknown
ARG GIT_COMMIT_SHORT=unknown
ARG GIT_BRANCH=unknown
ARG BUILD_TIME=unknown
ENV APP_VERSION=$APP_VERSION \
    GIT_COMMIT=$GIT_COMMIT \
    GIT_COMMIT_SHORT=$GIT_COMMIT_SHORT \
    GIT_BRANCH=$GIT_BRANCH \
    BUILD_TIME=$BUILD_TIME

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
# Operator UI (React) — собранный bundle (index.html + assets/*).
# Маунтится backend'ом на /ui/* как единственный UI (см. server.ts).
COPY --from=build /app/ui/dist ./ui/dist

# Storage volume mount point — must match STORAGE_DIR in .env.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

# Default command runs the API; the worker service in docker-compose overrides this.
CMD ["node", "dist/server.js"]
