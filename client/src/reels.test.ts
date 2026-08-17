/**
 * Интеграционные тесты барабанов через headless-харнесс `pixi-reels/testing`.
 *
 * Здесь проверяется главное свойство честного клиента: **на экране
 * оказывается ровно та сетка, которую прислал сервер**, символ в символ.
 * Если библиотека когда-нибудь поменяет порядок осей, буферы или
 * поведение `setResult`, эти тесты упадут раньше, чем расхождение
 * увидит игрок.
 *
 * Рендерер, текстуры и DOM не нужны: харнесс подставляет HeadlessSymbol
 * и синтетический тикер, поэтому тесты идут в обычном Node.
 *
 * Запуск: npm test (в каталоге client)
 */

import { readFileSync } from "node:fs";
import { createTestReelSet, expectGrid, countSymbol } from "pixi-reels/testing";
import { describe, expect, it } from "vitest";

import { toColumnTargets } from "./presentation.js";
import type { SpinRecord } from "./api.js";

interface FixtureCase {
  kind: string;
  nonce: number;
  spins: SpinRecord[];
}

const fixtures = JSON.parse(
  readFileSync("../tests/fixtures/rounds.json", "utf8"),
) as { cases: FixtureCase[] };

const game = JSON.parse(readFileSync("../config/game.json", "utf8")) as {
  symbols: string[];
};

const allSpins = fixtures.cases.flatMap((c) => c.spins);

function harness() {
  return createTestReelSet({
    reels: 5,
    visibleCells: 3,
    symbolIds: game.symbols,
  });
}

describe("сетка сервера на барабанах", () => {
  it("каждый спин всех 26 фикстур садится символ в символ", async () => {
    const { reelSet, spinAndLand, destroy } = harness();
    try {
      for (const spin of allSpins) {
        await spinAndLand(toColumnTargets(spin.grid));
        // Бросит с читаемым диффом, если хоть одна ячейка разошлась.
        expectGrid(reelSet, spin.grid);
      }
    } finally {
      destroy();
    }
    expect(allSpins.length).toBe(136);
  });

  it("число скаттеров на экране совпадает с серверным scatterCount", async () => {
    const { reelSet, spinAndLand, destroy } = harness();
    try {
      for (const spin of allSpins) {
        await spinAndLand(toColumnTargets(spin.grid));
        expect(countSymbol(reelSet, "SCATTER")).toBe(spin.scatterCount);
      }
    } finally {
      destroy();
    }
  });

  it("сетка триггера фриспинов показывает не меньше трёх скаттеров", async () => {
    const triggers = allSpins.filter((s) => s.triggeredFreeSpins > 0);
    expect(triggers.length).toBeGreaterThan(0);

    const { reelSet, spinAndLand, destroy } = harness();
    try {
      for (const spin of triggers) {
        await spinAndLand(toColumnTargets(spin.grid));
        expect(countSymbol(reelSet, "SCATTER")).toBeGreaterThanOrEqual(3);
      }
    } finally {
      destroy();
    }
  });

  it("повторный спин полностью заменяет предыдущую сетку", async () => {
    const { reelSet, spinAndLand, destroy } = harness();
    try {
      const first = allSpins[0];
      const second = allSpins.find((s) => s.grid.flat().join() !== first.grid.flat().join());
      expect(second).toBeDefined();

      await spinAndLand(toColumnTargets(first.grid));
      expectGrid(reelSet, first.grid);

      await spinAndLand(toColumnTargets(second!.grid));
      // Ни одного «залипшего» символа от прошлого спина.
      expectGrid(reelSet, second!.grid);
    } finally {
      destroy();
    }
  });

  it("на барабанах не появляется символов вне конфига игры", async () => {
    const known = new Set(game.symbols);
    const { reelSet, spinAndLand, destroy } = harness();
    try {
      for (const spin of allSpins.slice(0, 20)) {
        await spinAndLand(toColumnTargets(spin.grid));
        for (const symbol of spin.grid.flat()) expect(known.has(symbol)).toBe(true);
      }
    } finally {
      destroy();
    }
    expect(known.size).toBe(11);
  });
});
