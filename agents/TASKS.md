# TASKS.md — Очередь задач

Статусы: `todo` → `in-progress` → `blocked` / `review` → `done` / `cancelled`
Приоритеты: `P0` критично · `P1` важно · `P2` желательно · `P3` потом

**ID не переиспользуются.** Следующий свободный ID: **T-089**

---

## Активные и запланированные

**Весь бэклог T-001…T-088 закрыт.** Новых активных задач нет.

---

## Выполненные

| ID | Задача | Приоритет | Статус | Агент | Обновлено |
|----|--------|-----------|--------|-------|-----------|
| T-001 | Инициализация репозитория | P0 | done | claude-2026-08-17-A | 2026-08-17 |
| T-002 | Написать AGENTS.md — протокол для всех агентов | P0 | done | claude-2026-08-17-A | 2026-08-17 |
| T-003 | Создать систему контекста (STATE/HANDOFF/JOURNAL/DECISIONS/locks) | P0 | done | claude-2026-08-17-A | 2026-08-17 |
| T-004 | Глубокое исследование: техника, математика, право, экономика, комьюнити | P0 | done | claude-2026-08-17-A | 2026-08-17 |
| T-005 | Реестр источников research/SOURCES.md | P1 | done | claude-2026-08-17-A | 2026-08-17 |
| T-006 | Определить тип продукта (Q-001): соц-казино / B2B / лицензированный оператор | P0 | done | claude-2026-08-17-B | 2026-08-17 |
| T-007 | PAR sheet + симулятор RTP (Monte Carlo ≥10 млн спинов, цель 96%) | P0 | done | claude-2026-08-17-B | 2026-08-17 |
| T-008 | Прототип provably fair RNG (HMAC-SHA256, commit-reveal) + тесты | P0 | done | claude-2026-08-17-B | 2026-08-17 |
| T-009 | Разбор референсных open-source репозиториев, отчёт в research/06 | P1 | done | claude-2026-08-17-B | 2026-08-17 |
| T-010 | Выбрать стек бэкенда (ADR-005: TS + Fastify + PostgreSQL) | P1 | done | claude-2026-08-17-B | 2026-08-17 |
| T-011 | Выбрать стек фронтенда (ADR-006: PixiJS v8 + pixi-reels) | P1 | done | claude-2026-08-17-B | 2026-08-17 |
| T-012 | Схема БД: игроки, кошелёк, раунды, seeds, аудит-лог | P1 | done | claude-2026-08-17-B | 2026-08-17 |
| T-013 | Спецификация API: spin, verify, history, PLACE/SETTLE/ROLLBACK | P1 | done | claude-2026-08-17-B | 2026-08-17 |
| T-014 | Прототип клиента слота 5x3, 20 линий (PixiJS + pixi-reels) | P2 | done | claude-2026-08-17-B | 2026-08-17 |
| T-015 | Модуль ответственной игры (лимиты, самоисключение, reality check) | P2 | done | claude-2026-08-17-B | 2026-08-17 |
| T-016 | Юр. трек соц-казино (вариант A): правила, возрастные ограничения, стор-политики | P2 | done | claude-2026-08-17-B | 2026-08-17 |
| T-017 | Исследование PSP и платёжных рельс для high-risk | P2 | done | claude-2026-08-17-B | 2026-08-17 |
| T-018 | CI: линт, тесты, проверка что STATE.md обновлён в PR | P3 | done | claude-2026-08-17-B | 2026-08-17 |
| T-019 | Аналитика: CI[95%] — спины до сходимости RTP и требуемый банкролл | P2 | done | claude-2026-08-17-B | 2026-08-17 |
| T-020 | PAR sheet: секция разброса RTP по числу спинов (1k…10M) | P3 | done | claude-2026-08-17-B | 2026-08-17 |
| T-021 | Автономный HTML-верификатор раунда для игрока (работает офлайн) | P2 | done | claude-2026-08-17-B | 2026-08-17 |
| T-022 | Заложить в схему БД master RTP (клуб/игрок) и несколько наборов лент | P2 | done | claude-2026-08-17-B | 2026-08-17 |
| T-023 | Порт математики раунда на TypeScript, приёмка по tests/fixtures/rounds.json | P1 | done | claude-2026-08-17-B | 2026-08-17 |
| T-024 | Экран ответственной игры в клиенте: лимиты, самоисключение, reality check | P2 | done | arena-2026-08-19-H | 2026-08-19 |
| T-025 | Правила игры (ToS) и политика конфиденциальности + возрастной гейт 18+ | P2 | done | arena-2026-08-19-H | 2026-08-19 |
| T-026 | Боевой сервер на Fastify по ADR-005: PostgreSQL, идемпотентность, JWT | P1 | done | arena-2026-08-19-H | 2026-08-19 |
| T-027 | Календарные окна счётчиков RG: считать из ledger_entries, а не из памяти | P2 | done | arena-2026-08-19-H | 2026-08-19 |
| T-028 | Мониторинг RTP по ADR-007: интервал от фактического n, алерт от 100 тыс. раундов | P3 | done | arena-2026-08-19-H | 2026-08-19 |
| T-029 | Вторая игра на том же движке: проверка, что математика переиспользуется | P3 | done | arena-2026-08-19-H | 2026-08-19 |
| T-030 | Деплой: Dockerfile, docker-compose.yml, .env.example, скрипты миграций | P1 | done | arena-2026-08-19-I | 2026-08-19 |
| T-031 | Админка: HTML + API /admin/* — игроки, раунды, grant фишек, RTP дашборд | P1 | done | arena-2026-08-19-I | 2026-08-19 |
| T-032 | ADR-008: вторая игра на том же движке — архитектурное решение | P2 | done | arena-2026-08-19-I | 2026-08-19 |
| T-033 | ADR-009: возрастной гейт 18+ и ToS/Privacy для соц-казино | P2 | done | arena-2026-08-19-I | 2026-08-19 |
| T-034 | История раундов в клиенте: список, карточка, пагинация | P1 | done | arena-2026-08-19-J | 2026-08-19 |
| T-035 | Верификатор в модалке клиента: проверка раунда без перехода на verifier/ | P2 | done | arena-2026-08-19-J | 2026-08-19 |
| T-036 | Графики RTP и активности в админке (Chart.js) | P2 | done | arena-2026-08-19-J | 2026-08-19 |
| T-037 | Тесты для админки и мониторинга (admin + rtp) | P2 | done | arena-2026-08-19-J | 2026-08-19 |
| T-038 | Rate limiting 10 req/s на POST /rounds per player | P1 | done | arena-2026-08-19-K | 2026-08-19 |
| T-039 | Reality check модалка в клиенте каждые 60 минут | P2 | done | arena-2026-08-19-K | 2026-08-19 |
| T-040 | Блок игрока в админке POST /admin/block, статус suspended | P2 | done | arena-2026-08-19-K | 2026-08-19 |
| T-041 | ADR-010: деплой, админка, графики, история, верификатор | P2 | done | arena-2026-08-19-K | 2026-08-19 |
| T-042 | e2e сценарий — полный флоу demo→limits→rounds→history→admin grant/block | P2 | done | arena-2026-08-19-L | 2026-08-19 |
| T-043 | Админка поиск — GET /admin/players?search=&status= | P2 | done | arena-2026-08-19-L | 2026-08-19 |
| T-044 | Экспорт аудита CSV — GET /admin/audit?format=csv/json | P2 | done | arena-2026-08-19-L | 2026-08-19 |
| T-045 | Security hardening — helmet, cors, rate limit для /auth/demo | P1 | done | arena-2026-08-19-L | 2026-08-19 |
| T-046 | README — обновить с новыми фичами (2 игры, деплой, админка, графики, history, verifier, rate limit, reality check) | P2 | done | arena-2026-08-19-L | 2026-08-19 |
| T-047 | Выбор второй игры в клиенте — селект gameCode | P2 | done | arena-2026-08-19-L | 2026-08-19 |
| T-048 | ADR-011: hardening, e2e, итерация админки и деплоя | P2 | done | arena-2026-08-19-L | 2026-08-19 |
| T-049 | Daily bonus — POST /api/v1/bonus/daily, 1 раз в сутки 1000 CHIP | P2 | done | arena-2026-08-19-M | 2026-08-19 |
| T-050 | Leaderboard — GET /api/v1/leaderboard по win/bet за день/неделю/всё время | P2 | done | arena-2026-08-19-M | 2026-08-19 |
| T-051 | Master RTP — выбор набора лент по player.master_rtp / club.master_rtp | P2 | done | arena-2026-08-19-M | 2026-08-19 |
| T-052 | GDPR export — GET /api/v1/me/export все данные игрока | P2 | done | arena-2026-08-19-M | 2026-08-19 |
| T-053 | Playwright e2e UI — спин флоу в браузере | P3 | done | arena-2026-08-19-M | 2026-08-19 |
| T-054 | Mobile responsive — <600px колонка, stage 100% | P2 | done | arena-2026-08-19-M | 2026-08-19 |
| T-055 | Турниры — таблица tournaments, API /tournaments, /tournaments/:id/leaderboard, update scores | P2 | done | arena-2026-08-19-M | 2026-08-19 |
| T-056 | Email mock — логи в консоль и logs/email.log | P2 | done | arena-2026-08-19-M | 2026-08-19 |
| T-057 | Звук в клиенте — Web Audio beep для win/big win | P2 | done | arena-2026-08-19-M | 2026-08-19 |
| T-058 | CI e2e docker — .github/workflows/e2e.yml compose up + e2e.js | P2 | done | arena-2026-08-19-M | 2026-08-19 |
| T-059 | Рефералка — referrals таблица, API /referrals, бонус за приглашённого | P2 | done | arena-2026-08-19-N | 2026-08-19 |
| T-060 | Ачивки — achievements таблица, API /achievements | P2 | done | arena-2026-08-19-N | 2026-08-19 |
| T-061 | Чат простой — chat_messages, API /chat | P2 | done | arena-2026-08-19-N | 2026-08-19 |
| T-062 | Бэкап скрипт — scripts/backup.sh pg_dump | P2 | done | arena-2026-08-19-N | 2026-08-19 |
| T-063 | ADR-012: рефералка, ачивки, чат, бэкап | P2 | done | arena-2026-08-19-N | 2026-08-19 |
| T-064 | PWA — manifest.json + service worker | P2 | done | arena-2026-08-19-O | 2026-08-19 |
| T-065 | Email SMTP — nodemailer с env SMTP_HOST/USER/PASS | P2 | done | arena-2026-08-19-O | 2026-08-19 |
| T-066 | Tournament prize cron — scripts/distribute_prizes.js | P2 | done | arena-2026-08-19-O | 2026-08-19 |
| T-067 | Referral landing — client/public/ref.html | P2 | done | arena-2026-08-19-O | 2026-08-19 |
| T-068 | ADR-013: PWA, email, tournaments, referrals и мобильная | P2 | done | arena-2026-08-19-O | 2026-08-19 |
| T-069 | Tournament auto prize — cron сервис в docker-compose для distribute_prizes.js | P2 | done | arena-2026-08-19-P | 2026-08-19 |
| T-070 | Referral progress — API /referrals/progress до 5 | P2 | done | arena-2026-08-19-P | 2026-08-19 |
| T-071 | Chat moderation — фильтр мата, admin delete | P2 | done | arena-2026-08-19-P | 2026-08-19 |
| T-072 | PWA offline — кэш API /games и /health в sw.js | P2 | done | arena-2026-08-19-P | 2026-08-19 |
| T-073 | Backup restore — scripts/restore.sh | P2 | done | arena-2026-08-19-P | 2026-08-19 |
| T-074 | Tournament timer UI в клиенте — обратный отсчёт до конца турнира | P2 | done | arena-2026-08-19-Q | 2026-08-19 |
| T-075 | Referral progress bar UI — показывает 0/5, прогресс бар | P2 | done | arena-2026-08-19-Q | 2026-08-19 |
| T-076 | Chat moderation UI в админке — кнопка удалить сообщение | P2 | done | arena-2026-08-19-Q | 2026-08-19 |
| T-077 | Backup auto — cron сервис для бэкапа раз в сутки в compose | P2 | done | arena-2026-08-19-Q | 2026-08-19 |
| T-078 | ADR-015: tournament timer, referral progress, chat moderation, backup auto | P2 | done | arena-2026-08-19-Q | 2026-08-19 |
| T-079 | Push notifications — Web Push API, VAPID, подписка | P2 | done | arena-2026-08-19-R | 2026-08-19 |
| T-080 | Email templates — HTML шаблоны welcome, daily bonus, tournament | P2 | done | arena-2026-08-19-R | 2026-08-19 |
| T-081 | Referral landing улучшенный — прогресс бар, список на лендинге | P2 | done | arena-2026-08-19-R | 2026-08-19 |
| T-082 | Tournament auto UI — призы и статус finished в клиенте | P2 | done | arena-2026-08-19-R | 2026-08-19 |
| T-083 | Backup restore UI в админке — кнопки бэкап/восстановление | P2 | done | arena-2026-08-19-R | 2026-08-19 |
| T-084 | Tournament auto UI improved — статус finished, prize distributed | P2 | done | arena-2026-08-19-S | 2026-08-19 |
| T-085 | Email templates integration — использовать шаблоны в daily bonus и tournament prize | P2 | done | arena-2026-08-19-S | 2026-08-19 |
| T-086 | PWA install prompt — beforeinstallprompt handling | P2 | done | arena-2026-08-19-S | 2026-08-19 |
| T-087 | Backup restore UI — кнопки бэкап/восстановление в админке | P2 | done | arena-2026-08-19-S | 2026-08-19 |
| T-088 | ADR-016: tournament auto UI, email templates, PWA install, backup restore UI | P2 | done | arena-2026-08-19-S | 2026-08-19 |

---

## Заметки по блокировкам

- **Блокировок больше нет.** Q-001 закрыт решением ADR-004 (вариант A — соц-казино на виртуальных фишках).
- **Q-006** открыт по итогам T-016 и помечен 🔴: безопасность варианта A держится на отсутствии покупок фишек.
- **Q-002 … Q-005** остаются открытыми, но ничего не блокируют.
