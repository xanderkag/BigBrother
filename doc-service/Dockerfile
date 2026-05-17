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
# Две задачи: TS → dist/ и Tailwind input.css → web/vendor/tailwind.css.
# cdn.tailwindcss.com заблокирован в корп.сети, поэтому self-hosted билд CSS.
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build && npm run build:css

# --- Prod-deps layer (без dev-deps) ---
FROM base AS prod-deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --omit=optional || npm install --omit=dev --omit=optional

# --- Runtime layer ---
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
# Operator UI — HTML + JS + precompiled vendor/ (tailwind.css, alpine.min.js).
# Берём из build-stage чтобы захватить свежий vendor/tailwind.css.
COPY --from=build /app/web ./web

# Storage volume mount point — must match STORAGE_DIR in .env.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

# Default command runs the API; the worker service in docker-compose overrides this.
CMD ["node", "dist/server.js"]
