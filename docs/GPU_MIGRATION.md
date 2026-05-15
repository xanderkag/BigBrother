# Миграция parsdocs на GPU-хост

Чек-лист переезда с CPU-only хоста (`10.10.13.10`, 7.8 GB RAM, нет GPU)
на GPU-сервер с NVIDIA картой 16+ GB VRAM.

## Требования к новому хосту

| Компонент | Минимум | Желательно |
|-----------|---------|------------|
| GPU | NVIDIA 16 GB VRAM | RTX 4090 / A6000 (24 GB) |
| CUDA driver | 12.x | 12.4+ |
| RAM | 32 GB | 64 GB |
| Диск | 100 GB SSD | 250 GB NVMe |
| OS | Linux x86_64 | Ubuntu 22.04 LTS |
| Docker | 20.10+ | latest |
| NVIDIA Container Toolkit | required | — |

**Проверка GPU из Docker:**
```bash
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
# Должна показать GPU + drivers
```

## Что переносить

### Containers (через compose, ничего вручную)
- `parsdocs-api`, `parsdocs-worker` (Node.js)
- `parsdocs-inference` (Python + Ollama-клиент)
- `parsdocs-ollama` (на GPU!)
- `parsdocs-postgres`, `parsdocs-redis` (служебные)

### Volumes (требуют переноса данных)
| Volume | Где | Что внутри | Метод |
|--------|-----|------------|-------|
| `parsdocs-doc-data` | doc-service | Загруженные PDF и оригиналы | `tar` + `scp` |
| `pg-data` | postgres | Jobs, document_types, reference_lists, audit_log | `pg_dump` / `pg_restore` |
| `parsdocs-ollama-data` | ollama | Веса моделей (опц.) | Можно перекачать с нуля |

### Конфиги (через git)
- `.env` doc-service (БД, Redis, токены, пороги)
- `.env` inference-service (BACKEND, OPENAI_MODEL, ключи)
- nginx-блок Павла — указать новый IP

## Шаги миграции (порядок важен)

### 1. На новом хосте — поднять инфраструктуру

```bash
# Установить NVIDIA Container Toolkit (если ещё не)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Создать общую сеть и клонировать репо
docker network create ai-platform
git clone https://git.taipit.ru/airesearch/docs-parse.git parsdocs
cd parsdocs
```

### 2. На старом хосте — снять данные

```bash
# Дамп БД
ssh kb-docker
docker exec parsdocs-postgres-1 pg_dump -U $POSTGRES_USER $POSTGRES_DB \
  | gzip > /tmp/parsdocs-db.sql.gz

# Дамп файлов
docker run --rm -v parsdocs-doc-data:/data -v /tmp:/backup alpine \
  tar czf /backup/parsdocs-files.tgz -C /data .

# Скопировать на новый хост
scp /tmp/parsdocs-db.sql.gz /tmp/parsdocs-files.tgz user@new-host:/tmp/
```

### 3. На новом хосте — восстановить данные

```bash
# Создать volumes и контейнеры (но не стартовать)
docker compose -f docker-compose.doc-platform.yml create

# Восстановить файлы
docker run --rm -v parsdocs-doc-data:/data -v /tmp:/backup alpine \
  tar xzf /backup/parsdocs-files.tgz -C /data

# Старт postgres, restore дамп
docker compose -f docker-compose.doc-platform.yml up -d postgres
sleep 5
gunzip -c /tmp/parsdocs-db.sql.gz | docker exec -i parsdocs-postgres-1 \
  psql -U $POSTGRES_USER -d $POSTGRES_DB

# Старт всего остального с GPU overlay
docker compose \
  -f docker-compose.doc-platform.yml \
  -f docker-compose.local-models.yml \
  -f docker-compose.gpu.yml \
  up -d
```

### 4. Скачать модели на новый GPU

`ollama-bootstrap` стартует автоматически по списку из `OLLAMA_PULL`.
По умолчанию — `qwen2.5:7b,qwen2.5-vl:7b`. Можно переопределить:

```bash
OLLAMA_PULL="qwen2.5:14b-instruct-q4_K_M,qwen2.5-vl:7b" \
  docker compose -f ... up -d ollama-bootstrap
```

### 5. Переключить inference на GPU-модель

```bash
# В inference-service/.env поправить:
sed -i 's|^OPENAI_MODEL=.*|OPENAI_MODEL=qwen2.5-vl:7b|' inference-service/.env

# Recreate
docker compose -f docker-compose.doc-platform.yml \
  up -d --force-recreate inference
```

### 6. Проверка GPU работает

```bash
# Должна показать загрузку GPU при запросе
docker exec parsdocs-ollama ollama ps

# Прогон документа:
curl -X POST http://localhost:8085/api/v1/jobs \
  -F file=@test.pdf -F document_hint=invoice

# Время ответа должно быть 3-5 сек (vs 30-60 сек на CPU)
```

### 7. Обновить nginx Павла

Сменить `proxy_pass parsedocs.taipit.ru → новый_IP:8085`.

## Ожидаемые улучшения

| Метрика | CPU (текущий) | GPU 16GB |
|---------|---------------|----------|
| qwen2.5:7b inference | 3-4 мин | 2-5 сек |
| qwen2.5-vl:7b inference | N/A (OOM) | 5-10 сек |
| Document throughput | ~1/мин | ~10-20/мин |
| Параллельная обработка | concurrency=1 | concurrency=4-8 |
| Vision OCR (без Tesseract) | — | Да |

## Откат

Если что-то пошло не так — старый хост `10.10.13.10` остаётся живым,
nginx Павла переключается обратно в одну строчку. Volumes на старом
хосте не трогаем до окончательного подтверждения.

## Cost-estimate (если арендовать cloud)

| Провайдер | Карта | ~Цена/мес | Примечание |
|-----------|-------|-----------|------------|
| Yandex.Cloud | T4 16 GB | ~40,000 ₽ | Российский, удобно с TAIPIT |
| VK.Cloud | A100 80 GB | ~150,000 ₽ | Дорого, но мощно |
| Immers.AI | RTX 4090 | ~30,000 ₽ | Дешёвый вариант |
| Selectel | RTX A4000 | ~25,000 ₽ | Дёшево, доступно |

Для demo/тестов — почасовая аренда от 60-100 ₽/час, итого ~5,000 ₽ за рабочую неделю.
