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
**Public key:**
```
age1<TODO-2026-05-30: владелец сгенерирует через `age-keygen` и положит сюда publk-часть>
```

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
- **From:** SLAI_DEV
- **To:** PARSDOCS_DEV
- **Status:** `PENDING` (ETA от SLAI: 2026-05-30)
- **Тип секрета:** webhook HMAC-secret (`openssl rand -hex 32`)
- **Назначение:** parsdocs→SLAI webhook auth. `X-Parsdocs-Signature:
  sha256=hmac(secret, raw_body)` подписывается этим секретом, SLAI verify'ит
  на `POST https://api.demo.sls24.ru/api/v1/parsdocs/webhook`.

#### Envelope
<ждём от SLAI>

#### Применение
После RECEIVED:
1. Расшифровать envelope.
2. Положить в `provider_settings` (новый kind=`webhook_outbound` или extra на
   существующем slai-провайдере) ИЛИ в env `SLAI_WEBHOOK_SECRET`.
3. Включить F3 items 1+3 (webhook-receiver на нашей стороне для приёма
   acknowledge'ов от SLAI после processing).
4. Перевести этот блок в Status: APPLIED + написать commit ID + дата.

---

### S2. SANDBOX_TENANT_TOKEN (AC9 closure)

- **Asked:** 2026-05-29 (наш `PARSDOCS_FOLLOWUP_2026-05-29_OLD_OPEN_QUESTIONS.md` §AC9)
- **From:** PARSDOCS_DEV → SLAI_DEV (мы шлём токен ИМ)
- **Status:** `PENDING` (ожидает: P0 deploy → INSERT INTO organizations →
  INSERT INTO personal_access_tokens → envelope)
- **Тип секрета:** personal_access_token (60+ hex)
- **Назначение:** SLAI ↔ sandbox-тенант для contract-test'ов их
  ParsdocsAdapter. Параметры тенанта (закрыто в FOLLOWUP §AC9):
  - separate organization (option 1)
  - retention 7d
  - rate-limit 60 req/min

#### Envelope
<сгенерируем после деплоя, попросим у SLAI их age public key через
`xanderkag/SLAI/docs/SLAI_SECRETS_INBOX.md`>

#### Применение
После генерации:
1. `INSERT INTO organizations (name='slai-sandbox', type='external', ...)`
2. `INSERT INTO personal_access_tokens (organization_id=<above>, ...)`
3. Конфигурация retention/rate-limit в org-settings.
4. Envelope + положить в SLAI inbox.
5. Status: APPLIED.

---

## История

- 2026-05-29: файл создан как реакция на SLAI FOLLOWUP § «канал для секретов».
  Заведены S1 (их→наш webhook secret) и S2 (наш→их sandbox token).
