/**
 * Прототип клиента слота (T-014 + T-024, T-025, T-034, T-035).
 * КЛИЕНТ НЕ РЕШАЕТ НИЧЕГО — весь раунд считается на сервере.
 */

import { Application, Container, Graphics } from "pixi.js";
import { ReelSetBuilder, SpeedPresets } from "pixi-reels";
import gsap from "gsap";

import { api, apiUrl, type GameInfo, type RoundRecord, type SpinRecord } from "./api.js";
import { haptic, inTelegram, setupMainButton, setupViewport } from "./telegram.js";
import {
  anticipationReels,
  toColumnTargets,
  winMultiple,
  winningPositions,
  winTier,
} from "./presentation.js";
import { ArtSymbol, SYMBOL_THEMES, initSymbolTextures } from "./artSymbols.js";
import { WinFx, animateMarquee, buildBackdrop, buildDrumShading, buildFrame, buildFrameSheen, buildMarquee, buildReelWindow, type CabinetLayout } from "./cabinet.js";
import { soundWin, soundSpin } from "./sound.js";

const REELS = 5;
const ROWS = 3;
const CELL = 124;
const GAP = 10;
/** Поле вокруг окна барабанов под золотую раму. */
const FRAME_PAD = 34;
/** Высота зоны вывески над барабанами. */
const MARQUEE_H = 74;
const FREE_SPIN_PAUSE_MS = 850;
const WIN_DISPLAY_MS = 1400;

const ui = {
  balance: document.getElementById("balance") as HTMLElement,
  bet: document.getElementById("bet") as HTMLSelectElement,
  gameSelect: document.getElementById("game-select") as HTMLSelectElement,
  spin: document.getElementById("spin") as HTMLButtonElement,
  turbo: document.getElementById("turbo") as HTMLInputElement,
  bonusOpen: document.getElementById("bonus-open") as HTMLButtonElement,
  bonusLabel: document.getElementById("bonus-label") as HTMLElement,
  bonusModal: document.getElementById("bonus-modal") as HTMLElement,
  bonusClose: document.getElementById("bonus-close") as HTMLButtonElement,
  autoCount: document.getElementById("auto-count") as HTMLSelectElement,
  autoStart: document.getElementById("auto-start") as HTMLButtonElement,
  autoModal: document.getElementById("auto-modal") as HTMLElement,
  autoSettingsClose: document.getElementById("auto-settings-close") as HTMLButtonElement,
  autoStopBonus: document.getElementById("auto-stop-bonus") as HTMLInputElement,
  autoStopBigWin: document.getElementById("auto-stop-bigwin") as HTMLInputElement,
  autoStopBalance: document.getElementById("auto-stop-balance") as HTMLInputElement,
  autoStopProfit: document.getElementById("auto-stop-profit") as HTMLInputElement,
  win: document.getElementById("win") as HTMLElement,
  status: document.getElementById("status") as HTMLElement,
  gameName: document.getElementById("game-name") as HTMLElement,
  configHash: document.getElementById("config-hash") as HTMLElement,
  serverHash: document.getElementById("server-hash") as HTMLElement,
  clientSeed: document.getElementById("client-seed") as HTMLInputElement,
  applySeed: document.getElementById("apply-seed") as HTMLButtonElement,
  rotate: document.getElementById("rotate") as HTMLButtonElement,
  nonce: document.getElementById("nonce") as HTMLElement,
  log: document.getElementById("log") as HTMLElement,
  stage: document.getElementById("stage") as HTMLElement,
  ageGate: document.getElementById("age-gate") as HTMLElement,
  ageYes: document.getElementById("age-yes") as HTMLButtonElement,
  ageNo: document.getElementById("age-no") as HTMLButtonElement,
  rgToday: document.getElementById("rg-today") as HTMLElement,
  rgLimits: document.getElementById("rg-limits") as HTMLElement,
  rgKind: document.getElementById("rg-kind") as HTMLSelectElement,
  rgValue: document.getElementById("rg-value") as HTMLInputElement,
  rgSet: document.getElementById("rg-set") as HTMLButtonElement,
  rgRefresh: document.getElementById("rg-refresh") as HTMLButtonElement,
  rgList: document.getElementById("rg-list") as HTMLElement,
  seKind: document.getElementById("se-kind") as HTMLSelectElement,
  seSet: document.getElementById("se-set") as HTMLButtonElement,
  historyList: document.getElementById("history-list") as HTMLElement,
  historyRefresh: document.getElementById("history-refresh") as HTMLButtonElement,
  verifyOpen: document.getElementById("verify-open") as HTMLButtonElement,
  bonusDaily: document.getElementById("bonus-daily") as HTMLButtonElement,
  bonusStatus: document.getElementById("bonus-status") as HTMLElement,
  tournamentsRefresh: document.getElementById("tournaments-refresh") as HTMLButtonElement,
  leaderboardRefresh: document.getElementById("leaderboard-refresh") as HTMLButtonElement,
  tournamentsList: document.getElementById("tournaments-list") as HTMLElement,
  leaderboardList: document.getElementById("leaderboard-list") as HTMLElement,
  refLink: document.getElementById("ref-link") as HTMLElement,
  refCode: document.getElementById("ref-code") as HTMLInputElement,
  refUse: document.getElementById("ref-use") as HTMLButtonElement,
  refList: document.getElementById("ref-list") as HTMLElement,
  achList: document.getElementById("ach-list") as HTMLElement,
  chatList: document.getElementById("chat-list") as HTMLElement,
  chatMsg: document.getElementById("chat-msg") as HTMLInputElement,
  chatSend: document.getElementById("chat-send") as HTMLButtonElement,
  roundModal: document.getElementById("round-modal") as HTMLElement,
  modalRoundId: document.getElementById("modal-round-id") as HTMLElement,
  modalContent: document.getElementById("modal-content") as HTMLElement,
  modalClose: document.getElementById("modal-close") as HTMLButtonElement,
  verifyModal: document.getElementById("verify-modal") as HTMLElement,
  vServer: document.getElementById("v-server") as HTMLInputElement,
  vClient: document.getElementById("v-client") as HTMLInputElement,
  vNonce: document.getElementById("v-nonce") as HTMLInputElement,
  vCheck: document.getElementById("v-check") as HTMLButtonElement,
  vResult: document.getElementById("v-result") as HTMLElement,
  verifyClose: document.getElementById("verify-close") as HTMLButtonElement,
  realityModal: document.getElementById("reality-modal") as HTMLElement,
  realityText: document.getElementById("reality-text") as HTMLElement,
  realityContinue: document.getElementById("reality-continue") as HTMLButtonElement,
  realityExit: document.getElementById("reality-exit") as HTMLButtonElement,
};

function fmt(value: number): string {
  return value.toLocaleString("ru-RU");
}
function log(message: string, kind: "info" | "win" | "free" | "error" = "info"): void {
  const line = document.createElement("div");
  line.className = `log-line log-${kind}`;
  const time = new Date().toLocaleTimeString("ru-RU");
  line.textContent = `${time}  ${message}`;
  ui.log.prepend(line);
  while (ui.log.childElementCount > 80) ui.log.lastElementChild?.remove();
}
function setStatus(text: string): void {
  ui.status.textContent = text;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function checkAgeGate(): boolean {
  try {
    if (localStorage.getItem("age_verified") === "18+") {
      ui.ageGate.classList.add("hidden");
      return true;
    }
  } catch {}
  ui.ageGate.classList.remove("hidden");
  return false;
}

async function main(): Promise<void> {
  setupViewport();
  if (!checkAgeGate()) {
    ui.ageYes.addEventListener("click", () => {
      try { localStorage.setItem("age_verified", "18+"); } catch {}
      ui.ageGate.classList.add("hidden");
      log("Возраст подтверждён 18+", "info");
      window.location.reload();
    });
    ui.ageNo.addEventListener("click", () => {
      setStatus("Доступ только с 18 лет");
      log("Доступ запрещён: требуется 18+", "error");
      ui.ageGate.innerHTML = '<div id="age-box"><h2>Доступ запрещён</h2><p>Игра доступна только с 18 лет.</p><p><a href="/terms.html">Правила</a></p></div>';
    });
    if (!checkAgeGate()) return;
  }

  // Referral code from ?ref= or localStorage referral_code (T-067 landing)
  try {
    const urlRef = new URLSearchParams(window.location.search).get('ref');
    if (urlRef) {
      try { localStorage.setItem('referral_code', urlRef); } catch {}
      // clean url
      try { history.replaceState({}, '', window.location.pathname); } catch {}
    }
  } catch {}

  let game: GameInfo;
  let selectedGameCode = (ui.gameSelect?.value as string) || "crown-of-fortune";
  try {
    // Попробуем загрузить список игр, чтобы заполнить селект второй игрой
    try {
      const games = await api.listGames();
      if (ui.gameSelect) {
        ui.gameSelect.innerHTML = "";
        for (const g of games) {
          const opt = document.createElement("option");
          opt.value = g.code;
          opt.textContent = g.name;
          if (g.code === selectedGameCode) opt.selected = true;
          ui.gameSelect.appendChild(opt);
        }
      }
    } catch {}
    selectedGameCode = (ui.gameSelect?.value as string) || "crown-of-fortune";
    game = await api.game(selectedGameCode);
  } catch (error) {
    setStatus(`Сервер недоступен: ${(error as Error).message}`);
    log(`Не удалось получить описание игры: ${(error as Error).message}`, "error");
    return;
  }

  ui.gameName.textContent = `${game.name} v${game.version}`;
  ui.configHash.textContent = game.configHash;
  ui.configHash.title = "SHA-256 математики";

  if (ui.gameSelect) {
    ui.gameSelect.addEventListener("change", () => {
      void (async () => {
        selectedGameCode = ui.gameSelect.value;
        try {
          const newGame = await api.game(selectedGameCode);
          game = newGame;
          ui.gameName.textContent = `${game.name} v${game.version}`;
          ui.configHash.textContent = game.configHash;
          log(`Игра изменена на ${game.name}`, "info");
          // Перерисовать таблицу выплат
          const paytableHost = document.getElementById("paytable") as HTMLElement;
          if (paytableHost) {
            paytableHost.innerHTML = "";
            for (const symbol of game.symbols) {
              const pays = game.paytable[symbol];
              const theme = SYMBOL_THEMES[symbol];
              const row = document.createElement("div");
              row.className = "pay-row";
              const chip = document.createElement("span");
              chip.className = "pay-chip";
              chip.textContent = theme?.glyph ?? symbol;
              if (theme) {
                chip.style.background = `#${theme.shade.toString(16).padStart(6, "0")}22`;
                chip.style.color = `#${theme.accent.toString(16).padStart(6, "0")}`;
                chip.style.borderColor = `#${theme.accent.toString(16).padStart(6, "0")}`;
              }
              row.appendChild(chip);
              const values = document.createElement("span");
              values.className = "pay-values";
              if (symbol === game.scatter) {
                const parts = Object.entries(game.scatterPays).map(([n, mult]) => `${n}: ${mult}× ставки`);
                values.textContent = parts.join(" · ") || "—";
              } else if (symbol === game.wild) {
                values.textContent = "замещает любой символ, кроме scatter";
              } else if (pays) {
                values.textContent = Object.entries(pays).map(([count, pay]) => `${count}: ${pay}`).join(" · ");
              } else {
                values.textContent = "—";
              }
              row.appendChild(values);
              paytableHost.appendChild(row);
            }
          }
        } catch (e) {
          log(`Не удалось сменить игру: ${(e as Error).message}`, "error");
        }
      })();
    });
  }

  // Раскладка кабинета: окно барабанов + рама + вывеска сверху (T-190).
  const boardWidth = REELS * CELL + (REELS - 1) * GAP;
  const boardHeight = ROWS * CELL + (ROWS - 1) * GAP;
  const layout: CabinetLayout = {
    width: boardWidth + FRAME_PAD * 2,
    height: boardHeight + FRAME_PAD * 2 + MARQUEE_H,
    boardX: FRAME_PAD,
    boardY: FRAME_PAD + MARQUEE_H,
    boardWidth,
    boardHeight,
    reels: REELS,
    gap: GAP,
  };

  const app = new Application();
  await app.init({
    width: layout.width,
    height: layout.height,
    background: "#05070f",
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  ui.stage.appendChild(app.canvas);

  // Порядок слоёв: задник → окно → барабаны → рама → вывеска → эффекты.
  // Символы и статичные слои запекаются в текстуры до первого кадра:
  // во время игры сцена не должна ничего рисовать заново (T-191).
  await initSymbolTextures(app.renderer as never, CELL);

  app.stage.addChild(buildBackdrop(app.renderer as never, layout));
  app.stage.addChild(buildReelWindow(app.renderer as never, layout));

  const board = new Container();
  board.position.set(layout.boardX, layout.boardY);
  app.stage.addChild(board);

  // Слой объёма барабанов ложится поверх символов, но под раму.
  app.stage.addChild(buildDrumShading(app.renderer as never, layout));

  const frameLayer = buildFrame(app.renderer as never, layout);
  const marquee = buildMarquee(layout, game.name ?? "Crown of Fortune");
  const winFx = new WinFx(layout);
  app.stage.addChild(frameLayer, buildFrameSheen(layout, app.ticker), marquee, winFx.view);
  animateMarquee(marquee, app.ticker);

  // Параллакс: слои смещаются за курсором на несколько пикселей. Дёшево, но
  // сцена перестаёт быть плоской картинкой — задник живёт отдельно от рамы.
  const parallax = [
    { layer: app.stage.children[0] as Container, depth: 6 },
    { layer: app.stage.children[1] as Container, depth: 3 },
    { layer: marquee, depth: -2 },
  ];
  const home = parallax.map(({ layer }) => ({ x: layer.x, y: layer.y }));
  app.canvas.addEventListener("pointermove", (event: PointerEvent) => {
    const rect = app.canvas.getBoundingClientRect();
    const nx = (event.clientX - rect.left) / rect.width - 0.5;
    const ny = (event.clientY - rect.top) / rect.height - 0.5;
    parallax.forEach(({ layer, depth }, i) => {
      layer.position.set(home[i].x - nx * depth * 2, home[i].y - ny * depth * 2);
    });
  });
  app.canvas.addEventListener("pointerleave", () => {
    parallax.forEach(({ layer }, i) => layer.position.set(home[i].x, home[i].y));
  });

  const reelSet = new ReelSetBuilder()
    .reels(REELS)
    .visibleCells(ROWS)
    .symbolSize(CELL, CELL)
    .symbolGap(GAP, GAP)
    .symbols((registry) => {
      for (const id of game.symbols) registry.register(id, ArtSymbol, {});
    })
    .weights(Object.fromEntries(game.symbols.map((id) => [id, 1])))
    .speed("normal", SpeedPresets.NORMAL)
    .speed("turbo", SpeedPresets.TURBO)
    .initialSpeed("normal")
    .ticker(app.ticker)
    .gsap(gsap)
    .build();

  board.addChild(reelSet);

  // Отладочный хук: включается только через ?debug=1. Нужен, чтобы замерять
  // фазы анимации на живом стенде — без него причины «медленного спина»
  // видны лишь по секундомеру (T-191).
  if (new URLSearchParams(window.location.search).has("debug")) {
    (window as unknown as { __casino?: unknown }).__casino = { app, reelSet, layout, winFx, gsap };
  }

  const idle = toColumnTargets(
    Array.from({ length: REELS }, (_, reel) =>
      Array.from({ length: ROWS }, (_, row) => game.symbols[(reel + row * 2) % 9]),
    ),
  );
  reelSet.setResult(idle);

  const seeds = await api.seeds();
  ui.serverHash.textContent = seeds.serverSeedHash;
  ui.clientSeed.value = seeds.clientSeed;
  ui.nonce.textContent = String(seeds.nonce);

  const wallet = await api.wallet();
  ui.balance.textContent = fmt(wallet.balance);

  // Код приглашения приходит из бота параметром ?ref=… (T-202).
  // Сохраняем его тем же ключом, что и лендинг, — дальше работает общая
  // логика привязки.
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("ref");
    if (fromUrl) localStorage.setItem("referral_code", fromUrl);
  } catch {}

  // Авто-применение реферального кода с лендинга (T-067)
  try {
    const refCode = (() => { try { return localStorage.getItem('referral_code'); } catch { return null; } })();
    if (refCode) {
      // пытаемся активировать рефералку один раз
      try {
        const res = await fetch(apiUrl("/api/v1/referrals"), { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${localStorage.getItem('casino_jwt') || ''}` }, body: JSON.stringify({ referralCode: refCode }) });
        if (res.ok) {
          log(`Реферальный код ${refCode} активирован, бонус 1000 CHIP`, "win");
          try { localStorage.removeItem('referral_code'); } catch {}
          // обновить баланс
          try { const w2 = await api.wallet(); ui.balance.textContent = fmt(w2.balance); } catch {}
        } else {
          // T-180: окончательные отказы не имеет смысла повторять при каждом заходе —
          // код удаляется, игроку показывается человеческая причина.
          const body = await res.json().catch(() => ({})) as { code?: string; message?: string };
          const final = ["SELF_REFERRAL", "ALREADY_REFERRED", "REFEREE_NOT_NEW", "REFERRER_NOT_FOUND"];
          if (body.code && final.includes(body.code)) {
            log(`Реферальный код не применён: ${body.message ?? body.code}`, "error");
            try { localStorage.removeItem('referral_code'); } catch {}
          }
        }
      } catch {}
    }
  } catch {}

  log(`Игра загружена. Коммитмент: ${seeds.serverSeedHash.slice(0, 16)}…`);
  setStatus("Готово к игре");

  let busy = false;

  async function present(spin: SpinRecord, round: RoundRecord): Promise<void> {
    const targets = toColumnTargets(spin.grid);
    const anticipation = anticipationReels(spin.grid, game.scatter);
    soundSpin();
    const spinPromise = reelSet.spin();
    if (anticipation.length > 0) reelSet.setAnticipation(anticipation);
    reelSet.setResult(targets);
    await spinPromise;
    if (spin.win > 0) {
      winFx.pulse(gsap, 0.16);
      const positions = winningPositions(spin);
      const label = spin.free ? `Фриспин ${spin.index}: +${fmt(spin.win)}${spin.multiplier > 1 ? ` (×${spin.multiplier})` : ""}` : `Выигрыш: +${fmt(spin.win)}`;
      ui.win.textContent = `+${fmt(spin.win)}`;
      log(label, "win");
      if (positions.length > 0) {
        await reelSet.spotlight.show(positions, { dimAmount: 0.55 });
        await sleep(WIN_DISPLAY_MS);
        reelSet.spotlight.hide();
      } else {
        await sleep(WIN_DISPLAY_MS);
      }
    }
    if (spin.scatterCount >= 3) {
      const awarded = spin.triggeredFreeSpins;
      if (awarded > 0) {
        log(spin.free ? `Ретриггер: ещё ${awarded} фриспинов (${spin.scatterCount} scatter)` : `Бонус: ${awarded} фриспинов (${spin.scatterCount} scatter)`, "free");
      }
      const scatterPay = spin.winDetails.find((d) => d.scatter);
      if (scatterPay) log(`Scatter: ${scatterPay.count} шт., +${fmt(scatterPay.pay * round.betPerLine)}`, "win");
    }
  }

  async function playRound(): Promise<RoundRecord | null> {
    if (busy) return null;
    busy = true;
    ui.spin.disabled = true;
    mainButton?.setBusy(true);
    haptic.spin();
    ui.win.textContent = "—";
    setStatus("Запрос раунда у сервера…");
    try {
      const betPerLine = Number(ui.bet.value);
      reelSet.setSpeed(ui.turbo.checked ? "turbo" : "normal");
      const round = await api.playRound(betPerLine, selectedGameCode, bonusTier);
      ui.nonce.textContent = String(round.nonce + 1);
      setStatus(`Раунд #${round.nonce}: ставка ${fmt(round.totalBet)}`);
      log(`Раунд #${round.nonce}: ставка ${fmt(round.totalBet)}, спинов ${round.spins.length}`);
      let bonusAnnounced = false;
      for (const spin of round.spins) {
        // Вход в серию фриспинов объявляется один раз, до первого из них:
        // иначе игрок видит просто ещё несколько спинов и не понимает,
        // что попал в бонус.
        if (spin.free && !bonusAnnounced) {
          bonusAnnounced = true;
          haptic.bigWin();
          const freeCount = round.spins.filter((s) => s.free).length;
          await winFx.celebrateBonus(gsap, freeCount, spin.multiplier, ui.turbo.checked ? 1200 : 2200);
        }
        await present(spin, round);
        if (spin.index < round.spins.length - 1) await sleep(FREE_SPIN_PAUSE_MS);
      }
      ui.balance.textContent = fmt(round.balance);
      ui.win.textContent = round.totalWin > 0 ? `+${fmt(round.totalWin)}` : "0";
      if (round.capped) log(`Потолок ${game.maxWinCap}x`, "win");
      const multiple = winMultiple(round.totalWin, round.totalBet);
      const tier = winTier(multiple);
      setStatus(tier === "none" ? "Без выигрыша" : tier === "mega" ? `МЕГА: ${multiple.toFixed(2)}x` : tier === "big" ? `Крупный: ${multiple.toFixed(2)}x` : `Выигрыш ${multiple.toFixed(2)}x`);
      // Баннер поднимается только на крупных выигрышах: если праздновать
      // каждую мелочь, праздник перестаёт читаться (T-190).
      if (tier === "mega" || tier === "big") haptic.bigWin();
      else if (round.totalWin > 0) haptic.win();
      if (tier === "mega") winFx.shake(gsap, app.stage, 12);
      if (tier === "mega" || tier === "big") {
        await winFx.celebrate(
          gsap,
          tier === "mega" ? "МЕГА-ВЫИГРЫШ" : "КРУПНЫЙ ВЫИГРЫШ",
          `+${fmt(round.totalWin)}`,
          tier === "mega" ? 2200 : 1500,
        );
      }
      log(`Итог #${round.nonce}: ${fmt(round.totalWin)} (${multiple.toFixed(2)}x), RNG ${round.drawCount}`, round.totalWin > 0 ? "win" : "info");
      soundWin(multiple);

      // Reality check модалка (T-039)
      if (round.realityCheck?.message) {
        ui.realityText.textContent = round.realityCheck.message;
        ui.realityModal.classList.remove("hidden");
        log(`Reality check: ${round.realityCheck.message}`, "free");
        // Напоминание о времени в игре обязано останавливать автоспин:
        // иначе окно висит, а серия крутится за спиной игрока.
        stopAuto("напоминание о времени");
      }

      await refreshHistory().catch(() => {});
      return round;
    } catch (error) {
      const message = (error as Error).message;
      setStatus(`Ошибка: ${message}`);
      log(message, "error");
      return null;
    } finally {
      busy = false;
      ui.spin.disabled = false;
      mainButton?.setBusy(false);
    }
  }

  // Reality check handlers
  ui.realityContinue.addEventListener("click", () => ui.realityModal.classList.add("hidden"));
  ui.realityExit.addEventListener("click", () => {
    ui.realityModal.classList.add("hidden");
    setStatus("Перерыв — игра на паузе");
    log("Игрок взял перерыв после reality check", "info");
  });
  ui.realityModal.addEventListener("click", (e) => {
    if (e.target === ui.realityModal) ui.realityModal.classList.add("hidden");
  });

  // --- Бонус-игра «Сундуки короны» (T-195) ---
  //
  // Тир выбирается ДО спина и уходит на сервер вместе с запросом раунда.
  // Так выбор попадает в запись раунда и в проверку: раунд можно
  // переиграть офлайн. Пост-фактум выбор был бы не проверяемым.
  const BONUS_LABELS: Record<number, string> = { 1: "обычный", 5: "рискованный", 25: "всё и сразу" };
  const BONUS_KEY = "casino_bonus_tier";
  let bonusTier = (() => {
    try {
      const stored = Number(localStorage.getItem(BONUS_KEY));
      return stored === 5 || stored === 25 ? stored : 1;
    } catch {
      return 1;
    }
  })();

  function applyBonusTier(tier: number): void {
    bonusTier = tier;
    ui.bonusLabel.textContent = BONUS_LABELS[tier] ?? "обычный";
    try { localStorage.setItem(BONUS_KEY, String(tier)); } catch {}
    for (const node of document.querySelectorAll<HTMLElement>(".chest")) {
      node.classList.toggle("active", Number(node.dataset.tier) === tier);
    }
  }
  applyBonusTier(bonusTier);

  ui.bonusOpen.addEventListener("click", () => ui.bonusModal.classList.remove("hidden"));
  ui.bonusClose.addEventListener("click", () => ui.bonusModal.classList.add("hidden"));
  ui.bonusModal.addEventListener("click", (e) => {
    if (e.target === ui.bonusModal) ui.bonusModal.classList.add("hidden");
  });
  for (const node of document.querySelectorAll<HTMLElement>(".chest")) {
    node.addEventListener("click", () => {
      const tier = Number(node.dataset.tier) || 1;
      applyBonusTier(tier);
      haptic.select();
      // Крышка «открывается» на выбранном сундуке — маленькая обратная связь.
      const img = node.querySelector("img");
      if (img) {
        img.setAttribute("src", "/bonus/chest_open.png");
        setTimeout(() => img.setAttribute("src", "/bonus/chest_closed.png"), 900);
      }
      log(`Бонус: ${BONUS_LABELS[tier]}`, "free");
      setTimeout(() => ui.bonusModal.classList.add("hidden"), 450);
    });
  }

  // В Telegram спин переезжает на нативную главную кнопку: она крупная,
  // всегда внизу экрана и не уезжает при скролле.
  const mainButton = setupMainButton(() => void playRound());

  // --- Автоспин (T-199) ---
  //
  // Серия обычных раундов, а не «пакетный спин» на сервере: пакет ломает
  // лимиты ответственной игры и reality check (см. docs/API.md §6).
  // Каждый спин остаётся отдельным раундом со своим nonce и проверкой.
  const autoState = {
    left: 0,
    profit: 0,
    startBalance: 0,
    running: false,
  };

  function parseLimit(input: HTMLInputElement): number | null {
    const value = Number(input.value.replace(/[^0-9]/g, ""));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function renderAutoButton(): void {
    ui.autoStart.classList.toggle("running", autoState.running);
    ui.autoStart.textContent = autoState.running ? `■ Стоп (${autoState.left})` : "▶ Авто";
  }

  function stopAuto(reason?: string): void {
    if (!autoState.running) return;
    autoState.running = false;
    autoState.left = 0;
    renderAutoButton();
    if (reason) log(`Автоспин остановлен: ${reason}`, "info");
  }

  /** Причина остановки после раунда или null, если можно продолжать. */
  function autoStopReason(round: RoundRecord, balance: number): string | null {
    if (ui.autoStopBonus.checked && round.spins.some((s) => s.free)) return "выпал бонус";
    if (ui.autoStopBigWin.checked && winMultiple(round.totalWin, round.totalBet) >= 20) {
      return `крупный выигрыш ${winMultiple(round.totalWin, round.totalBet).toFixed(1)}×`;
    }
    const floor = parseLimit(ui.autoStopBalance);
    if (floor !== null && balance < floor) return `баланс ниже ${fmt(floor)}`;
    const target = parseLimit(ui.autoStopProfit);
    if (target !== null && autoState.profit >= target) return `набрано +${fmt(autoState.profit)}`;
    return null;
  }

  async function runAuto(): Promise<void> {
    while (autoState.running && autoState.left > 0) {
      autoState.left -= 1;
      renderAutoButton();
      const before = Number(String(ui.balance.textContent ?? "0").replace(/\D/g, ""));
      const round = await playRound();
      if (!round) {
        stopAuto("ошибка раунда");
        return;
      }
      const after = Number(String(ui.balance.textContent ?? "0").replace(/\D/g, ""));
      autoState.profit += after - before;

      const reason = autoStopReason(round, after);
      if (reason) {
        stopAuto(reason);
        return;
      }
      // Пауза между спинами: без неё серия выглядит как один непрерывный
      // рывок, и игрок не успевает прочитать результат.
      await sleep(ui.turbo.checked ? 180 : 420);
    }
    if (autoState.left <= 0) stopAuto("серия закончилась");
  }

  ui.autoStart.addEventListener("click", () => {
    if (autoState.running) {
      stopAuto("остановлено вручную");
      return;
    }
    const count = Number(ui.autoCount.value);
    if (!count) {
      ui.autoModal.classList.remove("hidden");
      return;
    }
    autoState.running = true;
    autoState.left = count;
    autoState.profit = 0;
    autoState.startBalance = Number(String(ui.balance.textContent ?? "0").replace(/\D/g, ""));
    renderAutoButton();
    log(`Автоспин: ${count} спинов`, "info");
    void runAuto();
  });

  ui.autoCount.addEventListener("change", () => {
    if (Number(ui.autoCount.value) > 0) ui.autoModal.classList.remove("hidden");
  });
  ui.autoSettingsClose.addEventListener("click", () => ui.autoModal.classList.add("hidden"));
  ui.autoModal.addEventListener("click", (e) => {
    if (e.target === ui.autoModal) ui.autoModal.classList.add("hidden");
  });

  ui.spin.addEventListener("click", () => void playRound());
  if (inTelegram()) log(`Telegram Mini App · ${api ? "вход по подписи" : ""}`.trim(), "info");
  document.addEventListener("keydown", (event) => {
    if (event.code === "Space") {
      event.preventDefault();
      void playRound();
    }
  });

  ui.applySeed.addEventListener("click", () => {
    void (async () => {
      try {
        const info = await api.setClientSeed(ui.clientSeed.value.trim());
        ui.nonce.textContent = String(info.nonce);
        log(`Сид изменён на «${info.clientSeed}», nonce сброшен`);
      } catch (error) {
        log((error as Error).message, "error");
      }
    })();
  });

  ui.rotate.addEventListener("click", () => {
    void (async () => {
      try {
        const result = await api.rotateSeeds();
        ui.serverHash.textContent = result.nextServerSeedHash;
        ui.nonce.textContent = String(result.nonce);
        log(`Сид раскрыт: ${result.revealed.serverSeed} (раундов: ${result.revealed.roundsPlayed}). Проверьте в верификаторе.`, "free");
        log(`Новый коммитмент: ${result.nextServerSeedHash}`);
      } catch (error) {
        log((error as Error).message, "error");
      }
    })();
  });

  // Paytable
  const paytableHost = document.getElementById("paytable") as HTMLElement;
  for (const symbol of game.symbols) {
    const pays = game.paytable[symbol];
    const theme = SYMBOL_THEMES[symbol];
    const row = document.createElement("div");
    row.className = "pay-row";
    const chip = document.createElement("span");
    chip.className = "pay-chip";
    chip.textContent = theme?.glyph ?? symbol;
    if (theme) {
      chip.style.background = `#${theme.shade.toString(16).padStart(6, "0")}22`;
      chip.style.color = `#${theme.accent.toString(16).padStart(6, "0")}`;
      chip.style.borderColor = `#${theme.accent.toString(16).padStart(6, "0")}`;
    }
    row.appendChild(chip);
    const values = document.createElement("span");
    values.className = "pay-values";
    if (symbol === game.scatter) {
      const parts = Object.entries(game.scatterPays).map(([n, mult]) => `${n}: ${mult}× ставки`);
      values.textContent = parts.join(" · ") || "—";
    } else if (symbol === game.wild) {
      values.textContent = "замещает любой символ, кроме scatter";
    } else if (pays) {
      values.textContent = Object.entries(pays).map(([count, pay]) => `${count}: ${pay}`).join(" · ");
    } else {
      values.textContent = "—";
    }
    row.appendChild(values);
    paytableHost.appendChild(row);
  }

  // RG
  async function refreshRG(): Promise<void> {
    try {
      const data = await api.limits();
      const c = data.counters;
      if (c) ui.rgToday.textContent = `Спины ${c.spinsToday}, ставок ${fmt(c.wageredToday)}, проигрыш ${fmt(c.lossToday)} (неделя ${fmt(c.lossThisWeek)})`;
      else ui.rgToday.textContent = "—";
      const limits = (data as { limits: { kind: string; value: number; effectiveFrom: string; coolingUntil: string | null }[] }).limits ?? [];
      ui.rgLimits.textContent = limits.length === 0 ? "не установлены" : limits.map((l) => `${l.kind}: ${l.value}`).join(" · ");
      ui.rgList.innerHTML = "";
      for (const l of limits) {
        const div = document.createElement("div");
        div.className = "limit-item";
        div.innerHTML = `<span>${l.kind}</span><span>${l.value} ${l.coolingUntil ? " (охлаждение до "+new Date(l.coolingUntil).toLocaleString("ru-RU")+")" : ""}</span>`;
        ui.rgList.appendChild(div);
      }
    } catch (e) {
      ui.rgLimits.textContent = `ошибка: ${(e as Error).message}`;
    }
  }
  await refreshRG().catch(() => {});
  ui.rgRefresh.addEventListener("click", () => void refreshRG());
  ui.rgSet.addEventListener("click", () => {
    void (async () => {
      const kind = ui.rgKind.value;
      const value = Number(ui.rgValue.value);
      if (!Number.isInteger(value) || value <= 0) { log("Значение лимита >0", "error"); return; }
      try {
        const res = await api.setLimit(kind, value);
        log(`Лимит ${kind}=${value}: ${(res as { message?: string }).message ?? "ok"}`, "info");
        await refreshRG();
      } catch (e) { log(`Лимит не установлен: ${(e as Error).message}`, "error"); }
    })();
  });
  ui.seSet.addEventListener("click", () => {
    void (async () => {
      const raw = ui.seKind.value;
      const days = raw === "" ? null : Number(raw);
      if (raw !== "" && (!Number.isInteger(days) || (days as number) <= 0)) { log("Длительность — целое >0 или бессрочно", "error"); return; }
      if (!confirm(`Подтвердить самоисключение ${days === null ? "бессрочно" : days+" дней"}? Снять нельзя.`)) return;
      try {
        const res = await api.selfExclude(days);
        log(`Самоисключение: ${JSON.stringify(res)}`, "free");
        setStatus("Самоисключение активно");
        ui.spin.disabled = true;
      } catch (e) { log(`Самоисключение: ${(e as Error).message}`, "error"); }
    })();
  });

  // История раундов (T-034)
  async function refreshHistory(): Promise<void> {
    try {
      const data = await api.listRounds(20, 0);
      ui.historyList.innerHTML = "";
      for (const r of data.rounds) {
        const div = document.createElement("div");
        div.className = "history-item";
        const winClass = r.totalWin > 0 ? "tag win" : "tag";
        div.innerHTML = `<span>#${r.roundId.slice(0,6)} ${r.gameCode} ${fmt(r.totalBet)}→${fmt(r.totalWin)} <span class="${winClass}">${r.spinsCount ?? "?"} спинов</span></span><span style="color:var(--muted)">${new Date(r.startedAt).toLocaleTimeString()}</span>`;
        div.addEventListener("click", () => void openRound(r.roundId));
        ui.historyList.appendChild(div);
      }
      if (data.rounds.length === 0) ui.historyList.textContent = "пока нет раундов";
    } catch (e) {
      ui.historyList.textContent = `ошибка: ${(e as Error).message}`;
    }
  }
  async function openRound(roundId: string): Promise<void> {
    try {
      const data = await api.getRound(roundId);
      ui.modalRoundId.textContent = roundId.slice(0, 8);
      ui.modalContent.textContent = JSON.stringify(data, null, 2);
      ui.roundModal.classList.remove("hidden");
    } catch (e) { log(`Не удалось загрузить раунд: ${(e as Error).message}`, "error"); }
  }
  ui.historyRefresh.addEventListener("click", () => void refreshHistory());
  ui.modalClose.addEventListener("click", () => ui.roundModal.classList.add("hidden"));
  ui.roundModal.addEventListener("click", (e) => { if (e.target === ui.roundModal) ui.roundModal.classList.add("hidden"); });

  // Верификатор в модалке (T-035)
  ui.verifyOpen.addEventListener("click", () => ui.verifyModal.classList.remove("hidden"));
  ui.verifyClose.addEventListener("click", () => ui.verifyModal.classList.add("hidden"));
  ui.verifyModal.addEventListener("click", (e) => { if (e.target === ui.verifyModal) ui.verifyModal.classList.add("hidden"); });
  ui.vCheck.addEventListener("click", () => {
    void (async () => {
      const serverSeed = ui.vServer.value.trim();
      const clientSeed = ui.vClient.value.trim();
      const nonce = Number(ui.vNonce.value);
      if (!serverSeed || !clientSeed || !Number.isInteger(nonce)) { ui.vResult.textContent = "Заполни все поля"; return; }
      try {
        const res = await api.verifyRound(serverSeed, clientSeed, nonce);
        ui.vResult.textContent = JSON.stringify(res, null, 2);
      } catch (e) { ui.vResult.textContent = `Ошибка: ${(e as Error).message}`; }
    })();
  });

  // Daily bonus (T-049)
  async function claimBonus(): Promise<void> {
    try {
      const res = await (api as any).dailyBonus?.() ?? await fetchWithAuth("/api/v1/bonus/daily", { method: "POST" });
      // fallback if dailyBonus not in api.ts typed
      const data = res as { claimed: boolean; amount: string; balance: string; nextClaimAt: string | null };
      if (data.claimed) {
        ui.bonusStatus.textContent = `Получено ${data.amount} CHIP! Баланс ${fmt(Number(data.balance))}`;
        ui.balance.textContent = fmt(Number(data.balance));
        log(`Daily bonus: +${data.amount} CHIP`, "win");
      } else {
        ui.bonusStatus.textContent = `Уже получено сегодня. Следующий: ${data.nextClaimAt ? new Date(data.nextClaimAt).toLocaleString() : "завтра"}`;
      }
    } catch (e) {
      // Try direct fetch for older api.ts without dailyBonus method
      try {
        const raw = await fetch(apiUrl("/api/v1/bonus/daily"), { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${localStorage.getItem("casino_jwt") || ""}` } });
        const txt = await raw.text();
        const body = JSON.parse(txt);
        if (raw.ok) {
          ui.bonusStatus.textContent = body.claimed ? `Получено ${body.amount} CHIP!` : `Уже получено`;
          if (body.balance) ui.balance.textContent = fmt(Number(body.balance));
        } else {
          ui.bonusStatus.textContent = `Ошибка: ${body.message || raw.status}`;
        }
      } catch (err) {
        ui.bonusStatus.textContent = `Ошибка: ${(e as Error).message}`;
      }
    }
  }
  async function fetchWithAuth(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = (() => { try { return localStorage.getItem("casino_jwt") || ""; } catch { return ""; } })();
    const res = await fetch(apiUrl(path), { ...init, headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) } });
    const txt = await res.text();
    try { return JSON.parse(txt); } catch { return txt; }
  }
  ui.bonusDaily.addEventListener("click", () => void claimBonus());

  // Tournaments & Leaderboard (T-050, T-055, T-074 timer)
  function formatCountdown(endsAt: string): string {
    const diff = new Date(endsAt).getTime() - Date.now();
    if (diff <= 0) return "завершён";
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return `${d}д ${h}ч ${m}м`;
  }
  async function refreshTournaments(): Promise<void> {
    try {
      const data = await fetchWithAuth("/api/v1/tournaments") as { tournaments: { code: string; title: string; status: string; prize_pool: string; ends_at: string }[] };
      ui.tournamentsList.innerHTML = "";
      for (const t of data.tournaments || []) {
        const div = document.createElement("div");
        div.className = "history-item";
        div.innerHTML = `<span>${t.title} <span class="tag">${t.status}</span> приз ${fmt(Number(t.prize_pool))} CHIP <span class="tag">${formatCountdown(t.ends_at)}</span></span><span style="color:var(--muted)">${new Date(t.ends_at).toLocaleDateString()}</span>`;
        div.addEventListener("click", () => void refreshLeaderboard(t.code));
        ui.tournamentsList.appendChild(div);
      }
      if ((data.tournaments || []).length === 0) ui.tournamentsList.textContent = "нет активных турниров";
    } catch (e) { ui.tournamentsList.textContent = `ошибка: ${(e as Error).message}`; }
  }
  async function refreshLeaderboard(code?: string): Promise<void> {
    try {
      const path = code ? `/api/v1/tournaments/${code}/leaderboard?limit=10` : `/api/v1/leaderboard?by=win&period=week&limit=10`;
      const data = await fetchWithAuth(path) as { leaderboard: { rank: number; username: string; totalWin: number; totalBet: number; rounds: number }[] };
      const board = data.leaderboard || (data as { leaderboard: unknown[] }).leaderboard || [];
      ui.leaderboardList.innerHTML = "";
      for (const row of board as { rank: number; username: string; totalWin: number; totalBet: number; rounds: number }[]) {
        const div = document.createElement("div");
        div.className = "history-item";
        div.innerHTML = `<span>#${row.rank} ${row.username} — win ${fmt(row.totalWin)} (bet ${fmt(row.totalBet)})</span><span>${row.rounds} раундов</span>`;
        ui.leaderboardList.appendChild(div);
      }
      if (board.length === 0) ui.leaderboardList.textContent = "пока пусто";
    } catch (e) { ui.leaderboardList.textContent = `ошибка: ${(e as Error).message}`; }
  }
  ui.tournamentsRefresh.addEventListener("click", () => void refreshTournaments());
  ui.leaderboardRefresh.addEventListener("click", () => void refreshLeaderboard());

  // Referrals (T-059) + Progress (T-075)
  async function refreshReferrals(): Promise<void> {
    try {
      const data = await fetchWithAuth("/api/v1/referrals") as { referrals: { referee_id: string; username: string; bonus_amount: string; created_at: string }[]; inviteCode: string };
      ui.refLink.textContent = `${window.location.origin}?ref=${data.inviteCode}`;
      ui.refList.innerHTML = "";
      for (const r of data.referrals || []) {
        const div = document.createElement("div");
        div.className = "history-item";
        div.innerHTML = `<span>${r.username} +${r.bonus_amount} CHIP</span><span>${new Date(r.created_at).toLocaleDateString()}</span>`;
        ui.refList.appendChild(div);
      }
      if ((data.referrals || []).length === 0) ui.refList.textContent = "пока никого не пригласил";

      // Ссылка-приглашение через бота: её можно переслать прямо в Telegram.
      if (data.inviteCode) {
        const invite = document.createElement("div");
        invite.className = "history-item";
        const link = `https://t.me/CasinoSlottor_bot?start=ref_${data.inviteCode}`;
        invite.innerHTML = `<span>Твоя ссылка-приглашение</span>`;
        const copy = document.createElement("button");
        copy.textContent = "Копировать";
        copy.addEventListener("click", () => {
          void navigator.clipboard?.writeText(link).then(
            () => log("Ссылка-приглашение скопирована", "win"),
            () => log(link, "info"),
          );
        });
        invite.appendChild(copy);
        ui.refList.appendChild(invite);
      }

      // Progress T-075
      try {
        const prog = await fetchWithAuth("/api/v1/referrals/progress") as { count: number; target: number; progress: number; remaining: number };
        const bar = document.getElementById("ref-progress-bar") as HTMLElement | null;
        const txt = document.getElementById("ref-progress-text") as HTMLElement | null;
        if (bar) bar.style.width = `${Math.round(prog.progress * 100)}%`;
        if (txt) txt.textContent = `${prog.count}/${prog.target} до мастера рефералов, осталось ${prog.remaining}`;
      } catch {}
    } catch (e) { ui.refList.textContent = `ошибка: ${(e as Error).message}`; }
  }
  ui.refUse.addEventListener("click", () => {
    void (async () => {
      const code = ui.refCode.value.trim();
      if (!code) { log("Вставь код", "error"); return; }
      try {
        const res = await fetchWithAuth("/api/v1/referrals", { method: "POST", body: JSON.stringify({ referralCode: code }) });
        log(`Рефералка активирована: ${JSON.stringify(res)}`, "win");
        await refreshReferrals();
      } catch (e) { log(`Рефералка ошибка: ${(e as Error).message}`, "error"); }
    })();
  });

  // Achievements (T-060)
  async function refreshAchievements(): Promise<void> {
    try {
      const data = await fetchWithAuth("/api/v1/achievements") as { achievements: { code: string; title: string; description: string; reward: string; unlocked_at: string | null }[] };
      ui.achList.innerHTML = "";
      for (const a of data.achievements || []) {
        const div = document.createElement("div");
        div.className = "history-item";
        const unlocked = a.unlocked_at ? "✅" : "⬜";
        div.innerHTML = `<span>${unlocked} ${a.title} — ${a.description} <span class="tag">${a.reward} CHIP</span></span><span style="color:var(--muted)">${a.unlocked_at ? new Date(a.unlocked_at).toLocaleDateString() : ""}</span>`;
        ui.achList.appendChild(div);
      }
    } catch (e) { ui.achList.textContent = `ошибка: ${(e as Error).message}`; }
  }

  // Chat (T-061)
  async function refreshChat(): Promise<void> {
    try {
      const data = await fetchWithAuth("/api/v1/chat?limit=30") as { messages: { username: string; message: string; created_at: string }[] };
      ui.chatList.innerHTML = "";
      for (const m of data.messages || []) {
        const div = document.createElement("div");
        div.className = "history-item";
        div.innerHTML = `<span><b>${m.username}:</b> ${m.message}</span><span style="color:var(--muted)">${new Date(m.created_at).toLocaleTimeString()}</span>`;
        ui.chatList.appendChild(div);
      }
      ui.chatList.scrollTop = ui.chatList.scrollHeight;
    } catch (e) { ui.chatList.textContent = `ошибка: ${(e as Error).message}`; }
  }
  ui.chatSend.addEventListener("click", () => {
    void (async () => {
      const msg = ui.chatMsg.value.trim();
      if (!msg) return;
      try {
        await fetchWithAuth("/api/v1/chat", { method: "POST", body: JSON.stringify({ message: msg }) });
        ui.chatMsg.value = "";
        await refreshChat();
      } catch (e) { log(`Чат ошибка: ${(e as Error).message}`, "error"); }
    })();
  });
  ui.chatMsg.addEventListener("keydown", (e) => { if (e.key === "Enter") ui.chatSend.click(); });

  await refreshHistory().catch(() => {});
  await refreshTournaments().catch(() => {});
  await refreshLeaderboard().catch(() => {});
  await refreshReferrals().catch(() => {});
  await refreshAchievements().catch(() => {});
  await refreshChat().catch(() => {});
  // автообновление чата каждые 10 сек
  setInterval(() => void refreshChat().catch(() => {}), 10000);
}

void main();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Scope service worker'а обязан совпадать с префиксом приложения:
    // под /casino/ регистрация «/sw.js» ушла бы в корень чужого сайта.
    navigator.serviceWorker.register(apiUrl('/sw.js'), { scope: apiUrl('/') + '/' }).catch(() => {});
  });
}

// PWA install prompt (T-086)
let deferredPrompt: any = null;
window.addEventListener('beforeinstallprompt', (e: Event) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.createElement('button');
  btn.textContent = 'Установить приложение';
  btn.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#ffd257;color:#241c05;border:none;padding:10px 16px;border-radius:8px;font-weight:700;z-index:999';
  btn.onclick = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      console.log('PWA choice', choice);
      deferredPrompt = null;
      btn.remove();
    }
  };
  document.body.appendChild(btn);
  setTimeout(() => btn.remove(), 15000);
});
