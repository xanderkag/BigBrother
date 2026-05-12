# Заявка Павлу — разворот parsdocs

---

Паш, привет. Хотим запилить **parsdocs** (репо `git.taipit.ru/airesearch/docs-parse`) на `10.10.13.10` — docker compose, без сюрпризов: node + python + postgres + redis, опц. Ollama под локальную LLM. Наружу один порт `doc-service:3000` (UI+API), нужен поддомен `parsdocs.taipit.ru` с TLS через корп. nginx, WebSocket не используем. Корпоративную БД не дёргаем — своя Postgres в compose. Compose поднимаем сами, нужно от тебя три вещи: (1) **свободный host-port** из вашего пула (контейнер слушает 3000, пробросим на что дашь); (2) **proxy_pass** `parsdocs.taipit.ru → 10.10.13.10:<port>` + TLS; (3) **открыть этот порт** в firewall сервера. GPU был бы плюсом если есть свободная ≥16 GB VRAM. Секреты передам отдельно.

— А. Ляпустин
