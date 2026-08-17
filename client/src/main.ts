/**
 * Прототип клиента слота (T-014).
 *
 * Архитектурное правило, ради которого всё это и написано: КЛИЕНТ НЕ
 * РЕШАЕТ НИЧЕГО. Сервер играет весь раунд целиком (базовый спин плюс
 * серию фриспинов) и присылает готовые сетки. Клиент крутит барабаны
 * ради ощущения игры, а затем показывает то, что уже произошло.
 *
 * Поэтому `.weights()` у билдера здесь настроен только для символов,
 * мелькающих ВО ВРЕМЯ вращения, и не влияет на исход: посадку задаёт
 * `setResult()` с серверной сеткой.
 *
 * Последовательность одного раунда:
 *   1. POST /rounds — сервер играет всё сразу.
 *   2. spin() + setResult(базовый спин) — показываем базовый.
 *   3. Если пришли фриспины — по очереди показываем каждый.
 *   4. Подсвечиваем выигрышные линии.
 */

import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { ReelSetBuilder, SpeedPresets } from "pixi-reels";
import gsap from "gsap";

import { api, type GameInfo, type RoundRecord, type SpinRecord } from "./api.js";
import {
  anticipationReels,
  toColumnTargets,
  winMultiple,
  winningPositions,
  winTier,
} from "./presentation.js";
import { ShapeSymbol, SYMBOL_THEMES } from "./symbols.js";

const REELS = 5;
const ROWS = 3;
const CELL = 116;
const GAP = 8;

/** Пауза между спинами серии, чтобы игрок успел прочитать результат. */
const FREE_SPIN_PAUSE_MS = 850;
const WIN_DISPLAY_MS = 1400;

const ui = {
  balance: document.getElementById("balance") as HTMLElement,
  bet: document.getElementById("bet") as HTMLSelectElement,
  spin: document.getElementById("spin") as HTMLButtonElement,
  turbo: document.getElementById("turbo") as HTMLInputElement,
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

async function main(): Promise<void> {
  let game: GameInfo;
  try {
    game = await api.game();
  } catch (error) {
    setStatus(`Сервер недоступен: ${(error as Error).message}`);
    log(`Не удалось получить описание игры: ${(error as Error).message}`, "error");
    return;
  }

  ui.gameName.textContent = `${game.name} v${game.version}`;
  ui.configHash.textContent = game.configHash;
  ui.configHash.title = "SHA-256 математики. Тот же хэш вшит в офлайн-верификатор.";

  const app = new Application();
  await app.init({
    width: REELS * CELL + (REELS - 1) * GAP + 40,
    height: ROWS * CELL + (ROWS - 1) * GAP + 40,
    background: "#0a0d14",
    antialias: true,
  });
  ui.stage.appendChild(app.canvas);

  const frame = new Graphics()
    .roundRect(6, 6, app.screen.width - 12, app.screen.height - 12, 16)
    .fill({ color: 0x11151f })
    .stroke({ width: 2, color: 0x2a3346 });
  app.stage.addChild(frame);

  const board = new Container();
  board.position.set(20, 20);
  app.stage.addChild(board);

  const reelSet = new ReelSetBuilder()
    .reels(REELS)
    .visibleCells(ROWS)
    .symbolSize(CELL, CELL)
    .symbolGap(GAP, GAP)
    .symbols((registry) => {
      for (const id of game.symbols) registry.register(id, ShapeSymbol, {});
    })
    // Веса влияют ТОЛЬКО на мелькание во время вращения. Исход задаёт
    // setResult() серверной сеткой, поэтому равные веса здесь безопасны.
    .weights(Object.fromEntries(game.symbols.map((id) => [id, 1])))
    .speed("normal", SpeedPresets.NORMAL)
    .speed("turbo", SpeedPresets.TURBO)
    .initialSpeed("normal")
    .ticker(app.ticker)
    .gsap(gsap)
    .build();

  board.addChild(reelSet);

  // Стартовая витрина: пока никто не крутил, показываем нейтральную сетку.
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

  log(`Игра загружена. Коммитмент сервера: ${seeds.serverSeedHash.slice(0, 16)}…`);
  setStatus("Готово к игре");

  let busy = false;

  /** Показ одного спина: вращение, посадка на серверную сетку, подсветка. */
  async function present(spin: SpinRecord, round: RoundRecord): Promise<void> {
    const targets = toColumnTargets(spin.grid);
    const anticipation = anticipationReels(spin.grid, game.scatter);

    const spinPromise = reelSet.spin();
    if (anticipation.length > 0) reelSet.setAnticipation(anticipation);
    reelSet.setResult(targets);
    await spinPromise;

    if (spin.win > 0) {
      const positions = winningPositions(spin);
      const label = spin.free
        ? `Фриспин ${spin.index}: +${fmt(spin.win)}${spin.multiplier > 1 ? ` (×${spin.multiplier} на линии)` : ""}`
        : `Выигрыш: +${fmt(spin.win)}`;
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
        log(
          spin.free
            ? `Ретриггер: ещё ${awarded} фриспинов (${spin.scatterCount} scatter)`
            : `Бонус: ${awarded} фриспинов (${spin.scatterCount} scatter)`,
          "free",
        );
      }
      const scatterPay = spin.winDetails.find((d) => d.scatter);
      if (scatterPay) {
        log(`Выплата за scatter: ${scatterPay.count} шт., +${fmt(scatterPay.pay * round.betPerLine)}`, "win");
      }
    }
  }

  async function playRound(): Promise<void> {
    if (busy) return;
    busy = true;
    ui.spin.disabled = true;
    ui.win.textContent = "—";
    setStatus("Запрос раунда у сервера…");

    try {
      const betPerLine = Number(ui.bet.value);
      reelSet.setSpeed(ui.turbo.checked ? "turbo" : "normal");

      // Весь раунд решается ЗДЕСЬ, одним запросом. Дальше — только показ.
      const round = await api.playRound(betPerLine);

      ui.nonce.textContent = String(round.nonce + 1);
      setStatus(`Раунд #${round.nonce}: ставка ${fmt(round.totalBet)}`);
      log(`Раунд #${round.nonce}: ставка ${fmt(round.totalBet)}, спинов ${round.spins.length}`);

      for (const spin of round.spins) {
        await present(spin, round);
        if (spin.index < round.spins.length - 1) await sleep(FREE_SPIN_PAUSE_MS);
      }

      ui.balance.textContent = fmt(round.balance);
      ui.win.textContent = round.totalWin > 0 ? `+${fmt(round.totalWin)}` : "0";

      if (round.capped) {
        log(`Сработал потолок выигрыша ${game.maxWinCap}x`, "win");
      }

      // Шкала категорий — общая с фикстурами, см. presentation.ts.
      const multiple = winMultiple(round.totalWin, round.totalBet);
      const tier = winTier(multiple);
      if (tier === "none") {
        setStatus("Без выигрыша");
      } else if (tier === "mega") {
        setStatus(`МЕГА-ВЫИГРЫШ: ${multiple.toFixed(2)}x`);
      } else if (tier === "big") {
        setStatus(`Крупный выигрыш: ${multiple.toFixed(2)}x`);
      } else {
        setStatus(`Выигрыш ${multiple.toFixed(2)}x`);
      }

      log(
        `Итог раунда #${round.nonce}: ${fmt(round.totalWin)} (${multiple.toFixed(2)}x), ` +
          `обращений к RNG: ${round.drawCount}`,
        round.totalWin > 0 ? "win" : "info",
      );
    } catch (error) {
      const message = (error as Error).message;
      setStatus(`Ошибка: ${message}`);
      log(message, "error");
    } finally {
      busy = false;
      ui.spin.disabled = false;
    }
  }

  ui.spin.addEventListener("click", () => void playRound());

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
        log(`Клиентский сид изменён на «${info.clientSeed}», nonce сброшен`);
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
        log(
          `Сид раскрыт: ${result.revealed.serverSeed} ` +
            `(сыграно раундов: ${result.revealed.roundsPlayed}). ` +
            `Проверьте их в verifier/verify.html.`,
          "free",
        );
        log(`Новый коммитмент: ${result.nextServerSeedHash}`);
      } catch (error) {
        log((error as Error).message, "error");
      }
    })();
  });

  // Таблица выплат — из серверного описания игры, не из констант клиента.
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
      chip.style.background = `#${theme.fill.toString(16).padStart(6, "0")}`;
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
      values.textContent = Object.entries(pays)
        .map(([count, pay]) => `${count}: ${pay}`)
        .join(" · ");
    } else {
      values.textContent = "—";
    }
    row.appendChild(values);
    paytableHost.appendChild(row);
  }
}

void main();
