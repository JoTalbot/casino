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

## Соц-казино: судебная практика и стор-политики (T-016)

- https://sbcamericas.com/2025/02/10/high-5-games-damages-casino-verdict/ —
  первый в истории вердикт присяжных против соц-казино: Вашингтон, февраль
  2025, High 5 Games обязали выплатить $24.9 млн (~$18 млн ущерба + ~$7 млн).
  Защита «монеты начисляются бесплатно, платить не обязательно» отклонена;
  на процессе фигурировала работа с «китами» и выдача промо-монет игроку,
  сообщившему о зависимости. — 2026-08-17
- https://www.atg.wa.gov/news/news-releases/ag-s-office-sues-illegal-gambling-apps-have-taken-more-225-million —
  официальный релиз генпрокурора Вашингтона, 03.02.2026: иск против Playtika
  и Aristocrat, 16 приложений, требование вернуть $225+ млн с сентября 2020.
  Отдельно заявлено отсутствие проверки возраста. — 2026-08-17
- https://sbcamericas.com/2026/02/06/washington-sues-aristocrat-playtika/ —
  разбор иска: 150 000 жителей штата в месяц, 8 млн покупок на $151 млн
  (Playtika) и 2.25 млн на $74 млн (Aristocrat). — 2026-08-17
- https://www.yogonet.com/international/news/2026/07/24/125544-washington-seeks-225m-from-operators-in-lawsuit-targeting-social-casino-apps —
  защита Playtika строится на функции «continuous play» (продолжение игры
  без покупки). Показывает, куда смотрит суд: давление заплатить при
  исчерпании фишек и есть «привилегия играть». — 2026-08-17
- https://www.zwillgen.com/litigation/virtual-chips-washington-gambling-law/ —
  разбор Kater v. Churchill Downs (9-й окружной суд, 2018): виртуальные фишки
  = «thing of value», поскольку дают «привилегию играть»; возможность вывода
  средств для квалификации НЕ требуется. Вторичный рынок суд как основание
  отверг. — 2026-08-17
- https://www.jdsupra.com/legalnews/social-gaming-site-excludes-washington-65927/ —
  реакция отрасли после Kater: PokerStars и другие закрыли доступ жителям
  Вашингтона добровольно, до решений регулятора. — 2026-08-17
- https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/ —
  актуальная шкала возрастных рейтингов Apple: Gambling и Frequent simulated
  gambling → 18+; Корея 19+ с Rating Classification Number; Австралия R 18+
  даже при нечастом симулированном гемблинге. — 2026-08-17
- https://forums.macrumors.com/threads/numerous-apps-caught-up-in-apples-new-app-store-review-policy-to-ban-gambling-related-apps.2131697/ —
  Apple не принимает гемблинг-приложения (включая симулированные) от
  аккаунтов физлиц: «only verified accounts from incorporated business
  entities». Практическое следствие: с личного аккаунта не опубликовать. — 2026-08-17
- https://richtfirm.com/the-proliferation-of-social-gaming-casinos-legal-compliance-considerations/ —
  сводка комплаенса соц-казино: требования App Store, Google Play, Google Ads
  и Meta; Google требует явно указывать в описании отсутствие реальных
  выигрышей. — 2026-08-17
- https://belarus.revera.legal/en/info-centr/news-and-analytical-materials/1293-trebovaniya-k-gemblingovym-prilozheniyam/ —
  разбор политик обеих площадок: нативность iOS-приложения, только юрлицо,
  запрет рекламы реальных казино в соц-казино, обязательные механизмы
  ответственной игры (самоисключение, лимиты). — 2026-08-17

## Украина: регулирование (T-016)

- https://chumak.partners/kruminalna-praktuka/advokat-st-203-2-azartni-ihry/ —
  ст. 203-2 УК Украины: организация азартных игр без лицензии — штраф
  170 000–680 000 грн с конфискацией, при повторности 680 000–850 000 грн
  и запрет деятельности до 3 лет. — 2026-08-17
- https://zakon.rada.gov.ua/go/4116-20 — закон № 4116-20 о борьбе с
  лудоманией, в силе с 01.04.2025: расчёты только через банковские счета,
  блокировка нелегальных сайтов и приложений, ДСОМ с фиксацией каждой
  ставки в реальном времени, «контролируемая игра» как форма надзора. — 2026-08-17
- https://thedigital.gov.ua/news/progress/tsyfrovyy-kontrol-borotba-z-nelehalnymy-kazyno-ta-ludomaniyeiu-rik-reformy-hralnoyi-industriyi-u-tsyfrakh-ta-faktakh —
  итоги года реформы: регулятор PlayCity в структуре Минцифры, первая
  очередь ДСОМ в тестовой эксплуатации. — 2026-08-17


---

## Платежи и PSP для high-risk (T-017)

- https://igamingpaymentsolutions.com/high-risk-payment-processing —
  самый детальный источник: комиссии MCC 7995 (2.5-7% против 1.5-2.5%),
  чарджбэк $25-100, rolling reserve 5-10% на 90-180 дней. Пороги Visa VAMP
  и Mastercard ECM с точными триггерами. Таблица провайдеров с минимальными
  оборотами. Рекомендация переводить 20-30% депозитов на безчарджбэковые
  рельсы. — 2026-08-17
- https://finix.com/resources/blogs/igaming-payment-challenges —
  **С 1 апреля 2026 порог Visa VAMP «excessive» снижен с 2.2% до 1.5%**
  (US/Canada/EU/APAC). Сравнение агрегатора и прямого процессора: в пуле
  агрегатора чужие чарджбэки бьют по всем участникам. — 2026-08-17
- https://finix.com/resources/blogs/igaming-payment-processing —
  лицензия — предусловие андеррайтинга, а не следствие; юрисдикция лицензии
  определяет доступных эквайеров. Stripe/PayPal/Square прямо запрещают
  гемблинг в ToS. Сроки: 1-3 недели агрегатор, 3-8 недель прямой. — 2026-08-17
- https://www.fincoro.com/insights/best-psps-high-risk-2026 —
  сравнение PSP по категориям: Nuvei (10% на 90 дней для iGaming),
  Paysafe (10-15%), Worldpay не подходит для гемблинга, Checkout.com
  не для высших категорий риска. — 2026-08-17
- https://igamingpaymentsolutions.com/providers/pxp-financial —
  разбор PXP: IC++ без публичных ставок, резерв 5-10% на 90-180 дней,
  FX-наценка 1-2%. Тактика переговоров: снижать до 5-7% и 90 дней при
  чистой истории от прежнего PSP. — 2026-08-17
- https://www.payconsults.com/post/what-high-risk-merchants-need-to-know —
  резервы по отраслям: iGaming 5-15% на 90-180 дней, форекс до 20% на 180.
  Рычаг для снижения — коэффициент ниже 0.5% шесть месяцев подряд. — 2026-08-17
- https://chargebacks911.com/high-risk/high-risk-merchants/ —
  общая механика high-risk аккаунтов, перечень документов для
  андеррайтинга, влияние чарджбэков на классификацию. — 2026-08-17
- https://blask.com/knowledge/what-is-a-psp-in-igaming/ —
  роль PSP в iGaming, MCC 7995, двусторонний характер потока
  (депозиты и выплаты). — 2026-08-17

---

## Как добавлять источники

1. Найди подходящий раздел (или создай новый).
2. Добавь запись в формате `— URL — что взяли — дата обращения`.
3. В исследовательском документе сошлись на источник inline-ссылкой
   или через отсылку к разделу этого файла.
4. Не удаляй чужие записи. Если источник устарел — пометь `[УСТАРЕЛО, YYYY-MM-DD]`.
