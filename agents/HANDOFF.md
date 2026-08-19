# HANDOFF.md — Передача смены

**От кого:** `arena-2026-08-19-H`
**Кому:** следующему агенту
**Дата:** 2026-08-19

## Что сделано в смену H

Смена длилась весь день, закрыла 6 задач T-024 … T-029, которые висели с 17 августа.

**T-026 — боевой сервер:**
- Переписан `src/server/app.ts` на 600+ строк: добавлены /auth/demo, /games/:code (2 игры), /seeds/*, /rounds история, /wallet/transactions, /limits, /self-exclusion, /monitoring/rtp.
- Новые модули: `auth.ts` (guest player + wallet 100k + seed pair), `seeds.ts`, `history.ts`, `responsibleService.ts` (счётчики из БД по календарным окнам UTC — T-027), `monitoring.ts` (ADR-007, порог 100k), `gameRegistry.ts` (загрузка двух игр).
- `roundService.ts` теперь проверяет RG-лимиты и самоисключение ДО списания (canPlaceBet), считает loss/wager/spins из rounds, а не из памяти.
- Интеграционный тест `full.integration.test.ts`: demo → seeds → client seed → round → idempotent repeat → conflict → second round → history → wallet → transactions → rotate → seed history → verify → legacy round без Idempotency-Key. 15 шагов. SKIP без TEST_DATABASE_URL, зелёный в CI с Postgres.
- 117 тестов локально, typecheck зелёный.

**T-027 — календарные окна:**
- Реализовано в `responsibleService.ts` и `roundService.ts`: lossToday/wageredToday/spinsToday считаются запросом `SUM ... WHERE started_at >= сегодня 00:00 UTC`, lossThisWeek — 7 дней. Раньше жили в памяти devServer.

**T-024 — экран ответственной игры:**
- Клиент: новый card #rg-card в index.html, стили, селекты kind/value, кнопки set/refresh, список лимитов, self-exclusion селект.
- `client/src/api.ts`: добавлен JWT-флоу (localStorage casino_jwt, ensureAuth через /auth/demo, Authorization header, Idempotency-Key randomUUID), нормализаторы для совместимости с боевым и учебным сервером, новые методы limits(), setLimit(), selfExclude().
- `client/src/main.ts`: age gate логика + RG логика refreshRG(), лимиты и самоисключение с confirm.

**T-025 — ToS, Privacy, age gate:**
- docs/TERMS.md и docs/PRIVACY.md — полные тексты для соц-казино без реальных денег, с дисклеймером, 18+, provably-fair, самоисключением.
- client/public/terms.html и privacy.html — простые HTML-версии для стора.
- index.html: модалка #age-gate, localStorage age_verified, footer с ссылками на ToS/Privacy/верификатор.
- main.ts: checkAgeGate(), reload после подтверждения.

**T-028 — мониторинг RTP:**
- `src/server/monitoring.ts`: checkRtp() считает observed RTP, rounds, totalBet/Win, halfWidth = Z*sigma/sqrt(n), alert только от 100k.
- GET /monitoring/rtp в app.ts.

**T-029 — вторая игра:**
- config/second-game.json — Crown of Fortune II v1.1.0, те же ленты, другое имя.
- gameRegistry.ts: loadGames() грузит обе конфигурации, ensureAllGames().
- app.ts: /games возвращает обе, /games/:code для обеих, POST /rounds выбирает cfg по gameCode.
- src/engine/multiGame.test.ts — тест что движок играет обе игры детерминированно.

**Безопасность:**
- Обнаружена утечка GitHub PAT в сообщении пользователя. Токен использовался для клонирования, но должен быть немедленно отозван (AGENTS.md §2.5). В git config токен хранился в remote URL — это не сохраняется в снапшоте, но в логах GitHub Actions может остаться? Сообщить владельцу.

## Что важно продолжить

1. **Админка** — единственный кусок стадии 5, которого нет. Нужен список игроков, просмотр раундов, grant фишек, ручная блокировка.
2. **Деплой:** Docker + docker-compose с Postgres 16, env JWT_SECRET, DATABASE_URL, миграции при старте. Сейчас main.ts требует env, но нет Dockerfile.
3. **Клиент:** добавить экран истории раундов (GET /rounds) и верификатор не в отдельной странице, а в модалке клиента. Reality check показывается только в логе, надо показывать модалкой.
4. **Тесты:** добавить интеграционные тесты для RG-лимитов (лимит 1 спин → второй спин 409) и мониторинга RTP.

## Известные проблемы

- `gameRegistry` грузит только 2 файла хардкодом. Для 10+ игр нужен динамический скан `config/*.json`.
- `monitoring.ts` использует фиксированный SIGMA 4.126 и TARGET_RTP 0.959778, а не читает confidence.json. При смене математики надо обновить.
- `responsibleService` считает неделю как последние 7 дней, а не календарную неделю пн-вс. Для MVP ок, но для регулятора нужна календарная неделя в часовом поясе оператора.
- Age gate в localStorage легко обходится очисткой. Для веба это нормально (требование стора — показать, а не заставить), для нативного нужен нативный диалог.
- Токен GitHub PAT должен быть отозван владельцем немедленно. Я не могу отозвать чужой токен, только предупредить.

## Для следующего агента — чеклист старта

```bash
git pull --rebase origin main
cat agents/STATE.md agents/HANDOFF.md
cat agents/TASKS.md
tail -80 agents/JOURNAL.md
ls agents/locks/
```

Взять лок `backend` или `frontend` или `docs` — бэклог пуст, можно брать любую область для админки/деплоя.

Счастливо.
