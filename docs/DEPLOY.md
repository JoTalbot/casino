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

---

## Развёртывание на общем (занятом) сервере — T-183, T-188

Сценарий: на машине уже работают чужие сервисы, свободных «красивых» портов
нет, ломать ничего нельзя. Именно так проект развёрнут на боевом сервере
владельца.

### Принципы

1. **Ничего не ставим в систему.** Node на хосте может быть любой версии —
   всё собирается и работает внутри контейнеров.
2. **Порты только явные и свободные.** Проверять `ss -tln`, брать значения
   вне эфемерного диапазона (`cat /proc/sys/net/ipv4/ip_local_port_range`).
3. **Наружу — только витрина.** API и PostgreSQL остаются на `127.0.0.1`
   и в compose-сети; клиентский nginx проксирует `/api/` внутрь.
4. **Проект compose именованный** (`-p casino`) — контейнеры и сеть не
   пересекаются с чужими.

### Запуск

```bash
git clone https://github.com/JoTalbot/casino.git /root/casino
cd /root/casino

# .env: секреты генерируются на месте, в git не попадают
{
  echo "POSTGRES_USER=casino"
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "POSTGRES_DB=casino"
  echo "JWT_SECRET=$(openssl rand -hex 48)"
  echo "ADMIN_TOKEN=$(openssl rand -hex 24)"
  echo "API_PORT=21110"
  echo "CLIENT_PORT=21899"
  echo "CLIENT_BIND=127.0.0.1"
} > .env
chmod 600 .env

docker compose -p casino \
  -f docker-compose.yml -f deploy/docker-compose.shared-host.yml up -d --build
```

`CLIENT_BIND=0.0.0.0` ставится только тогда, когда витрину открывают наружу.

Оверлей `deploy/docker-compose.shared-host.yml` прибивает порты к localhost и
полностью снимает публикацию порта PostgreSQL.

> **Грабли.** В оверлее у `ports` обязателен тег `!override`. Без него compose
> **складывает** списки портов с базовым файлом: контейнер пытается занять один
> и тот же порт дважды и падает с `address already in use` на заведомо
> свободном порту.

### Доступ снаружи

Вариант «без изменений на хосте» — SSH-туннель:

```bash
ssh -L 8899:127.0.0.1:21899 root@HOST     # затем http://localhost:8899
```

Вариант «открытый порт»: `CLIENT_BIND=0.0.0.0` в `.env`, пересоздать клиент и
добавить правило `ufw allow 21899/tcp`. Помните: публикация порта в Docker идёт
через цепочку `DOCKER-USER` и **обходит UFW**, поэтому `0.0.0.0` открывает порт
даже без правила — правило нужно как явная фиксация намерения.

Вариант «через существующий nginx»: добавлять **отдельным файлом** в
`sites-available` и проверять, что `server_name` не пересекается с чужими
сайтами (`grep -rh server_name /etc/nginx/sites-enabled/`). Существующие
конфиги не редактировать; после правки — обязательно `nginx -t`.

### Проверка после развёртывания

```bash
docker compose -p casino ps
docker logs casino-api-1 | grep -i миграц          # 0001…0005 применены
curl -s http://127.0.0.1:21110/health
docker exec casino-db-1 psql -U casino -d casino -tAc \
  "SELECT count(*) FROM wallet_balance_mismatch;"  # обязан быть 0
```

Прогон интеграционных тестов на **отдельной** базе, не трогая боевую:

```bash
docker exec casino-db-1 createdb -U casino casino_test
docker run --rm --network casino_default -v /root/casino:/app -w /app \
  -e TEST_DATABASE_URL="postgresql://casino:ПАРОЛЬ@db:5432/casino_test" \
  node:20-alpine sh -c "npm ci && npm test"
```
