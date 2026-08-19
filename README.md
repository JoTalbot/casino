# casino

Исследовательско-инженерный проект: **как построить собственное онлайн-казино со слотами** — от математики игры до архитектуры, юридической рамки и экономики.

> ⚠️ **Для ИИ-агентов и новых участников: сначала прочитайте [`AGENTS.md`](AGENTS.md).** Это обязательный протокол работы.

---

## Быстрый старт для агента

```
1. AGENTS.md              — протокол работы (обязательно, целиком)
2. agents/STATE.md        — где сейчас проект
3. agents/HANDOFF.md      — что передал предыдущий агент
4. agents/TASKS.md        — взять задачу
5. agents/QUESTIONS.md    — открытые вопросы к владельцу
```

---

## Структура репозитория (актуальная)

```
AGENTS.md                 Протокол работы для всех ИИ-агентов
agents/                   STATE, HANDOFF, TASKS, JOURNAL, DECISIONS, GLOSSARY, locks
research/                 01-ARCHITECTURE … 08-PAYMENTS-PSP, SOURCES
config/                   game.json (Crown of Fortune) + second-game.json (Crown II)
slotmath/                 Математика на Python
src/
  engine/                 rng.ts, paylines.ts, round.ts, responsible.ts, multiGame.test.ts
  server/                 Fastify API: app.ts, db.ts, auth.ts, seeds.ts, history.ts,
                          responsibleService.ts, monitoring.ts, gameRegistry.ts,
                          admin.ts, rateLimit.ts, migrate.ts, main.ts
client/                   PixiJS v8 + pixi-reels, api.ts, main.ts, symbols.ts,
                          public/terms.html, privacy.html, admin.html
db/migrations/            0001_init.sql + schema_migrations
api/openapi.yaml          Спецификация REST API
verifier/verify.html      Офлайн-верификатор
docs/                     PAR-SHEET, DB-SCHEMA, API, RESPONSIBLE-GAMING,
                          TERMS, PRIVACY, DEPLOY
scripts/                  build_game.py, simulate.py, confidence.py, e2e.js, crosscheck.py, check_protocol.py
```

---

## Состояние проекта — 2026-08-19

**Стадия: 7 из 9 — боевая платформа с деплоем и админкой.**

Актуальный статус в [`agents/STATE.md`](agents/STATE.md).

**Тип продукта: вариант A — соц-казино на виртуальных фишках** (ADR-004). Реальных денег нет, Q-006 открыт.

### Что уже работает

| Компонент | Состояние |
|---|---|
| Математика 2 игры 5×3, 20 линий | RTP 95.98%, 30M спинов, PAR sheet 10 разделов |
| Provably fair RNG HMAC-SHA256 | 40 тестов, verify + rotate |
| Движок раунда TS | сверен с Python по 26 фикстурам (136 спинов), multiGame тест |
| Учебный devServer | :3001, состояние в памяти |
| Боевой бэкенд Fastify | /auth/demo JWT, /games (2 игры), /seeds/*, /rounds с Idempotency-Key и SERIALIZABLE, /wallet, /limits, /self-exclusion, /monitoring/rtp, /admin/*, rate limiting 10/s, reality check |
| БД PostgreSQL 16 | миграции с checksum, ledger двойная запись, seed_pairs, audit_log append-only |
| Клиент PixiJS v8 | барабаны садятся на серверную сетку, JWT + Idempotency, выбор игры, история раундов с модалкой, верификатор в модалке, RG-экран (лимиты + самоисключение), age-gate 18+ модалка, reality check модалка, footer ToS/Privacy |
| Админка | /admin.html — игроки, раунды, stats, grant, block, RTP, daily графики Chart.js, поиск по username/status, экспорт audit CSV |
| Деплой | Dockerfile API + client/Dockerfile nginx, docker-compose.yml (db+api+client), .env.example, docs/DEPLOY.md |
| Мониторинг RTP | ADR-007: интервал от фактического n, алерт от 100k раундов, /monitoring/rtp и /admin/daily |
| ToS/Privacy | docs/TERMS.md, docs/PRIVACY.md, client/public/terms.html, privacy.html, admin.html |
| CI | engine, server+PG, client, math, protocol — зелёный |
| Тесты | 117 TS + 35 round + 37 confidence + 21 клиент = 210 (3 PG интеграционных skip без БД) |

---

## Запуск

### Быстрый старт с Docker (рекомендуется)

```bash
cp .env.example .env
# отредактируй POSTGRES_PASSWORD и JWT_SECRET (openssl rand -hex 32)

docker compose up -d --build
docker compose logs -f api
# клиент http://localhost:8080
# API http://localhost:3000/health
```

Подробности — `docs/DEPLOY.md`.

### Учебный режим (без БД)

```bash
npm install
npm run client:install
npm run dev:server   # :3001 учебный, состояние в памяти
npm run dev:client   # :5173 Vite прокси /api → :3001
```

### Боевой режим без Docker

```bash
npm ci
npm run build
DATABASE_URL=postgresql://... JWT_SECRET=... ADMIN_TOKEN=... node build/server/migrate.js
DATABASE_URL=... JWT_SECRET=... ADMIN_TOKEN=... node build/server/main.js
# client: npm --prefix client run build + nginx с client/nginx.conf
```

### e2e полная проверка

```bash
# API должен быть запущен
node scripts/e2e.js http://localhost:3000 $ADMIN_TOKEN
```

Открой http://localhost:8080, пройди age-gate 18+, спин, проверь историю, лимиты, верификатор, админку /admin.html (нужен ADMIN_TOKEN в localStorage).

---

## Проверки

```bash
npm test                   # движок + API (117 тестов)
npm run client:test        # клиент 21 тест, 136 спинов на барабанах
python3 tests/test_round.py
python3 tests/test_confidence.py
python3 scripts/crosscheck.py
python3 scripts/check_protocol.py
npm run ci                 # всё как в CI
node scripts/e2e.js        # e2e против живого API
```

CI `.github/workflows/ci.yml` — 5 задач: engine, server+PG, client, math, protocol.

---

## Ключевые выводы

**Техника**
- RNG только на сервере, CSPRNG. Деньги — BIGINT.
- Provably fair commit-reveal HMAC-SHA256 + offline verifier.
- Стек: PixiJS v8 + pixi-reels, Fastify 5 + PostgreSQL 16 + JWT + SERIALIZABLE, Python numpy.
- Клиент не решает исход: `setResult()` + нормализаторы.

**Математика**
- RTP 95.98% аналитика, 95.93% на 30M, hit 25.9%, sigma 4.126.
- Разброс: на 1k раундов RTP 74.6–125.5%, поэтому коридор 95.5–96.5% только от 5M (ADR-007).
- Банкролл ~987 ставок под 1% Ruin.

**Ответственная игра**
- Лимиты ДО списания по худшему исходу, ужесточение сразу, ослабление через 24ч охлаждения.
- Самоисключение необратимо, только удлинение.
- Reality check каждые 60 минут — модалка, счётчики из БД по календарным окнам UTC (T-027).

**Юридическое**
- Вариант A без покупок — низкий риск, но после High 5 Games $24.9M (2025) и иска WA vs Playtika/Aristocrat $225M+ (2026) граница чёткая: момент покупки фишек = конец варианта A (Q-006 🔴).
- Apple — только юрлица, 18+. Google Play — ToS, Privacy, RG, дисклеймер.
- Украина: ст.203-2 УК, закон 4116-20, PlayCity, ДСОМ.
- ToS/Privacy готовы (docs/TERMS.md, docs/PRIVACY.md), age-gate 18+.

**Экономика**
- LTV ≥ 3×CPA, аффилиаты 20–40% NGR, rolling reserve 5–10% на 180 дней.

---

## Дисклеймер

Материалы носят исследовательский характер, не юр./фин. консультация. Запуск с реальными деньгами без лицензии противоправен. Азартные игры вызывают зависимость — обязательны лимиты, самоисключение, reality check.

