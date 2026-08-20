/**
 * Приёмка TypeScript-порта математики (T-023).
 *
 * Главный тест здесь — сверка с `tests/fixtures/rounds.json`: 26 раундов,
 * посчитанных независимой реализацией на Python (`slotmath/round.py`).
 * Сверяется не итоговая сумма, а КАЖДЫЙ спин целиком: стопы, сетка,
 * детализация по линиям, множитель, число скаттеров, расход RNG.
 *
 * Такая жёсткость намеренна. Расхождение в одну позицию означает, что
 * игрок, пересчитавший раунд офлайн-верификатором, получит не то, что
 * показал сервер, — и будет прав.
 *
 * Запуск: npm test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, describe } from "node:test";

import { loadConfig, parseConfig, ConfigError, configHash } from "./config.js";
import { NUM_REELS, NUM_ROWS, PAYLINES, NUM_LINES } from "./paylines.js";
import {
  BONUS_TIERS,
  MAX_FREE_SPINS,
  countScatters,
  effectiveBonusMultiplier,
  evaluateLines,
  playRound,
  windowFromStops,
} from "./round.js";

// Сиды для бонус-тестов: любые фиксированные, важна воспроизводимость.
const SERVER_SEED = "b".repeat(64);
const CLIENT_SEED = "bonus-tests";
import { hashServerSeed } from "./rng.js";

const { config: cfg, hash: cfgHash, raw: cfgRaw } = loadConfig("config/game.json");

interface FixtureSpin {
  index: number;
  free: boolean;
  reelStops: number[];
  grid: string[][];
  win: number;
  multiplier: number;
  scatterCount: number;
  triggeredFreeSpins: number;
  winDetails: unknown[];
}

interface FixtureCase {
  kind: string;
  nonce: number;
  serverSeedHash: string;
  clientSeed: string;
  betPerLine: number;
  lines: number;
  totalBet: number;
  totalWin: number;
  capped: boolean;
  drawCount: number;
  spins: FixtureSpin[];
}

interface FixtureFile {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  betPerLine: number;
  configHash: string;
  cases: FixtureCase[];
}

const fixtures = JSON.parse(
  readFileSync("tests/fixtures/rounds.json", "utf8"),
) as FixtureFile;

describe("конфигурация", () => {
  test("хэш совпадает с посчитанным Python", () => {
    // Расхождение означает, что канонизация JSON разъехалась между
    // языками: в истории раундов окажется хэш, который игрок не повторит.
    assert.equal(cfgHash, fixtures.configHash);
  });

  test("хэш устойчив к порядку ключей", () => {
    const shuffled = Object.fromEntries(
      Object.entries(cfgRaw as Record<string, unknown>).reverse(),
    );
    assert.equal(configHash(shuffled), cfgHash);
  });

  test("хэш меняется при изменении математики", () => {
    const tampered = { ...(cfgRaw as Record<string, unknown>), targetRtp: 0.5 };
    assert.notEqual(configHash(tampered), cfgHash);
  });

  test("число линий согласовано с paylines.ts", () => {
    assert.equal(cfg.lines, NUM_LINES);
    assert.equal(PAYLINES.length, 20);
  });

  test("каждая линия задаёт ряд для каждого барабана", () => {
    for (const line of PAYLINES) {
      assert.equal(line.length, NUM_REELS);
      for (const row of line) {
        assert.ok(row >= 0 && row < NUM_ROWS, `ряд ${row} вне сетки`);
      }
    }
  });

  test("линии не дублируются", () => {
    const seen = new Set(PAYLINES.map((line) => line.join(",")));
    assert.equal(seen.size, PAYLINES.length);
  });

  test("валидация отвергает wild на запрещённом барабане", () => {
    const raw = JSON.parse(JSON.stringify(cfgRaw)) as Record<string, unknown>;
    const reels = raw.baseReels as string[][];
    reels[0][0] = cfg.wild; // барабана 0 нет в wildReels
    assert.throws(() => parseConfig(raw), ConfigError);
  });

  test("валидация отвергает барабан без scatter", () => {
    const raw = JSON.parse(JSON.stringify(cfgRaw)) as Record<string, unknown>;
    const reels = raw.baseReels as string[][];
    raw.baseReels = [
      reels[0].map((s) => (s === cfg.scatter ? "TEN" : s)),
      ...reels.slice(1),
    ];
    assert.throws(() => parseConfig(raw), ConfigError);
  });

  test("валидация отвергает scatter в таблице выплат", () => {
    const raw = JSON.parse(JSON.stringify(cfgRaw)) as Record<string, unknown>;
    (raw.paytable as Record<string, unknown>)[cfg.scatter] = { "3": 5 };
    assert.throws(() => parseConfig(raw), ConfigError);
  });
});

describe("окно барабанов", () => {
  test("форма 5 на 3", () => {
    const grid = windowFromStops(cfg.baseReels, [0, 0, 0, 0, 0]);
    assert.equal(grid.length, NUM_REELS);
    for (const column of grid) assert.equal(column.length, NUM_ROWS);
  });

  test("лента кольцевая", () => {
    const strip = cfg.baseReels[0];
    const grid = windowFromStops(cfg.baseReels, [strip.length - 1, 0, 0, 0, 0]);
    assert.equal(grid[0][0], strip[strip.length - 1]);
    assert.equal(grid[0][1], strip[0]);
    assert.equal(grid[0][2], strip[1]);
  });
});

/**
 * Сетка, в которой платить может только центральная линия.
 * Верхний и нижний ряды забиты scatter — единственным символом вне
 * paytable, поэтому он обрывает любую другую линию на первом барабане.
 */
function singleLine(symbols: string[]): string[][] {
  const rows = [
    Array<string>(NUM_REELS).fill(cfg.scatter),
    symbols,
    Array<string>(NUM_REELS).fill(cfg.scatter),
  ];
  const grid: string[][] = [];
  for (let reel = 0; reel < NUM_REELS; reel++) {
    grid.push([rows[0][reel], rows[1][reel], rows[2][reel]]);
  }
  return grid;
}

describe("оценка линий", () => {
  test("заполнитель ничего не платит", () => {
    const { total, details } = evaluateLines(cfg, singleLine(["TEN", "J", "Q", "K", "A"]));
    assert.equal(total, 0);
    assert.deepEqual(details, []);
  });

  test("пять CROWN на центральной линии", () => {
    const { total, details } = evaluateLines(cfg, singleLine(Array(5).fill("CROWN")));
    assert.equal(total, cfg.paytable["CROWN"]["5"]);
    assert.equal(details.length, 1);
    assert.equal(details[0].line, 1);
    assert.equal(details[0].count, 5);
  });

  test("серия обязана начинаться с первого барабана", () => {
    const { total } = evaluateLines(
      cfg,
      singleLine(["TEN", "CROWN", "CROWN", "CROWN", "CROWN"]),
    );
    assert.equal(total, 0);
  });

  test("wild замещает символ", () => {
    const { total, details } = evaluateLines(
      cfg,
      singleLine(["CROWN", "WILD", "CROWN", "TEN", "J"]),
    );
    assert.equal(total, cfg.paytable["CROWN"]["3"]);
    assert.equal(details[0].count, 3);
  });

  test("по линии берётся максимум, а не первый подходящий символ", () => {
    // wild-wild-wild-TEN-TEN: CROWN за 3 (150) выгоднее TEN за 5 (113).
    const { total, details } = evaluateLines(
      cfg,
      singleLine(["WILD", "WILD", "WILD", "TEN", "TEN"]),
    );
    assert.equal(total, 150);
    assert.equal(details[0].symbol, "CROWN");
  });

  test("scatter не платит по линиям", () => {
    const grid: string[][] = [];
    for (let reel = 0; reel < NUM_REELS; reel++) {
      grid.push(Array<string>(NUM_ROWS).fill(cfg.scatter));
    }
    assert.equal(evaluateLines(cfg, grid).total, 0);
  });

  test("scatter считается по всему окну независимо от позиции", () => {
    const grid = singleLine(["TEN", "J", "Q", "K", "A"]);
    // Заполнитель уже даёт 10 скаттеров: 2 ряда по 5 барабанов.
    assert.equal(countScatters(cfg, grid), 10);
  });

  test("однородная сетка оплачивает все двадцать линий", () => {
    const grid: string[][] = [];
    for (let reel = 0; reel < NUM_REELS; reel++) {
      grid.push(Array<string>(NUM_ROWS).fill("CROWN"));
    }
    const { total, details } = evaluateLines(cfg, grid);
    assert.equal(details.length, NUM_LINES);
    assert.equal(total, cfg.paytable["CROWN"]["5"] * NUM_LINES);
  });
});

describe("раунд", () => {
  test("детерминирован", () => {
    const a = playRound(cfg, fixtures.serverSeed, fixtures.clientSeed, 42);
    const b = playRound(cfg, fixtures.serverSeed, fixtures.clientSeed, 42);
    assert.deepEqual(a, b);
  });

  test("ровно пять обращений к RNG на каждый спин", () => {
    for (let nonce = 0; nonce < 300; nonce++) {
      const record = playRound(cfg, fixtures.serverSeed, fixtures.clientSeed, nonce);
      assert.equal(record.drawCount, 5 * record.spins.length, `nonce=${nonce}`);
    }
  });

  test("длина серии равна награде плюс все ретриггеры", () => {
    let found = false;
    for (let nonce = 0; nonce < 3000; nonce++) {
      const record = playRound(cfg, fixtures.serverSeed, fixtures.clientSeed, nonce);
      const base = record.spins[0];
      if (base.triggeredFreeSpins === 0) continue;
      found = true;
      const expected =
        base.triggeredFreeSpins +
        record.spins.filter((s) => s.free).reduce((sum, s) => sum + s.triggeredFreeSpins, 0);
      const actual = record.spins.filter((s) => s.free).length;
      assert.equal(actual, expected, `nonce=${nonce}`);
    }
    assert.ok(found, "в диапазоне не нашлось ни одного триггера");
  });

  test("множитель фриспинов применяется к линиям, но не к scatter", () => {
    for (let nonce = 0; nonce < 2000; nonce++) {
      const record = playRound(cfg, fixtures.serverSeed, fixtures.clientSeed, nonce);
      for (const spin of record.spins) {
        if (!spin.free) continue;
        const linePay = spin.winDetails
          .filter((d) => !d.scatter)
          .reduce((sum, d) => sum + d.pay, 0);
        const scatterPay = (cfg.scatterPays[String(spin.scatterCount)] ?? 0) * record.totalBet;
        assert.equal(spin.win, linePay * cfg.freeSpinMultiplier + scatterPay, `nonce=${nonce}`);
      }
    }
  });

  test("выплата линейна по ставке", () => {
    for (let nonce = 0; nonce < 200; nonce++) {
      const one = playRound(cfg, fixtures.serverSeed, fixtures.clientSeed, nonce, {
        betPerLine: 1,
      });
      const ten = playRound(cfg, fixtures.serverSeed, fixtures.clientSeed, nonce, {
        betPerLine: 10,
      });
      assert.equal(ten.totalBet, one.totalBet * 10);
      assert.equal(ten.totalWin, one.totalWin * 10);
      assert.deepEqual(
        ten.spins.map((s) => s.reelStops),
        one.spins.map((s) => s.reelStops),
      );
    }
  });

  test("стопы не выходят за длину ленты", () => {
    for (let nonce = 0; nonce < 300; nonce++) {
      const record = playRound(cfg, fixtures.serverSeed, fixtures.clientSeed, nonce);
      for (const spin of record.spins) {
        const reels = spin.free ? cfg.freeReels : cfg.baseReels;
        spin.reelStops.forEach((stop, reel) => {
          assert.ok(stop >= 0 && stop < reels[reel].length);
        });
      }
    }
  });

  test("серия фриспинов ограничена предохранителем", () => {
    for (let nonce = 0; nonce < 3000; nonce++) {
      const record = playRound(cfg, fixtures.serverSeed, fixtures.clientSeed, nonce);
      assert.ok(record.spins.filter((s) => s.free).length <= MAX_FREE_SPINS);
    }
  });

  test("потолок выигрыша срабатывает", () => {
    // Боевой потолок 5000x за разумное число раундов недостижим,
    // поэтому проверяем на синтетическом конфиге.
    const raw = JSON.parse(JSON.stringify(cfgRaw)) as Record<string, unknown>;
    raw.maxWinCap = 1;
    const cheap = parseConfig(raw).config;

    let cappedSeen = false;
    for (let nonce = 0; nonce < 200; nonce++) {
      const record = playRound(cheap, fixtures.serverSeed, fixtures.clientSeed, nonce);
      assert.ok(record.totalWin <= record.totalBet);
      if (record.capped) {
        cappedSeen = true;
        assert.equal(record.totalWin, record.totalBet);
      }
    }
    assert.ok(cappedSeen, "потолок ни разу не сработал");
  });

  test("коммитмент записан в раунд", () => {
    const record = playRound(cfg, fixtures.serverSeed, fixtures.clientSeed, 0);
    assert.equal(record.serverSeedHash, hashServerSeed(fixtures.serverSeed));
    assert.equal(record.serverSeedHash, fixtures.serverSeedHash);
  });

  test("betPerLine валидируется", () => {
    assert.throws(() =>
      playRound(cfg, fixtures.serverSeed, fixtures.clientSeed, 0, { betPerLine: 0 }),
    );
    assert.throws(() =>
      playRound(cfg, fixtures.serverSeed, fixtures.clientSeed, 0, { betPerLine: 1.5 }),
    );
  });
});

describe("приёмка: сверка с эталоном на Python", () => {
  test("фикстуры собраны на текущей математике", () => {
    assert.equal(fixtures.configHash, cfgHash);
  });

  test("все 26 раундов воспроизводятся спин в спин", () => {
    assert.ok(fixtures.cases.length >= 20, "фикстур подозрительно мало");

    let checkedSpins = 0;

    for (const expected of fixtures.cases) {
      const actual = playRound(
        cfg,
        fixtures.serverSeed,
        fixtures.clientSeed,
        expected.nonce,
        { betPerLine: fixtures.betPerLine },
      );

      const label = `nonce=${expected.nonce} (${expected.kind})`;

      assert.equal(actual.totalWin, expected.totalWin, `${label}: итоговый выигрыш`);
      assert.equal(actual.totalBet, expected.totalBet, `${label}: ставка`);
      assert.equal(actual.drawCount, expected.drawCount, `${label}: расход RNG`);
      assert.equal(actual.capped, expected.capped, `${label}: потолок`);
      assert.equal(actual.serverSeedHash, expected.serverSeedHash, `${label}: коммитмент`);
      assert.equal(actual.spins.length, expected.spins.length, `${label}: число спинов`);

      for (let i = 0; i < expected.spins.length; i++) {
        checkedSpins++;
        assert.deepEqual(actual.spins[i], expected.spins[i], `${label}, спин ${i}`);
      }
    }

    assert.ok(checkedSpins >= 100, `проверено спинов: ${checkedSpins}`);
  });

  test("покрыты все ветви логики", () => {
    const kinds = new Set(fixtures.cases.map((c) => c.kind));
    for (const required of ["no_win", "line_win_small", "free_spins_3", "retrigger"]) {
      assert.ok(kinds.has(required), `нет фикстуры вида ${required}`);
    }
  });
});

// --- Бонус-игра «Сундуки короны» (T-195) ---

test("тир 1 считается ровно так же, как раунд без бонуса", () => {
  const cfg = loadConfig().config;
  for (let nonce = 0; nonce < 60; nonce += 1) {
    const plain = playRound(cfg, SERVER_SEED, CLIENT_SEED, nonce, { betPerLine: 10 });
    const tier1 = playRound(cfg, SERVER_SEED, CLIENT_SEED, nonce, { betPerLine: 10, bonusTier: 1 });
    assert.equal(tier1.totalWin, plain.totalWin, `nonce=${nonce}`);
    assert.equal(tier1.drawCount, plain.drawCount, `nonce=${nonce}`);
    assert.deepEqual(tier1.spins, plain.spins, `nonce=${nonce}`);
  }
});

test("множитель бонуса — делитель награды и не превышает тир", () => {
  // Награды в конфиге: 10, 15, 25 фриспинов
  assert.equal(effectiveBonusMultiplier(10, 5), 5);
  assert.equal(effectiveBonusMultiplier(15, 5), 5);
  assert.equal(effectiveBonusMultiplier(25, 5), 5);
  assert.equal(effectiveBonusMultiplier(10, 25), 10);
  assert.equal(effectiveBonusMultiplier(15, 25), 15);
  assert.equal(effectiveBonusMultiplier(25, 25), 25);
  // Тир 1 и отсутствие награды не дают множителя
  assert.equal(effectiveBonusMultiplier(10, 1), 1);
  assert.equal(effectiveBonusMultiplier(0, 25), 1);
  // Множитель всегда делит награду нацело — на этом держится равенство EV
  for (const award of [10, 15, 25]) {
    for (const tier of BONUS_TIERS) {
      const m = effectiveBonusMultiplier(award, tier);
      assert.equal(award % m, 0, `award=${award} tier=${tier} m=${m}`);
      assert.ok(m <= Math.max(tier, 1));
    }
  }
});

test("сжатая серия короче ровно во столько раз, во сколько дороже спин", () => {
  const cfg = loadConfig().config;
  // Ищем nonce с триггером фриспинов
  let found = 0;
  for (let nonce = 0; nonce < 4000 && found < 5; nonce += 1) {
    const plain = playRound(cfg, SERVER_SEED, CLIENT_SEED, nonce, { betPerLine: 10 });
    const freeSpins = plain.spins.filter((s) => s.free).length;
    if (freeSpins === 0) continue;
    found += 1;

    const boosted = playRound(cfg, SERVER_SEED, CLIENT_SEED, nonce, { betPerLine: 10, bonusTier: 5 });
    assert.equal(boosted.spins[0].grid.join(), plain.spins[0].grid.join(), "базовый спин обязан совпасть");
    assert.equal(boosted.bonusMultiplier > 1, true, `nonce=${nonce}`);

    const boostedFree = boosted.spins.filter((s) => s.free).length;
    assert.ok(boostedFree < freeSpins, `сжатая серия должна быть короче (nonce=${nonce})`);
  }
  assert.ok(found > 0, "не нашли ни одного триггера фриспинов");
});

test("неизвестный тир бонуса отклоняется", () => {
  const cfg = loadConfig().config;
  assert.throws(() => playRound(cfg, SERVER_SEED, CLIENT_SEED, 0, { bonusTier: 3 }), /bonusTier/);
  assert.throws(() => playRound(cfg, SERVER_SEED, CLIENT_SEED, 0, { bonusTier: 0 }), /bonusTier/);
});
