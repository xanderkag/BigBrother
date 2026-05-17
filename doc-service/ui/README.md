# parsedocs UI v2 (React)

Новый operator UI на Vite + React + Tailwind. Маунтится backend'ом на `/v2/*`. Старый vanilla-JS UI продолжает работать на `/ui/*` пока v2 догоняет по фичам.

## Запуск (dev)

```bash
cd ui/
npm install
npm run dev
```

Vite dev-server слушает `:5173`, проксирует `/api/*` и `/healthz` на backend (`http://localhost:8085` по умолчанию).

Чтобы изменить адрес backend'а для прокси:

```bash
VITE_BACKEND_URL=http://10.10.13.10:8085 npm run dev
```

## Production build

```bash
npm run build
```

Складывается в `ui/dist/`. Backend (`doc-service/src/server.ts`) автоматически подхватывает эту папку при старте и маунтит на `/v2/*`. Если папки нет — endpoint `/v2/*` не регистрируется, /v2 просто 404.

В Docker сборка происходит автоматически в build-stage Dockerfile'а.

## Структура

```
ui/
├── src/
│   ├── main.tsx              # entry: React Query + Router + pdf.js worker
│   ├── App.tsx               # routes + auth guard
│   ├── index.css             # tailwind + design tokens
│   ├── lib/
│   │   ├── api.ts            # fetch wrapper с Bearer auth + 401-handler
│   │   ├── auth.ts           # token storage (localStorage parsdocs.token)
│   │   ├── format.ts         # форматтеры (money/date/percent)
│   │   └── types.ts          # Job, PipelineStep, LlmCallTrace
│   ├── queries/
│   │   └── jobs.ts           # useJob / useJobFile / useApproveJob / ...
│   ├── components/
│   │   ├── Layout.tsx        # header + main area
│   │   ├── PdfViewer.tsx     # react-pdf canvas без браузерного chrome
│   │   ├── ExtractedDataPanel.tsx  # Form/JSON toggle + secrtions
│   │   └── ValidationBanner.tsx
│   └── pages/
│       ├── Login.tsx
│       └── JobDetail.tsx
├── package.json
├── vite.config.ts            # base: '/v2/', proxy /api → backend
└── tailwind.config.js
```

## Что уже есть в v2

- [x] Login (API token из `parsdocs.token` совмещён со старым UI)
- [x] Job Detail (`/v2/jobs/:id`) — PDF слева, extracted data справа, actions сверху
- [x] PDF viewer на react-pdf (canvas, без браузерного chrome)
- [x] ExtractedDataPanel: Form/JSON режим, секции Реквизиты/Продавец/Покупатель/Items/Flags
- [x] Validation banner sticky
- [x] Per-field confidence (F2) визуализация bar'ами
- [x] Pipeline steps в раскрывающемся details
- [x] Approve / Reprocess actions

## Что мигрировать дальше

- [ ] Jobs list (`/v2/jobs`) — таблица с фильтром по status/document_type
- [ ] Upload (`/v2/upload`) — drag-drop, bulk
- [ ] Dashboard (`/v2`) — операционные метрики
- [ ] Review queue (`/v2/review`) — needs_review с быстрым approve
- [ ] Document types CRUD
- [ ] Provider settings CRUD
- [ ] Audit log viewer
- [ ] Edit extracted data (inline JSON editor)

После феат-парити со старым UI: поменять backend prefix `/v2/` → `/ui/` и старый UI отправить в `/ui-legacy/` на 1-2 месяца, потом удалить `web/`.
