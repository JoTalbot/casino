# 01 — Техническая архитектура онлайн-казино со слотами

**Дата:** 2026-08-17 · **Агент:** claude-2026-08-17-A
**Статус:** актуально на август 2026. Технологии меняются медленнее, чем регулирование.

---

## 1. Из чего вообще состоит казино

Начинающие думают, что казино — это «сайт со слотами». На деле это 6 независимых систем,
и игра — самая маленькая из них.

```
┌─────────────────────────────────────────────────────────┐
│  КЛИЕНТ (браузер / мобильный)                           │
│  Рендер барабанов, анимации, звук. НИКАКОЙ логики        │
└────────────────────────┬────────────────────────────────┘
                         │ HTTPS / WebSocket
┌────────────────────────▼────────────────────────────────┐
│  RGS — Remote Game Server                               │
│  RNG · математика · оценка выигрыша · состояние раунда  │
└────────────────────────┬────────────────────────────────┘
                         │ seamless wallet API
┌────────────────────────▼────────────────────────────────┐
│  PAM — Player Account Management                        │
│  Аккаунты · кошелёк · бонусы · лимиты · история          │
└──┬──────────┬───────────┬──────────┬────────────────────┘
   │          │           │          │
┌──▼───┐ ┌────▼────┐ ┌────▼─────┐ ┌──▼──────────────┐
│Платежи│ │ KYC/AML │ │ Админка  │ │ Аналитика/BI   │
│ PSP   │ │         │ │ Backoffice│ │                 │
└───────┘ └─────────┘ └──────────┘ └─────────────────┘
```

**Ключевой принцип:** клиент — это «тупой рендерер». Он получает от сервера
готовый результат спина и просто красиво его показывает. Любая случайность
на клиенте — мгновенный провал сертификации и открытая дверь для читеров.
Это единогласная позиция всех источников
([legalbison](https://legalbison.com/blog/building-your-appropriate-casino-game-tech-to-licensing/),
[sourcecodelab](https://sourcecodelab.co/complete-guide-casino-game-development/)).

---

## 2. Технологический стек

Сводка по отраслевым источникам
([sourcecodelab](https://sourcecodelab.co/complete-guide-casino-game-development/),
[riseuplabs](https://riseuplabs.com/slot-game-development-guide/),
[1spin4win](https://www.1spin4win.com/blog/slot-game-development-process-and-market-trends)):

| Слой | Варианты | Комментарий |
|---|---|---|
| **Клиент игры** | **PixiJS** (де-факто стандарт), Phaser, Unity WebGL | PixiJS доминирует в вакансиях слот-разработчиков. Unity — когда нужен тяжёлый 3D. |
| **Язык клиента** | TypeScript | Практически безальтернативно в 2026. |
| **UI-обвязка** | Svelte 5, React | Stake Engine официально рекомендует Svelte 5 + PixiJS + TypeScript. |
| **Бэкенд** | Node.js, Go, Java | Node.js — быстрая real-time логика; Go — производительность; Java — enterprise-комплаенс. |
| **Real-time** | WebSocket | Обязателен для crash/live; для классических слотов достаточно REST. |
| **БД (деньги)** | **PostgreSQL** | ACID обязателен. Никаких компромиссов. |
| **БД (сессии)** | **Redis** | Состояние сессий, кэш, rate limiting. |
| **Математика** | Python | Стандарт для PAR sheet, симуляций, Monte Carlo. Stake Engine даёт `math-sdk` на Python. |
| **Хостинг** | AWS / GCP + CDN | CDN критичен: цель загрузки ассетов < 100 мс. |
| **Анимация** | Spine2D | Индустриальный стандарт для символов и персонажей. |

### Рекомендуемый стек для нашего прототипа

```
Математика:  Python 3 (numpy) — PAR sheet, Monte Carlo
Бэкенд:      Node.js + TypeScript (Fastify) — RGS
Клиент:      TypeScript + PixiJS
БД:          PostgreSQL (транзакции) + Redis (сессии)
Тесты:       детерминированные тесты RNG + статистические тесты RTP
```

Обоснование: единый TypeScript на бэке и фронте ускоряет разработку одним агентом,
Python для математики — потому что весь отраслевой инструментарий и примеры на нём.

---

## 3. Анатомия одного спина

```
1. Клиент → POST /spin { betAmount, lines }
2. Сервер: проверить сессию, лимиты ответственной игры, достаточность баланса
3. Сервер: атомарно списать ставку (транзакция БД, идемпотентный ключ)
4. Сервер: сгенерировать исход
     nonce++
     bytes = HMAC_SHA256(serverSeed, `${clientSeed}:${nonce}:${round}`)
     floats = конвертация байтов
     stops = позиции барабанов по reel strips
5. Сервер: построить окно символов 5x3, оценить линии, wild, scatter
6. Сервер: посчитать выплату, при триггере — запустить фриспины
7. Сервер: атомарно зачислить выигрыш
8. Сервер: записать полный аудит-лог раунда
9. Сервер → Клиент { stops, wins, payout, balance, roundId }
10. Клиент: анимация «остановки» барабанов на уже известных позициях
```

**Важно:** шаг 10 — это театр. Результат определён на шаге 4. Анимация только
показывает то, что уже решено. Именно поэтому «остановить барабан вовремя» невозможно.

---

## 4. Provably Fair — реализация

Схема, ставшая индустриальным стандартом
([Stake implementation](https://stake.com/provably-fair/implementation),
[rakestake/provably-fair-verifier](https://github.com/rakestake/provably-fair-verifier)):

```
До ставок:
  Сервер: serverSeed = случайные 64 hex-символа (CSPRNG)
  Сервер публикует: SHA256(serverSeed)          ← коммитмент, изменить нельзя
  Игрок задаёт: clientSeed                       ← влияние игрока

На каждой ставке:
  nonce++
  результат = Алгоритм( HMAC_SHA256(serverSeed, `${clientSeed}:${nonce}:${cursor}`) )

При ротации seed:
  Сервер раскрывает serverSeed
  Игрок проверяет: SHA256(раскрытый) == опубликованный хэш   ✓
  Игрок пересчитывает каждый исход сам                        ✓
```

### Референсный byteGenerator (Stake)

```javascript
function* byteGenerator({ serverSeed, clientSeed, nonce, cursor }) {
  let currentRound = Math.floor(cursor / 32);
  let currentRoundCursor = cursor - currentRound * 32;

  while (true) {
    const hmac = createHmac('sha256', serverSeed);
    hmac.update(`${clientSeed}:${nonce}:${currentRound}`);
    const buffer = hmac.digest();

    while (currentRoundCursor < 32) {
      yield Number(buffer[currentRoundCursor]);
      currentRoundCursor += 1;
    }
    currentRoundCursor = 0;
    currentRound += 1;
  }
}
```

Байты собираются по 4 и конвертируются во float делением на степени 256:
`byte0/256 + byte1/256² + byte2/256³ + byte3/256⁴`.

### ⚠️ Известные подводные камни

1. **Сервер знает всё заранее.** Критика на
   [crypto.stackexchange](https://crypto.stackexchange.com/questions/108923/how-do-bad-actors-manipulate-game-results-in-real-time-within-provably-fair-ga):
   в классической схеме сервер видит и clientSeed, и nonce до генерации.
   Коммитмент это компенсирует — сервер не может подменить serverSeed,
   не сломав опубликованный хэш. Схема считается корректной **при условии**,
   что хэш публикуется до получения клиентского ввода.
2. **Наивная конвертация во float даёт смещение.** Первый байт отвечает за
   большую часть величины. Конвертер обязательно покрывать статистическими тестами.
3. **Ротация seed обязательна.** Без раскрытия старого serverSeed проверить ничего нельзя.
4. **Race conditions.** Известен реальный случай гонки в crash-игре, позволявший
   подсмотреть исход. Все операции с nonce — атомарные.

### Когда provably fair недостаточно

Provably fair **не заменяет сертификацию**. Для регулируемых рынков всё равно нужен
аудит RNG в аккредитованной лаборатории (GLI-11, iTech Labs, eCOGRA, BMM).
Provably fair — это про доверие игроков, сертификат — про доверие регулятора.

---

## 5. Криптография: что можно, что нельзя

| ❌ Нельзя | ✅ Нужно |
|---|---|
| `Math.random()` | `crypto.randomBytes()` / `crypto.getRandomValues()` |
| `random` (Python, Mersenne Twister) | `secrets` |
| `java.util.Random` | `java.security.SecureRandom` |
| RNG на клиенте | RNG только на сервере |

Формулировка [easy.vegas](https://easy.vegas/games/slots/program):
если на кону деньги — нужен криптостойкий PRNG (CSPRNG), обычного генератора языка
недостаточно. Mersenne Twister (питоновский `random`) предсказуем после наблюдения
624 выходов — для казино это дыра.

---

## 6. Модель данных (минимум)

```sql
-- Игроки
players(id, username, email, status, created_at, kyc_status)

-- Кошелёк: баланс ТОЛЬКО в целых минимальных единицах (центы/копейки)
wallets(id, player_id, currency, balance_minor BIGINT, updated_at)

-- Двойная запись — источник правды по деньгам
transactions(id, wallet_id, type, amount_minor BIGINT, balance_after_minor BIGINT,
             round_id, idempotency_key UNIQUE, created_at)

-- Provably fair seeds
seed_pairs(id, player_id, server_seed_hash, server_seed_encrypted,
           client_seed, nonce_counter, revealed_at, created_at)

-- Полный аудит каждого раунда — обязательно для сертификации
game_rounds(id, player_id, game_id, seed_pair_id, nonce,
            bet_minor BIGINT, payout_minor BIGINT,
            reel_stops JSONB, wins JSONB, feature_state JSONB,
            rtp_bucket, created_at)

-- Ответственная игра
player_limits(player_id, deposit_daily_minor, loss_daily_minor,
              session_minutes, self_excluded_until)
```

**Правила:**
- Баланс **никогда** не `float`. Только `BIGINT` в минимальных единицах.
- Каждая денежная операция — с `idempotency_key` (защита от двойного списания при ретраях).
- `game_rounds` пишется **всегда**, даже при выигрыше 0. Это основа аудита и разборов споров.
- Логи раундов — write-once, без UPDATE.

---

## 7. Безопасность

| Угроза | Защита |
|---|---|
| Подмена ставки на клиенте | Валидация всех параметров на сервере, whitelist номиналов |
| Повтор запроса (двойной выигрыш) | Идемпотентные ключи на всех денежных операциях |
| Race condition на балансе | Транзакции БД + `SELECT ... FOR UPDATE` |
| Мультиаккаунты / бонус-абуз | Фингерпринт устройства, IP-анализ, лимиты на аккаунт |
| Утечка serverSeed | Шифрование в БД, раскрытие только после ротации |
| Реверс клиента | В клиенте нет логики — реверсить нечего |
| DDoS | CDN + rate limiting на уровне Redis |
| Инсайдер меняет математику | Хэш конфигурации reel strips в аудит-логе каждого раунда |

---

## 8. Что реально нужно на прототипе (MVP)

Минимум, который уже является «настоящим» слотом:

1. `config/reels.json` — reel strips 5 барабанов
2. `config/paytable.json` — таблица выплат
3. `scripts/simulate.py` — Monte Carlo, проверка RTP
4. `src/engine/rng.ts` — provably fair генератор
5. `src/engine/evaluate.ts` — оценка линий, wild, scatter
6. `src/server/spin.ts` — эндпоинт спина с транзакциями
7. `src/client/` — PixiJS-рендер 5x3

Всё остальное (бонусы, турниры, джекпоты, соцфункции) — потом.

---

## Источники

См. `research/SOURCES.md`, раздел «Архитектура и разработка».
