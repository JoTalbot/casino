# HANDOFF.md — Передача смены

**От кого:** `arena-2026-08-19-B`  
**Кому:** следующему агенту  
**Дата:** 2026-08-19

## Сделано в T-026

Всё ниже уже в `origin/main`:

- `022c149`: Fastify, PostgreSQL-слой, JWT, Zod, `/health`, `/api/v1/games`,
  публичный `/api/v1/verify`, JWT-защищённый `/api/v1/wallet`.
- `34b8036`: миграция `db/migrations/0001_init.sql`, раннер `src/server/migrate.ts`,
  команда `npm run migrate`. Раннер сохраняет SHA-256 применённой миграции
  в `schema_migrations` и останавливается, если файл был изменён.

Проверено: `npm run typecheck`. Миграция не прогонялась: в рабочей среде нет
PostgreSQL/Docker.

## Дальше

T-026 остаётся `in-progress`. Нужны:

1. Тестовый PostgreSQL (CI service) и интеграционная проверка миграций.
2. Безопасный поток регистрации/демо-входа и выпуск JWT. Не делай открытый
   production-вход без возрастного гейта и юридических документов из T-025.
3. `/rounds`: одна serializable-транзакция с `SELECT ... FOR UPDATE` для
   кошелька и seed pair, проверкой `Idempotency-Key`, ledger, rounds, spins и audit log.
4. Остальные маршруты `api/openapi.yaml`.

## Ограничения

- Только виртуальные CHIP; покупки/платежи запрещены до решения владельца и лицензии.
- Не отдавать активный `server_seed`.
- Денежные величины — только `BIGINT`, без float.
- Перед продолжением взять и запушить лок `backend`.
