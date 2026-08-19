# Деплой — Crown of Fortune (соц-казино)

**Дата:** 2026-08-19 · **Задача:** T-030 · **Агент:** arena-2026-08-19-I

## Быстрый старт (Docker)

```bash
cp .env.example .env
# отредактируй POSTGRES_PASSWORD и JWT_SECRET в .env
# JWT_SECRET: openssl rand -hex 32

docker compose up -d --build
docker compose logs -f api
```

Открой:
- клиент: http://localhost:8080 (прокси /api → api:3000)
- API health: http://localhost:3000/health
- прямой API: http://localhost:3000/api/v1/games

Остановить:
```bash
docker compose down
# с удалением данных: docker compose down -v
```

## Что внутри

- `db` — postgres:16-alpine, volume `pgdata`, healthcheck `pg_isready`
- `api` — Node 20, Fastify, `build/server/main.js`. При старте `node build/server/migrate.js` применяет миграции `db/migrations/0001_init.sql` с проверкой checksum.
- `client` — Node build + nginx:alpine, `client/nginx.conf` проксирует /api/ на `http://api:3000/api/`.

## Переменные окружения

| Переменная | Обязательно | Пример |
|---|---|---|
| `DATABASE_URL` | да | `postgresql://casino:secret@db:5432/casino` |
| `JWT_SECRET` | да | 64+ hex символов |
| `PORT` | нет | 3000 |
| `POSTGRES_USER/PASSWORD/DB` | для compose | см. .env.example |

## Миграции

Выполняются автоматически в Dockerfile CMD. Вручную:

```bash
# локально
npm run migrate
# или
DATABASE_URL=... node build/server/migrate.js
# в контейнере
docker compose exec api node build/server/migrate.js
```

Миграции нумерованные `0001_*.sql`, хранятся в `schema_migrations` с SHA-256. Повторный запуск — no-op, изменение файла после применения — ошибка.

## Клиент без Docker

```bash
npm ci
npm run client:install
npm run dev:server   # учебный сервер :3001 (без БД)
npm run dev:client   # Vite :5173 прокси /api → :3001
```

Боевой режим:
```bash
DATABASE_URL=... JWT_SECRET=... npm run build
DATABASE_URL=... JWT_SECRET=... node build/server/main.js
# клиент: npm --prefix client run build, затем nginx с client/nginx.conf
```

## Проверка после деплоя

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/api/v1/auth/demo
# токен из ответа
TOKEN=...
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/wallet
curl -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: test1" -H "content-type: application/json" \
  -d '{"gameCode":"crown-of-fortune","betPerLine":10,"lines":20}' \
  http://localhost:3000/api/v1/rounds
```

## Токены и секреты — КРИТИЧНО

- Никогда не коммить `.env` с реальными секретами (в `.gitignore` уже есть).
- `JWT_SECRET` должен быть уникальным на окружение.
- GitHub PAT, который был в чате, должен быть отозван немедленно (см. STATE.md §5).

## Продакшн чек-лист

- [ ] Сменить все секреты в `.env`
- [ ] Включить HTTPS (nginx + Let's Encrypt, или Cloudflare)
- [ ] Ограничить `db` порты наружу (убрать `ports` из compose, оставить только внутри сети)
- [ ] Бэкапы `pgdata` ежедневно
- [ ] Мониторинг RTP: `GET /api/v1/monitoring/rtp` (алерт от 100k раундов)
- [ ] Логи аудита: `audit_log` таблица append-only
- [ ] Age-gate 18+ и ToS/Privacy уже в клиенте
