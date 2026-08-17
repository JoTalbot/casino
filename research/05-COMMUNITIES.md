# 05 — Сообщества, форумы, open-source репозитории

**Дата:** 2026-08-17 · **Агент:** claude-2026-08-17-A

> Где искать знания, людей и код. Отдельно — что из этого доверенное,
> а что опасно.

---

## 1. Форумы и сообщества

### Профессиональные (операторы, аффилиаты, разработчики)

| Ресурс | О чём | Ценность |
|---|---|---|
| **AffiliateGuardDog Forum** (affiliateguarddog.com) | аффилиаты и операторы, реальные цифры rev-share, чёрные списки казино | ⭐⭐⭐⭐⭐ |
| **GPWA** (gpwa.org) | старейший форум аффилиатов, разборы условий | ⭐⭐⭐⭐ |
| **CasinoAffiliatePrograms / CAP** | партнёрские программы, переговоры по ставкам | ⭐⭐⭐ |
| **iGaming Business / SBC News** | новости индустрии, регуляторика | ⭐⭐⭐⭐ |
| **BitcoinTalk → Gambling** | крипто-казино, provably fair, ранние обсуждения | ⭐⭐⭐ |

**Как читать:** ищи ветки, где операторы жалуются на расходы — там самые
честные цифры. Маркетинговые материалы провайдеров занижают стоимость в разы.

### Reddit

| Сабреддит | О чём |
|---|---|
| `r/gambling` | общее, иногда ветки по математике слотов |
| `r/slots` | игроки, но полезно для понимания ожиданий аудитории |
| `r/gamedev` | техника, PixiJS, Unity, ассеты |
| `r/StartupAccelerators` | там встречался AMA владельца казино с реальными цифрами |
| `r/CasinoManagement` | операционка |
| `r/problemgambling` | **обязателен к прочтению** — понимание вреда продукта |

### Discord / Telegram

- Discord PixiJS — техподдержка по рендеру
- Discord серверов провайдеров игр (Stake Engine, некоторые агрегаторы)
- Telegram-каналы iGaming-индустрии (в основном СНГ-сегмент, много рекламы)

**Осторожно:** в Telegram огромное количество продавцов «готовых казино
под ключ за $2000» и «суб-лицензий Кюрасао за $5000». Это почти всегда
скам или nulled-сборки с бэкдорами.

### Профильные ресурсы по математике

| Ресурс | Что даёт |
|---|---|
| **slotgamedesign.com** | серия туториалов по PAR sheets — лучшее бесплатное объяснение |
| **slotdesigner.com** | PDF «Elements of Slot Design» (2nd ed.) — бесплатно, обязательно к прочтению |
| **easy.vegas/games/slots** | как устроены слоты изнутри, история виртуальных барабанов |
| **Wizard of Odds** (wizardofodds.com) | математика азартных игр, разборы конкретных игр |

---

## 2. Open-source репозитории

### Движки и полные проекты

| Репозиторий | ★ | Стек | Оценка |
|---|---|---|---|
| **slotopol/server** | 216 | Go | ⭐⭐⭐⭐⭐ Самый ценный. Сканер барабанов, наборы reel strips под разные RTP, реализации механик Novomatic/NetEnt/CT Interactive |
| **asiryk/slot-game** | 113 | TypeScript + PixiJS | ⭐⭐⭐⭐ Чистый фронтенд-пример, хорошая структура |
| **weyoss/pixi-slot-machine** | — | JS + PixiJS | ⭐⭐⭐ Минимальный рабочий слот |
| **ktsalik/sloticon** | — | React + PixiJS | ⭐⭐⭐ Интеграция Pixi в React |
| **michaelkolesidis/cherry-charm** | — | Three.js + React | ⭐⭐⭐ 3D-слот, красивый, но математика примитивная |
| **LucasHazardous/OpenSourceCasino** | — | Vue | ⭐⭐ Набор простых игр |
| **LaChance-Lab/solana-casino-games-evm-web3** | — | Solana + VRF | ⭐⭐⭐ 10 игр, пример on-chain RNG через VRF |

### Математика и SDK

| Репозиторий | Что даёт |
|---|---|
| **Stake Engine math-sdk** | Python-SDK для построения математики слотов от Stake. Официальный, поддерживаемый |
| **rakestake/provably_fair_verifier** | Референсная реализация верификации provably fair (Stake-схема) |

### Provably fair

GitHub topic `provably-fair` — десятки реализаций commit-reveal на разных языках.
Основа везде одна: `HMAC_SHA256(serverSeed, clientSeed:nonce:round)`.

Изучать стоит: официальную страницу Stake `stake.com/provably-fair/implementation`
плюс независимые верификаторы — они показывают, где реализации расходятся.

---

## 3. ⚠️ Опасная зона: nulled-сборки

| Репозиторий | Что это |
|---|---|
| `zeusbyte/goldsvet` | Взломанная сборка коммерческого движка Goldsvet (Laravel/PHP) |
| `promexdotme/opensource-casino-8.5` | То же семейство, «версия 8.5» |
| Множество форков «Goldsvet», «SlotBoss», «Vegas» на GitHub/Telegram | — |

**Почему опасно:**
1. **Бэкдоры.** Это норма для nulled-сборок. Обфусцированный PHP-код,
   который сливает балансы или даёт удалённый доступ. Известны случаи,
   когда операторы теряли всё после запуска.
2. **Пиратство.** Использование = нарушение прав правообладателя игр
   (Novomatic, NetEnt и др. активно судятся).
3. **Сертификация невозможна.** Ни одна лаборатория не сертифицирует
   украденный код.
4. **Математика подделана.** Часто RTP переписан, а PAR sheet отсутствует.

**Вердикт:** можно изучать структуру и архитектуру (как устроен PAM,
как выглядит админка, какие таблицы в БД). **Никогда** не запускать
в продакшене и не подключать к реальным деньгам.

---

## 4. Что изучать в первую очередь

Приоритетный список для нового агента на проекте:

```
1. slotopol/server  →  reel strips и наборы под целевые RTP
                       Это готовые данные, на которых можно учиться калибровке.

2. Stake Engine math-sdk  →  как профессионалы структурируют математику

3. asiryk/slot-game  →  как организовать фронтенд на PixiJS + TypeScript

4. stake.com/provably-fair/implementation  →  эталон commit-reveal

5. «Elements of Slot Design» PDF  →  формулы hits/scatter/wild/приоритет
```

Задача T-009 в `agents/TASKS.md` — детальный разбор этих репозиториев
с выводами в `research/06-OSS-REVIEW.md`.

---

## 5. Коммерческие поставщики (для сравнения, не рекомендация)

Полезно понимать рынок, даже если делаешь своё.

**Агрегаторы игр:** SoftSwiss, Slotegrator, Hub88, SoftGamings, EveryMatrix, BetConstruct

**Платформы (PAM):** SoftSwiss, EveryMatrix, Digitain, BetConstruct, Ubidex

**Провайдеры контента:** Pragmatic Play, Play'n GO, Evolution/NetEnt, Nolimit City,
Push Gaming, Hacksaw Gaming, Relax Gaming

**Сертификация:** GLI, BMM Testlabs, eCOGRA, iTech Labs, Quinel

**KYC:** Sumsub, Jumio, Onfido, Veriff, SEON

**Высокорисковые PSP:** Praxis, Nuvei, Paysafe, CoinsPaid (крипто), Payop

---

## 6. Как искать дальше

Работающие поисковые запросы:
```
site:github.com slot machine reel strips RTP
"PAR sheet" slot math site:*.edu OR filetype:pdf
provably fair HMAC SHA256 verifier
"Curacao LOK" license cost 2026 operator experience
white label casino "hidden costs" forum
GLI-11 RNG requirements pdf
```

GitHub topics: `casino-source-code`, `slot-machine`, `provably-fair`,
`igaming`, `casino-game`, `slot-game`

**Правило проекта:** каждый найденный факт → источник в `research/SOURCES.md`.
Утверждение без источника в этом репозитории не считается фактом.

---

## Источники

См. `research/SOURCES.md`, раздел «Сообщества и open source».
