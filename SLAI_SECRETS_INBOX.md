# SLAI Secrets Inbox

> **Назначение:** канал для передачи envelope-encrypted секретов между SLAI и
> parsdocs командами. Никаких plaintext ключей в git. Расшифровка — нашим
> приватным ключом (см. §Recipient public key).

---

## Convention

Каждый pending-secret = блок в этом файле:

```
### <ID>. <короткое название>

- **Asked:** YYYY-MM-DD
- **From:** SLAI_DEV | PARSDOCS_DEV
- **To:** PARSDOCS_DEV | SLAI_DEV
- **Status:** `PENDING` | `RECEIVED` | `APPLIED` | `ROTATED`
- **Тип секрета:** webhook-secret | api-key | service-token | другое

#### Envelope (PGP / age-encrypted)
```
-----BEGIN PGP MESSAGE-----
...
-----END PGP MESSAGE-----
```

#### Применение
<куда положили, какой env / DB row / commit>
```

После applied — секрет дешифрован, записан в `provider_settings` (encrypted-
at-rest, `SECRETS_ENCRYPTION_KEY`) или в env. Envelope из inbox можно
удалить через 30 дней (грейс на rollback).

---

## Recipient public key (parsdocs)

**Тип:** age (https://age-encryption.org) — современная замена PGP, без
веб-серверов ключей, простая CLI, проверенная криптография.

**Получатель:** Aleksandr Liapustin / parsdocs-ops
**Public key (age v1.2.1, сгенерировано 2026-05-31):**
```
age1xn6dalaepv98wve3a7te2pkyhzp8jawwkt9f4df4t3zw4e84tgkqed5wcq
```

Соответствующий приватный ключ лежит в `~/.age/parsdocs.key` у владельца
(локально, не в git). Бэкап — TODO владельцу (1Password / encrypted USB).
Ротация: при подозрении на компрометацию — `age-keygen -o` новый, обновить
public key выше + переотправить активные envelope'ы. Никаких pending PR
не теряем — age envelope'ы привязаны к одному получателю на момент
шифрования, дешифровка идёт под СТАРЫМ ключом.

### Установка `age` (одноразово)

| OS | Команда |
|----|---------|
| macOS | `brew install age` |
| Ubuntu/Debian | `sudo apt install age` |
| Arch | `pacman -S age` |
| Windows | `winget install FiloSottile.age` или https://github.com/FiloSottile/age/releases |

### Генерация публичного ключа получателя (parsdocs-side, разово)

```bash
mkdir -p ~/.age && chmod 700 ~/.age
age-keygen -o ~/.age/parsdocs.key
# Выведет на экран строку "Public key: age1xxxxxxxxxxxxxxxx" — это её
# нужно положить в этот файл выше как Recipient public key.
grep "^# public key:" ~/.age/parsdocs.key | awk '{print $NF}'
```

`~/.age/parsdocs.key` — приватный ключ, **никогда не коммитить**. Бэкап
держать отдельно (1Password / зашифрованный USB / encrypted-фолдер).

### Шифрование секрета (SLAI-side, под каждый PR)

```bash
# Кладём plaintext во временный файл (можно прямо из stdin)
echo "PARSDOCS_WEBHOOK_SECRET=abcdef0123456789...64hex" > /tmp/secret.txt

# Шифруем под публичный ключ parsdocs
age -r age1<PUBLIC-KEY-FROM-INBOX> -o /tmp/secret.age /tmp/secret.txt

# armor-вариант (текстовый, для удобной вставки в PR markdown)
age -r age1<PUBLIC-KEY> -a /tmp/secret.txt > /tmp/secret.age.txt

# Удаляем plaintext (важно!)
shred -u /tmp/secret.txt
```

Содержимое `/tmp/secret.age.txt` (multiline `-----BEGIN AGE ENCRYPTED FILE-----`)
кладём в блок `#### Envelope` соответствующего S-блока.

### Дешифровка (parsdocs-side, после получения PR)

```bash
age -d -i ~/.age/parsdocs.key /tmp/secret.age > /tmp/secret.txt
# Или сразу в env:
SECRET=$(age -d -i ~/.age/parsdocs.key /tmp/secret.age)
echo $SECRET  # проверить → положить в нужное место
shred -u /tmp/secret.txt
```

> Если age недоступен (не можете поставить) — Telegram `@xanderkag`
> сообщением «envelope для SLAI_SECRETS_INBOX», передадим временный
> канал (1Password shared vault либо secret-chat).

---

## Pending

### S1. PARSDOCS_WEBHOOK_SECRET (Q4 closure)

- **Asked:** 2026-05-29 (SLAI FOLLOWUP §Q4)
- **Received:** 2026-06-01 (SLAI prod-pragmatic decision — plain text в чат для
  ускорения пилота; договорились перешифровать age после WW-23 если решат)
- **Applied:** 2026-06-01 (UPDATE organization_settings SET
  webhook_hmac_secret = '...' WHERE organization_id =
  '9a3cb9d3-e997-4669-a822-f8294f0dfed3')
- **From:** SLAI_DEV → PARSDOCS_DEV
- **Status:** `APPLIED` (secret в БД на хосте Asha, длина 64 hex, для
  outbound webhook на api.demo.sls24.ru)
- **Тип секрета:** webhook HMAC-secret (64 hex)

#### Envelope
<plain text доставлен через чат 2026-06-01; в git plaintext НЕ попадает>

#### Применение
1. ✅ UPDATE organization_settings.webhook_hmac_secret для org 9a3cb9d3
2. Outbound webhook теперь подписывается этим секретом для
   `api.demo.sls24.ru` (slai-sandbox)
3. **TODO**: вопрос SLAI — нужен ли отдельный secret для negabarit
   (org 73d314a6, webhook negabarit.sls24.ru)? Сейчас webhook_hmac_secret
   для negabarit пустой → используется глобальный env-fallback.

---

### S3. SANDBOX_TENANT_TOKEN — slai-negabarit (Q-NEG-1)

- **Asked:** 2026-06-01 (SLAI: «нужен второй sandbox под negabarit-стенд»)
- **Provisioned:** 2026-06-01 on Asha
- **From:** PARSDOCS_DEV → SLAI_DEV
- **Status:** `DELIVERED_PLAIN` (передан в чат plain, договорились пилотный
  режим — без age envelope)

```
organization_id : 73d314a6-c6bf-4860-a910-548fb6040d65
user_id         : 9aac6337-b406-4b5f-a226-e0058044ea16
token_name      : slai-negabarit-bot
expires_at      : ~2026-08-30 (90 дней)
webhook_url     : https://negabarit.sls24.ru/api/v1/parsdocs/webhook
host            : https://vanga.sls24.ru
```

Token: <plain text delivered via chat 2026-06-01; не пишется в git>

### S2. SANDBOX_TENANT_TOKEN (AC9 closure) — slai-sandbox

- **Asked:** 2026-05-29 (наш `PARSDOCS_FOLLOWUP_2026-05-29_OLD_OPEN_QUESTIONS.md` §AC9)
- **From:** PARSDOCS_DEV → SLAI_DEV (мы шлём токен ИМ)
- **Status:** `PROVISIONED, AWAITING SLAI age public key` (2026-05-31)
- **Тип секрета:** personal_access_token (~50 chars, prefix `pdpat_`)
- **Назначение:** SLAI ↔ sandbox-тенант для contract-test'ов их
  ParsdocsAdapter. Параметры тенанта (закрыто в FOLLOWUP §AC9):
  - separate organization ✅ (option 1)
  - retention: общий `FILE_RETENTION_DAYS=30` хоста Asha (per-tenant в БД-
    схеме пока нет — это TODO миграции, для одного арендатора достаточно)
  - rate-limit: общий `RATE_LIMIT_PER_MINUTE` хоста (per-tenant TODO)
  - token expires_at: now + 90 дней

#### Provisioned (2026-05-31 on Asha)

```
organization_id: 9a3cb9d3-e997-4669-a822-f8294f0dfed3
user_id:         fc9f3f6e-876e-4b07-aef6-7a85d48af698
token_name:      slai-sandbox-bot
expires_at:      ~2026-08-29
webhook_url:     https://api.demo.sls24.ru/api/v1/parsdocs/webhook
host:            https://vanga.sls24.ru (Asha)
```

#### Envelope
<plain text доставлен в чат 2026-06-01; SLAI pragmatic decision — без age
envelope для пилота. В git plaintext НЕ попадает.>

Status: `DELIVERED_PLAIN`

#### Применение SLAI-side
1. Принять envelope из своего inbox.
2. Дешифровать: `age -d -i ~/.age/slai.key envelope.age > /tmp/token.txt`.
3. Использовать как Bearer в HTTP: `Authorization: Bearer <token>`.
4. Endpoint: `POST https://vanga.sls24.ru/api/v1/jobs`.
5. Webhook от parsdocs прилетит на `https://api.demo.sls24.ru/api/v1/parsdocs/webhook`
   с заголовком `X-Parsdocs-Signature` (HMAC от S1 secret).

---

## История

- 2026-05-29: файл создан как реакция на SLAI FOLLOWUP § «канал для секретов».
  Заведены S1 (их→наш webhook secret) и S2 (наш→их sandbox token).
