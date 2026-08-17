/**
 * Проигрывание одного раунда: от пары сидов до итоговой выплаты.
 *
 * Порт `slotmath/round.py`, который остаётся эталоном. Соответствие
 * доказывается не глазами, а тестом `round.test.ts`: он прогоняет 26
 * раундов из `tests/fixtures/rounds.json`, сгенерированных Python, и
 * сверяет каждую сетку и каждую выплату.
 *
 * ПОРЯДОК ОБРАЩЕНИЙ К RNG ЗАФИКСИРОВАН И МЕНЯТЬ ЕГО НЕЛЬЗЯ:
 *
 *   1. Базовый спин — 5 обращений nextInt(baseReels[i].length), i = 0..4.
 *   2. Каждый фриспин — 5 обращений nextInt(freeReels[i].length), i = 0..4.
 *      Ретриггер увеличивает счётчик оставшихся спинов, но не порядок.
 *
 * Любая вставка лишнего обращения (например, «случайного» украшения в
 * анимации) сдвинет весь поток, и раунды перестанут воспроизводиться
 * офлайн-верификатором. Всё, что нужно клиенту для показа, выводится
 * из уже полученных стопов.
 */

import type { GameConfig } from "./config.js";
import { NUM_REELS, NUM_ROWS, PAYLINES } from "./paylines.js";
import { RoundRandom, hashServerSeed } from "./rng.js";

/**
 * Предохранитель от бесконечной серии фриспинов.
 *
 * При включённом ретриггере серия теоретически неограниченна. Вероятность
 * дойти до 200 спинов исчезающе мала, но «исчезающе мало» на потоке в
 * миллионы раундов случается, а зависший запрос — это заблокированный
 * баланс игрока. Значение совпадает с MAX_FREE_SPINS в round.py.
 */
export const MAX_FREE_SPINS = 200;

export interface WinDetail {
  /** Номер линии от 1. Отсутствует у выплаты за scatter. */
  line?: number;
  symbol: string;
  count: number;
  /** Пары [барабан, ряд] выигрышной серии. У scatter отсутствуют. */
  positions?: number[][];
  /** Выплата в ставках на линию (для scatter — в ставках на линию от общей ставки). */
  pay: number;
  scatter?: boolean;
}

export interface SpinRecord {
  index: number;
  free: boolean;
  reelStops: number[];
  grid: string[][];
  win: number;
  multiplier: number;
  scatterCount: number;
  triggeredFreeSpins: number;
  winDetails: WinDetail[];
}

export interface RoundRecord {
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  betPerLine: number;
  lines: number;
  totalBet: number;
  totalWin: number;
  capped: boolean;
  drawCount: number;
  spins: SpinRecord[];
}

/** Окно 5x3 в виде grid[reel][row]. Лента кольцевая. */
export function windowFromStops(
  reels: readonly (readonly string[])[],
  stops: readonly number[],
): string[][] {
  const window: string[][] = [];
  for (let reel = 0; reel < NUM_REELS; reel++) {
    const strip = reels[reel];
    const length = strip.length;
    const stop = stops[reel];
    const column: string[] = [];
    for (let row = 0; row < NUM_ROWS; row++) {
      column.push(strip[(stop + row) % length]);
    }
    window.push(column);
  }
  return window;
}

export interface LineEvaluation {
  total: number;
  details: WinDetail[];
}

/**
 * Выплата по всем линиям в ставках на линию плюс детализация.
 *
 * Правило классическое: серия считается слева направо и обязана начинаться
 * с первого барабана, wild замещает любой оплачиваемый символ, а по линии
 * берётся МАКСИМУМ по всем символам.
 *
 * Максимум здесь принципиален. Если брать первый подходящий символ, линия
 * вида wild-wild-wild-TEN-TEN оплатится как пять TEN (113) вместо трёх
 * CROWN (150). Ошибка выглядит безобидной, но на дистанции сдвигает RTP
 * на десятки процентных пунктов и ловится только сверкой с аналитикой.
 */
export function evaluateLines(cfg: GameConfig, grid: string[][]): LineEvaluation {
  let total = 0;
  const details: WinDetail[] = [];

  for (let lineIndex = 0; lineIndex < PAYLINES.length; lineIndex++) {
    const line = PAYLINES[lineIndex];

    const symbols: string[] = [];
    for (let reel = 0; reel < NUM_REELS; reel++) {
      symbols.push(grid[reel][line[reel]]);
    }

    let bestPay = 0;
    let bestSymbol: string | null = null;
    let bestRun = 0;

    for (const symbol of Object.keys(cfg.paytable)) {
      let run = 0;
      for (let reel = 0; reel < NUM_REELS; reel++) {
        if (symbols[reel] === symbol || symbols[reel] === cfg.wild) run++;
        else break;
      }
      const pay = run >= 3 ? cfg.paytable[symbol][String(run)] ?? 0 : 0;
      if (pay > bestPay) {
        bestPay = pay;
        bestSymbol = symbol;
        bestRun = run;
      }
    }

    if (bestPay > 0 && bestSymbol !== null) {
      total += bestPay;
      const positions: number[][] = [];
      for (let reel = 0; reel < bestRun; reel++) positions.push([reel, line[reel]]);
      details.push({
        line: lineIndex + 1,
        symbol: bestSymbol,
        count: bestRun,
        positions,
        pay: bestPay,
      });
    }
  }

  return { total, details };
}

/** Scatter платит по всему окну, позиция не важна. */
export function countScatters(cfg: GameConfig, grid: string[][]): number {
  let count = 0;
  for (let reel = 0; reel < NUM_REELS; reel++) {
    for (let row = 0; row < NUM_ROWS; row++) {
      if (grid[reel][row] === cfg.scatter) count++;
    }
  }
  return count;
}

export interface PlayRoundOptions {
  betPerLine?: number;
}

/**
 * Полный раунд: базовый спин плюс вся серия фриспинов.
 *
 * Возвращается детерминированно: те же сиды и nonce всегда дают тот же
 * результат. Именно на этом держится provably fair — игрок повторит
 * расчёт офлайн и получит то же самое.
 */
export function playRound(
  cfg: GameConfig,
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  options: PlayRoundOptions = {},
): RoundRecord {
  const betPerLine = options.betPerLine ?? 1;
  if (!Number.isInteger(betPerLine) || betPerLine < 1) {
    throw new Error(`betPerLine должен быть целым от 1, получено ${betPerLine}`);
  }

  const rng = new RoundRandom(serverSeed, clientSeed, nonce);
  const totalBet = betPerLine * cfg.lines;
  const spins: SpinRecord[] = [];

  // --- базовый спин ---
  const baseStops: number[] = [];
  for (let reel = 0; reel < NUM_REELS; reel++) {
    baseStops.push(rng.nextInt(cfg.baseReels[reel].length));
  }
  const baseGrid = windowFromStops(cfg.baseReels, baseStops);
  const baseEval = evaluateLines(cfg, baseGrid);
  const baseScatters = countScatters(cfg, baseGrid);

  // Выплата за scatter считается от ОБЩЕЙ ставки, а не от ставки на линию:
  // scatter не привязан к линии, поэтому и множитель применяется к целому.
  const baseScatterMult = cfg.scatterPays[String(baseScatters)] ?? 0;
  const baseScatterPay = baseScatterMult * totalBet;

  const baseDetails: WinDetail[] = [...baseEval.details];
  if (baseScatterPay > 0) {
    baseDetails.push({
      symbol: cfg.scatter,
      count: baseScatters,
      pay: baseScatterMult * cfg.lines,
      scatter: true,
    });
  }

  let triggered = 0;
  let remaining = 0;
  if (baseScatters >= cfg.scatterTrigger) {
    triggered = cfg.freeSpinsAward[String(baseScatters)] ?? 0;
    remaining = triggered;
  }

  const baseWin = baseEval.total * betPerLine + baseScatterPay;
  spins.push({
    index: 0,
    free: false,
    reelStops: baseStops,
    grid: baseGrid,
    win: baseWin,
    multiplier: 1,
    scatterCount: baseScatters,
    triggeredFreeSpins: triggered,
    winDetails: baseDetails,
  });

  let totalWin = baseWin;

  // --- серия фриспинов ---
  let spinIndex = 1;
  let played = 0;

  while (remaining > 0 && played < MAX_FREE_SPINS) {
    remaining -= 1;
    played += 1;

    const stops: number[] = [];
    for (let reel = 0; reel < NUM_REELS; reel++) {
      stops.push(rng.nextInt(cfg.freeReels[reel].length));
    }
    const grid = windowFromStops(cfg.freeReels, stops);
    const evaluation = evaluateLines(cfg, grid);
    const scatters = countScatters(cfg, grid);
    const scatterMult = cfg.scatterPays[String(scatters)] ?? 0;
    const scatterPay = scatterMult * totalBet;

    const details: WinDetail[] = [...evaluation.details];
    if (scatterPay > 0) {
      details.push({
        symbol: cfg.scatter,
        count: scatters,
        pay: scatterMult * cfg.lines,
        scatter: true,
      });
    }

    let retriggered = 0;
    if (cfg.retriggerEnabled && scatters >= cfg.scatterTrigger) {
      retriggered = cfg.freeSpinsAward[String(scatters)] ?? 0;
      remaining += retriggered;
    }

    // Множитель фриспинов умножает ЛИНИИ, но не выплату за scatter.
    // Так посчитан аналитический RTP; распространить множитель на scatter
    // значит незаметно раздать больше заявленного.
    const win = evaluation.total * cfg.freeSpinMultiplier * betPerLine + scatterPay;

    spins.push({
      index: spinIndex,
      free: true,
      reelStops: stops,
      grid,
      win,
      multiplier: cfg.freeSpinMultiplier,
      scatterCount: scatters,
      triggeredFreeSpins: retriggered,
      winDetails: details,
    });

    totalWin += win;
    spinIndex += 1;
  }

  // Потолок применяется к раунду целиком, а не к отдельному спину.
  const cap = cfg.maxWinCap * totalBet;
  const capped = totalWin > cap;
  if (capped) totalWin = cap;

  return {
    serverSeedHash: hashServerSeed(serverSeed),
    clientSeed,
    nonce,
    betPerLine,
    lines: cfg.lines,
    totalBet,
    totalWin,
    capped,
    drawCount: rng.drawCount,
    spins,
  };
}
