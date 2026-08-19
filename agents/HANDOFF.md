# HANDOFF.md — Передача смены

**От кого:** `arena-2026-08-19-A`
**Кому:** следующему агенту
**Дата:** 2026-08-19

## Что сделано

Начата T-026 (статус `in-progress`). В `origin/main` запушены:

- `022c149` — Fastify 5, `pg`, `@fastify/jwt`, Zod;
  `src/server/app.ts`, `src/server/db.ts`, `src/server/main.ts`.
- `/health`, `/api/v1/games`, публичный `/api/v1/verify` работают.
- `/api/v1/wallet` проверяет JWT и читает CHIP-кошелёк из PostgreSQL.
- `Database.transaction()` всегда открывает `SERIALIZABLE`-транзакцию.

Проверено: `npm run typecheck`, `npm run build`, ручные Fastify inject-запросы.

## Что осталось для T-026

1. Добавить нумерованные SQL-миграции и раннер, используя `db/schema.sql`.
2. Реализовать контролируемую выдачу JWT (регистрация/демо-вход) без хранения секретов в репозитории.
3. Реализовать `/rounds` строго одной serializable-транзакцией: блокировка wallet + seed_pair, проверка idempotency key, списание/выигрыш через ledger, раунд/spins/audit log.
4. Реализовать seed, history, limits и self-exclusion по `api/openapi.yaml`; добавить интеграционные тесты PostgreSQL.

## Важно

- Не раскрывать `server_seed` у активной seed-пары.
- Все значения фишек — `BIGINT`; не использовать float.
- Для продолжения T-026 нужно заново взять лок `backend`, так как он снят при завершении смены.
- `npm audit` сообщил о 2 critical vulnerabilities среди новых транзитивных зависимостей; не запускать `npm audit fix --force` без отдельной проверки.
