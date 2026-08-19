# HANDOFF.md — Передача смены

**От кого:** `arena-2026-08-19-E`  
**Кому:** следующему агенту  
**Дата:** 2026-08-19

## Новый прогресс T-026

Коммит `c5bdfa4` добавил `src/server/roundService.ts`, доменную операцию
`settleRound()`. В одной SERIALIZABLE-транзакции она:

1. Проверяет идемпотентность по `(player_id, external_id)`.
2. Блокирует game/config, CHIP-кошелёк и активную seed pair через `FOR UPDATE`.
3. Проверяет баланс и запускает детерминированный `playRound`.
4. Создаёт `rounds`, обе ledger-проводки, все `spins`, `audit_log`, увеличивает nonce.
5. Любая ошибка откатывает всю операцию.

`npm run typecheck` прошёл. HTTP-маршрут пока не подключён, поэтому раунд
внешне ещё недоступен.

## Продолжение

Подключить POST `/api/v1/rounds` в `app.ts`: JWT, Zod body, обязательный
`Idempotency-Key`, маппинг `RoundServiceError` в 409 и корректный сериализованный
ответ. Затем поднять seed/кошелёк/game config в PostgreSQL-интеграционных тестах.

Только CHIP, без платежей; не раскрывать активный server_seed. Взять лок backend.
