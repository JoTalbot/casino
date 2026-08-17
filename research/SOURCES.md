# SOURCES — реестр источников

Единый список источников для всех документов в `research/`.

**Правило:** каждый факт в исследовательских документах должен ссылаться
сюда или содержать прямую ссылку. Утверждение без источника фактом не считается.

Формат записи: `— URL — что взяли — дата обращения`

---

## Архитектура и разработка

- https://sourcecodelab.co/complete-guide-casino-game-development/ — эталонный
  стек казино-игр: HTML5 + PixiJS/Phaser (или Unity) на фронте, сертифицированный
  CSPRNG на сервере, backend Node.js/Java/Go, WebSocket для live/crash,
  PostgreSQL + Redis, AWS/GCP + CDN. Пайплайн разработки: GDD → мат-модель →
  арт → код → QA (10M+ симулированных спинов) → сертификация RNG (4–12 недель) →
  интеграция. Бюджет простого RNG-слота $20–50k. — 2026-08-17

- https://legalbison.com/blog/building-your-own-casino-game-tech-to-licensing/ —
  RNG обязан быть серверным; клиентская случайность не сертифицируется.
  Общий обзор пути от кода до лицензии. — 2026-08-17

- https://easy.vegas/games/slots/program — как программируются слоты изнутри,
  история виртуальных барабанов, требования к CSPRNG
  (`crypto.getRandomValues`, `java.security.SecureRandom`, `/dev/urandom`). — 2026-08-17

- https://pixijs.com/ — документация PixiJS, основной рендер-движок
  для фронтенда слота. — 2026-08-17

---

## Математика слотов

- https://www.sudonex.com/resources/slot-game-math-rtp/ — PAR sheet
  (Probability Accounting Report): состав, reel strips, веса символов, paytable,
  вклад фич в RTP. Виртуальные барабаны и патент Telnaes. Формула RTP фриспинов
  `RTP = (B0 + p1*n1*B1)/bet`, ретриггер `n1 = award/(1 − p_retrigger)`.
  Full cycle analysis vs Monte Carlo. Волатильность: обратная hit frequency (~30%),
  max win (~20%). VNS-оптимизация под точный RTP. — 2026-08-17

- https://slotgamedesign.com/2019/01/19/slot-math-tutorial-creating-par-sheets/ —
  туториал по созданию PAR sheets. Допущения: ставка 1 кредит, расчёт на линию,
  полный цикл. — 2026-08-17

- https://slotgamedesign.com/category/slot-machines/ — Hit Frequency =
  Ways to Win / Total Ways; RTP = Total Payout / Total Ways. Пример Liberty Bell:
  264/1000 = 26.4% HF, 756/1000 = 75.6% RTP. Добавление одного wild →
  27.4% HF, 88% RTP. — 2026-08-17

- https://slotgamedesign.com/category/math/ — рекомендация не ставить wild
  на первый барабан (взрыв комбинаторики). Правила взаимодействия wild/scatter. — 2026-08-17

- http://slotdesigner.com/wp/wp-content/uploads/Elements-of-Slot-Design-2nd-Edition.pdf —
  «Elements of Slot Design», 2nd Edition. Формулы подсчёта хитов, обработка
  scatter (умножение на высоту окна), приоритизация выигрышей на линии
  (пример: RTP 860% без учёта приоритета vs 780% с учётом). — 2026-08-17

- https://www.linkedin.com/pulse/finding-out-math-rules-behind-slots-building-simple-slot-farrugia —
  минимальный симулятор 3-барабанного слота на Python с весами символов,
  RTP ≈ 87.2%. Правило: ценные символы реже на ленте. — 2026-08-17

- https://igaming.whimsygames.co/blog/slot-math-design-rtp-volatility-bonus-buy-and-megaways-mechanics-explained/ —
  требования к симуляции: отклонение прогона на 1 млн спинов ≤ 2%,
  среднее трёх прогонов ≤ 0.5%. Механики Megaways и bonus buy. — 2026-08-17

- https://www.reddit.com/r/gambling/comments/1cc3pqf/hi_guys_i_wanted_to_learn_slot_mathematics_to/ —
  практический совет от разработчиков: начинать с Excel/Sheets, чтобы понять
  математику, до перехода на автоматизацию. — 2026-08-17

---

## RNG и provably fair

- https://stake.com/provably-fair/implementation — эталонная схема:
  серверный сид (64 hex), коммит `SHA256(serverSeed)` до ставки, клиентский сид
  от игрока, инкрементный nonce, cursor. Байты: `HMAC_SHA256(serverSeed,
  "clientSeed:nonce:round")`, cursor по 32 байта. Конвертация 4 байт во float:
  `b0/256 + b1/256² + b2/256³ + b3/256⁴`. Раскрытие серверного сида при ротации. — 2026-08-17

- https://github.com/rakestake/provably-fair-verifier — независимая
  реализация верификатора Stake-схемы. Полезна для сверки собственной реализации. — 2026-08-17

- https://crypto.stackexchange.com/questions/108923 — критический разбор:
  сервер знает все входы, безопасность держится на commitment-схеме —
  сервер не может подменить сид незаметно, игрок не может предсказать результат.
  Provably fair не доказывает честность распределения вероятностей. — 2026-08-17

---

## Юридические аспекты и лицензирование

- https://www.softswiss.com/knowledge-base/anjouan-igaming-licence-guide/ —
  Anjouan: ~€17–22k первый год, продление €13–21k, 0% налог на GGR,
  срок 2–8 недель, обязательна IBC на Анжуане, политики AML/KYC/RG.
  С июля 2025 B2B-провайдерам нужен отдельный B2B-сертификат €9 500/год. — 2026-08-17

- https://cybetic.com/anjouan-gaming-licence/ — практические детали процедуры
  получения Anjouan-лицензии, требования к документам. — 2026-08-17

- https://legarithm.io/insights/anjouan-igaming-licence-cost-in-2026/ —
  реалистичная оценка полной стоимости года 1: €40–70k с учётом сопутствующих
  расходов. Проблемы с приёмом Anjouan у части PSP и аффилиатных сетей. — 2026-08-17

- https://www.softswiss.com/knowledge-base/curacao-igaming-licence-guide/ —
  Curaçao под LOK: заявка €4 592 + ~€47 450/год B2C (B2B €24 490).
  Обязательны местная компания, резидентный директор, офис, сервер на острове.
  Старые суб-лицензии больше не выдаются. — 2026-08-17

- https://pfser.com/curacao-license/ — процедура и сроки получения
  лицензии Кюрасао, требования LOK. — 2026-08-17

- https://track360.io/ru/ — сравнение юрисдикций: реалистичный первый год
  Кюрасао €75–100k+, Malta MGA €80–150k, Kahnawake 25–50k CAD.
  Кюрасао — «стандарт для старта», Anjouan дешевле, но хуже репутация. — 2026-08-17

---

## Экономика и бизнес-модель

- https://sdlccorp.com/post/white-label-online-casino-cost/ — white label:
  setup $15–150k, запуск 4–12 недель, platform fee $1.5–7k/мес,
  game revenue share 10–20% GGR, PSP 2–6%, KYC $0.5–3/проверка,
  хостинг $1–5k/мес. — 2026-08-17

- https://igamingx.com/white-label-casino-cost/ — детализация скрытых
  расходов white label, сравнение с turnkey. — 2026-08-17

- https://www.affiliateguarddog.com/forum/ — реальный расклад оператора:
  PAM 4% GGR, PSP 2%, агрегатор 2%, игры 12–16%, спортсбук 18%,
  аффилиаты 20–40% NGR. — 2026-08-17

- https://www.reddit.com/r/StartupAccelerators/ — AMA владельца онлайн-казино:
  лицензия ~$30k, разработка ~$40k, суммарно ~$175k стартовых вложений,
  срок до запуска 9–10 месяцев. — 2026-08-17

- Агрегаторы игр (SoftSwiss 40k+ игр, Slotegrator, Hub88, SoftGamings,
  EveryMatrix): +5–15% NGR поверх доли провайдеров, минимальные месячные
  платежи €5–25k. Технический шлюз при своих контрактах — 1–3%. — 2026-08-17

---

## Сообщества и open source

- https://github.com/topics/casino-source-code — обзор темы. — 2026-08-17
- https://github.com/topics/slot-machine — обзор темы. — 2026-08-17
- https://github.com/topics/provably-fair — обзор темы. — 2026-08-17

- https://github.com/slotopol/server — 216★, Go. Сканер барабанов, наборы
  reel strips под разные целевые RTP, реализации механик Novomatic, NetEnt,
  CT Interactive. Самый ценный открытый источник по реальным reel strips. — 2026-08-17

- https://github.com/asiryk/slot-game — 113★, TypeScript + PixiJS.
  Чистый пример фронтенда слота. — 2026-08-17

- https://github.com/weyoss/pixi-slot-machine — минимальный слот на PixiJS. — 2026-08-17
- https://github.com/ktsalik/sloticon — React + PixiJS. — 2026-08-17
- https://github.com/michaelkolesidis/cherry-charm — Three.js + React, 3D-слот. — 2026-08-17
- https://github.com/LucasHazardous/OpenSourceCasino — Vue, набор простых игр. — 2026-08-17
- https://github.com/LaChance-Lab/solana-casino-games-evm-web3 — 10 игр,
  on-chain RNG через VRF на Solana. — 2026-08-17

- ⚠️ https://github.com/zeusbyte/goldsvet и
  https://github.com/promexdotme/opensource-casino-8.5 — nulled-сборки
  коммерческого движка Goldsvet (Laravel/PHP). Только для изучения архитектуры.
  Риск бэкдоров, нарушение авторских прав, невозможность сертификации. — 2026-08-17

---

## OSS-разбор (T-009, смена #2, 2026-08-17)

Полные выводы — в `research/06-OSS-REVIEW.md`. Здесь только ссылки и суть.

- https://pkg.go.dev/github.com/slotopol/server/game/slot — документация пакета:
  интерфейс `SlotGame` (Prepare/Spin/Scanner/Apply), `ReelsMap.FindClosest(mrtp)`,
  функции `BankrollHouse`, `BankrollPlayer`, `CI`, `VIclass3/6`. Забрали идею
  константного `Scanner`, master RTP и метрик банкролла. — 2026-08-17
- https://github.com/slotopol/server — README с примером вывода сканера для
  Gonzo's Quest: RTP 95.31%, sigma 6.17, VI 12.10 (Medium-High), CI[95%] = 66610
  спинов, bankroll 6247.72, таблица разброса RTP по числу спинов. Породило
  задачи T-019 и T-020. ❌ ленты реальных игр не копировать. — 2026-08-17
- https://github.com/nekzabirov/IGaming-Game-Engine — Kotlin/Ktor, Apache 2.0,
  боевой модуль платформы 1638.cloud. Взяли: жизненный цикл ставки
  PLACE/SETTLE/ROLLBACK с идемпотентностью, переиспользование раунда по внешнему ID,
  порты Wallet/PlayerLimit/Currency/Event, событийную шину. Показательно, что
  остальные 7 движков (PAM, Wallet, Payment, Risk, Engagement, Intelligence, CMS)
  закрыты. — 2026-08-17
- https://pixi-reels.schmooky.dev/ и https://github.com/schmooky/pixi-reels —
  MIT, TypeScript, PixiJS v8 + GSAP, v2.2.0. Fluent-builder, типизированные
  события, фазы спина, headless-тесты в Node, рецепты для линий/скаттеров/
  фриспинов/каскадов/hold&win. ✅ кандидат в основу клиента (T-014).
  Нюанс: в примерах символы выбираются по весам на клиенте — нам нужно подавать
  готовый результат с сервера. — 2026-08-17
- https://github.com/xhulianomalaj/Slot-Game — Pixi + Preact + MobX + Vite,
  Playwright + Vitest, FSM игрового цикла. Образец тестового контура клиента;
  использует pixi-reels — признак складывающейся экосистемы (аргумент за Pixi
  в ADR по T-011). — 2026-08-17
- https://github.com/rakestake/provably-fair-verifier — канон схемы
  commit-reveal: SHA256(serverSeed) до ставки, HMAC-SHA256(serverSeed,
  "clientSeed:nonce"), раскрытие после ротации. Слотов в списке поддерживаемых
  игр НЕТ — provably fair слот это ниша. Наш формат сообщения совместим. — 2026-08-17
- https://www.btcgosu.com/provably-fair/ — обзор рынка 2026: у BC.Game 50+
  provably fair игр, открытый код верификации, история сидов в профиле игрока,
  сторонний верификатор Dyutam. Вывод: хранить историю пар сидов с
  nonce-диапазонами обязательно (T-012). — 2026-08-17
- https://github.com/javascript-pro/crypto-casino — Next.js + wagmi/viem +
  Solidity, commit-reveal на смарт-контракте (KECCAK-256). MIT. Вывод:
  on-chain VRF не годится для потока спинов (газ + задержка блока),
  годится для редких дорогих событий. — 2026-08-17
- ⚠️ https://github.com/Mint-Scripts-Studio/html5-gold-of-egypt-slot-engine-open-source —
  Phaser 3, название и стилистика скопированы с коммерческого слота. Смотреть
  можно, брать нельзя. — 2026-08-17
- ❌ Топики `casino-source-code`, `turnkey-casino`: NexusGGR, FiversCan,
  casino-api777, 1stake, Crazybets — SEO-витрины продавцов агрегаторских API,
  реального кода нет. — 2026-08-17

## Выбор стека (T-010, T-011, смена #2, 2026-08-17)

- https://generalistprogrammer.com/tutorials/best-html5-game-frameworks-2025 —
  обзор 2026: Phaser 4 стабилен и рекомендуется как дефолт для 2D-игр,
  PixiJS v8 — WebGPU-first, но «рендерер, а не фреймворк». Мы пошли против
  общей рекомендации осознанно: слоту не нужны физика, тайлмапы и камеры,
  см. ADR-006. — 2026-08-17
- https://www.abratabia.com/pixijs/ — PixiJS v8 ~450 КБ минифицированно против
  ~1.2 МБ у Phaser, tree-shaking через ES-модули, WebGPU как равноправный
  бэкенд, откат на WebGL 2 и экспериментальный Canvas. Решающий аргумент
  по размеру бандла. — 2026-08-17
- https://app.cinevva.com/guides/webgpu-vs-webgl-games — Phaser 4 это
  переписанный WebGL2-рендерер, WebGPU в нём пока НЕТ; PixiJS поддерживает
  WebGPU. — 2026-08-17
- https://ortemtech.com/blog/top-nodejs-frameworks-2026/ — бенчмарки 2026:
  Fastify ~65k req/s (p99 2–5 мс), NestJS+Fastify ~55k, NestJS+Express ~18k,
  Express ~15k, Hono на Workers ~200k. Важная оговорка автора: на реальной
  нагрузке с БД разрыв смазывается, и решают индексы, кэш и пулинг, а не
  фреймворк. — 2026-08-17
- https://medium.com/@pravir.raghu/introduction-78775e1c5e47 — NestJS на
  Fastify-адаптере даёт ~3x к NestJS на Express; сама команда Nest
  рекомендует Fastify-адаптер при требованиях к производительности. — 2026-08-17
- https://encore.dev/resources/best-typescript-backend-frameworks-2026 —
  сравнение TS-фреймворков; Encore.ts ~121k req/s, но с автоматическим
  провижинингом инфраструктуры в AWS/GCP. Отвергнут из-за привязки
  к платформе, см. ADR-005. — 2026-08-17

---

## Как добавлять источники

1. Найди подходящий раздел (или создай новый).
2. Добавь запись в формате `— URL — что взяли — дата обращения`.
3. В исследовательском документе сошлись на источник inline-ссылкой
   или через отсылку к разделу этого файла.
4. Не удаляй чужие записи. Если источник устарел — пометь `[УСТАРЕЛО, YYYY-MM-DD]`.
