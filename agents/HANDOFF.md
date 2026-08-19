# HANDOFF.md — Передача смены

**От кого:** `arena-2026-08-19-I`
**Кому:** следующему агенту
**Дата:** 2026-08-19

## Что сделано в смену I

Продолжил после смены H по запросу пользователя "+" (продолжай работу).

**T-030 — деплой (P1):**
- `Dockerfile` — API: node:20-alpine, build + `node build/server/migrate.js && node build/server/main.js`
- `client/Dockerfile` — multi-stage: node build + nginx:alpine, копирует dist в /usr/share/nginx/html
- `client/nginx.conf` — прокси `/api/` → `http://api:3000/api/`, SPA fallback
- `docker-compose.yml` — db (postgres:16-alpine healthcheck), api, client, volume pgdata, env из .env
- `.env.example`, `.dockerignore`, `docs/DEPLOY.md` — быстрый старт, curl проверки, чек-лист HTTPS/бэкапов
- Проверено: `npx tsc --noEmit` зелёный, `npm test` 117 pass

**T-031 — админка (P1):**
- `src/server/admin.ts` — 5 роутов: `/admin/players`, `/admin/rounds`, `/admin/stats`, `/admin/rtp` (через `checkRtp`), `POST /admin/grant` (SERIALIZABLE, ledger grant, audit_log), проверка `X-Admin-Token`
- `app.ts` — регистрация если `ADMIN_TOKEN` задан
- `client/public/admin.html` — токен в localStorage `admin_token`, таблицы игроков/раундов, grant форма, RTP, stats, JS fetch

**T-032 — ADR-008:**
- Вторая игра на том же движке: `config/second-game.json`, `gameRegistry.ts`, `/games` возвращает 2 игры, `POST /rounds` выбирает cfg по `gameCode`, `multiGame.test.ts`

**T-033 — ADR-009:**
- Возрастной гейт 18+ и ToS/Privacy: модалка `#age-gate`, `docs/TERMS.md`, `docs/PRIVACY.md`, `client/public/terms.html` + `privacy.html`, footer

**Протокол:**
- `TASKS.md`: T-030…T-033 done, следующий ID T-034
- `STATE.md`: стадия 7, деплой и админка готовы
- `DECISIONS.md`: ADR-008 и ADR-009 добавлены, следующий ADR-010
- Лок `infra` снят

## Для следующего агента

Бэклог снова пуст. Варианты:

1. **Реальный деплой на VPS:** проверить `docker compose up`, домен, HTTPS (Let's Encrypt), бэкапы pgdata, логи аудита.
2. **История раундов в клиенте:** экран списка раундов с пагинацией `GET /rounds`, клик → полная карточка + верификация.
3. **Улучшить админку:** графики RTP (Chart.js), активность по дням, блок игрока (status suspended), поиск по username.
4. **Тесты для админки:** интеграционные тесты grant и rtp endpoint с ADMIN_TOKEN.
5. **Безопасность:** проверить, что `ghp_...` токен из чата отозван. Если нет — написать владельцу ещё раз.

Перед стартом:
```bash
git pull --rebase origin main
cat agents/STATE.md agents/HANDOFF.md
tail -50 agents/JOURNAL.md
ls agents/locks/
```

Если решишь делать админку — бери лок `frontend` или `backend`. Для деплоя — `infra`.

