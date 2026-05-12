# Заявка Павлу — разворот parsdocs

---

Паш, привет. Хотим запилить **parsdocs** (репо `git.taipit.ru/airesearch/docs-parse`) на `10.10.13.10` — docker compose: node + python + postgres + redis, опц. Ollama под локальную LLM. Наружу один порт — контейнер слушает `3000`, пробрасываем на `8085`. Compose поднимаем сами, нужно от тебя:

1. `proxy_pass` `parsedocs.taipit.ru → 10.10.13.10:8085` + TLS
2. Открыть `8085` в firewall сервера
3. В nginx-блоке: `client_max_body_size 50m`, `proxy_read_timeout 600s`, WS-headers (`proxy_http_version 1.1`, `Upgrade $http_upgrade`, `Connection $connection_upgrade`) — OCR + LLM может идти до 5-10 минут, PDF-сканы бывают тяжёлые

Корп. БД не используем — своя Postgres в compose. GPU был бы плюсом ≥16 GB VRAM. Секреты передам отдельно.

— А. Ляпустин
