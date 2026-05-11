FROM node:22-slim AS base

# System dependencies for OCR pipeline:
#   tesseract-ocr           — OCR engine binary (called via node-tesseract-ocr)
#   tesseract-ocr-rus/eng   — language packs for Russian and English documents
#   poppler-utils           — pdftoppm / pdfinfo, used to rasterize scanned PDFs for tesseract
#   ca-certificates         — outbound TLS to LLM/Yandex
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-rus \
    tesseract-ocr-eng \
    poppler-utils \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Dependency layer (cached separately from source) ---
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=optional || npm install --omit=optional

# --- Build layer ---
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime layer ---
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Operator UI — plain HTML + CDN-loaded Tailwind/Alpine; no build step needed.
COPY web ./web

# Storage volume mount point — must match STORAGE_DIR in .env.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

# Default command runs the API; the worker service in docker-compose overrides this.
CMD ["node", "dist/server.js"]
