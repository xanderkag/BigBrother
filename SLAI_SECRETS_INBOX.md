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

**Тип:** age (https://age-encryption.org)
**Получатель:** Aleksandr Liapustin / parsdocs-ops
**Public key:**
```
age1<TODO: владелец сгенерирует через `age-keygen` и положит publk-часть>
```

> Если у вас другой формат предпочтительнее (PGP/GPG ключ Гитхаба, 1Password
> shared vault, Telegram secret-chat) — напишите в `INTEGRATION_QUEUE.md`,
> переключим канал.

**Альтернативно** (если age недоступен) — Telegram `@xanderkag` с сообщением
«envelope для SLAI_SECRETS_INBOX», передадим временный ключ.

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
