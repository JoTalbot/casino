/**
 * Тесты презентационного слоя клиента.
 *
 * Сетки берутся не из головы, а из `tests/fixtures/rounds.json` — тех
 * же 26 раундов, которыми проверен движок. Так тест ловит расхождение
 * между тем, что посчитал сервер, и тем, что покажет клиент.
 *
 * Запуск: npm test (в каталоге client)
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  anticipationReels,
  toColumnTargets,
  winMultiple,
  winTier,
  winningPositions,
} from "./presentation.js";
import type { SpinRecord } from "./api.js";

/**
 * Имя символа-триггера читается из конфигурации игры, а не зашивается.
 * При переходе на бонус с сундуками (T-211) scatter переименован в CHEST,
 * и зашитая строка превратила бы осмысленные тесты в ложные падения.
 */
const SCATTER_ID: string = JSON.parse(readFileSync("../config/game.json", "utf8")).scatter;

interface FixtureCase {
  kind: string;
  nonce: number;
  totalBet: number;
  totalWin: number;
  spins: SpinRecord[];
}

const fixtures = JSON.parse(
  readFileSync("../tests/fixtures/rounds.json", "utf8"),
) as { cases: FixtureCase[]; configHash: string };

const allSpins = fixtures.cases.flatMap((c) => c.spins);

describe("перевод сетки в цели барабанов", () => {
  it("сохраняет форму 5x3 на каждом спине фикстур", () => {
    for (const spin of allSpins) {
      const targets = toColumnTargets(spin.grid);
      expect(targets).toHaveLength(5);
      for (const target of targets) expect(target.visible).toHaveLength(3);
    }
  });

  it("не транспонирует оси", () => {
    const grid = [
      ["A", "B", "C"],
      ["D", "E", "F"],
      ["G", "H", "I"],
      ["J", "K", "L"],
      ["M", "N", "O"],
    ];
    const targets = toColumnTargets(grid);
    // targets[reel].visible[row] обязан совпасть с grid[reel][row].
    expect(targets[0].visible[0]).toBe("A");
    expect(targets[0].visible[2]).toBe("C");
    expect(targets[4].visible[1]).toBe("N");
  });

  it("копирует, а не ссылается на серверную сетку", () => {
    const grid = [["A", "B", "C"]];
    const targets = toColumnTargets(grid);
    targets[0].visible[0] = "ИЗМЕНЕНО";
    expect(grid[0][0]).toBe("A");
  });
});

describe("подсветка выигрышей", () => {
  it("не повторяет ячейку, входящую в несколько линий", () => {
    for (const spin of allSpins) {
      const positions = winningPositions(spin);
      const keys = positions.map((p) => `${p.reelIndex}:${p.cellIndex}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("держится в границах сетки", () => {
    for (const spin of allSpins) {
      for (const position of winningPositions(spin)) {
        expect(position.reelIndex).toBeGreaterThanOrEqual(0);
        expect(position.reelIndex).toBeLessThan(5);
        expect(position.cellIndex).toBeGreaterThanOrEqual(0);
        expect(position.cellIndex).toBeLessThan(3);
      }
    }
  });

  it("подсвечивает ровно те символы, за которые заплачено", () => {
    for (const spin of allSpins) {
      for (const detail of spin.winDetails) {
        if (detail.scatter || !detail.positions) continue;
        // Каждая позиция серии — либо сам символ, либо замещающий его wild.
        for (const [reel, row] of detail.positions) {
          const shown = spin.grid[reel][row];
          expect([detail.symbol, "WILD"]).toContain(shown);
        }
        expect(detail.positions).toHaveLength(detail.count);
      }
    }
  });

  it("выплата за scatter не даёт позиций для подсветки линии", () => {
    const withScatterPay = allSpins.filter((s) => s.winDetails.some((d) => d.scatter));
    for (const spin of withScatterPay) {
      const scatterDetail = spin.winDetails.find((d) => d.scatter);
      expect(scatterDetail?.positions).toBeUndefined();
    }
  });

  it("спин без выигрыша не подсвечивает ничего", () => {
    const dry = allSpins.filter((s) => s.win === 0);
    expect(dry.length).toBeGreaterThan(0);
    for (const spin of dry) {
      // Ноль выплаты по линиям означает пустую подсветку; выплата за
      // scatter при этом возможна, но она не имеет позиций.
      const linePositions = winningPositions(spin);
      expect(linePositions).toHaveLength(0);
    }
  });
});

describe("предвкушение (anticipation)", () => {
  it("молчит, когда скаттеров меньше двух", () => {
    const grid = [
      ["TEN", "J", "Q"],
      ["K", "A", "TEN"],
      ["J", "Q", "K"],
      ["A", "TEN", "J"],
      ["Q", "K", "A"],
    ];
    expect(anticipationReels(grid, SCATTER_ID)).toEqual([]);
  });

  it("тормозит оставшиеся барабаны после второго скаттера", () => {
    const grid = [
      [SCATTER_ID, "J", "Q"],
      [SCATTER_ID, "A", "TEN"],
      ["J", "Q", "K"],
      ["A", "TEN", "J"],
      ["Q", "K", "A"],
    ];
    expect(anticipationReels(grid, SCATTER_ID)).toEqual([2, 3, 4]);
  });

  it("не возвращает индексы вне набора барабанов", () => {
    for (const spin of allSpins) {
      for (const reel of anticipationReels(spin.grid, SCATTER_ID)) {
        expect(reel).toBeGreaterThanOrEqual(0);
        expect(reel).toBeLessThan(5);
      }
    }
  });

  it("срабатывает хотя бы на одном спине из фикстур", () => {
    const triggered = allSpins.filter((s) => anticipationReels(s.grid, SCATTER_ID).length > 0);
    expect(triggered.length).toBeGreaterThan(0);
  });
});

describe("категория выигрыша", () => {
  it("совпадает с classify() из генератора фикстур", () => {
    for (const round of fixtures.cases) {
      const tier = winTier(winMultiple(round.totalWin, round.totalBet));
      if (round.kind === "no_win") expect(tier).toBe("none");
      if (round.kind === "line_win_small") expect(tier).toBe("small");
      if (round.kind === "line_win_mid") expect(tier).toBe("medium");
      if (round.kind === "big_win") expect(["big", "mega"]).toContain(tier);
    }
  });

  it("не делит на ноль при нулевой ставке", () => {
    expect(winMultiple(100, 0)).toBe(0);
    expect(winTier(winMultiple(100, 0))).toBe("none");
  });

  it("границы шкалы взяты из фикстур: 2x, 20x, 100x", () => {
    expect(winTier(1.99)).toBe("small");
    expect(winTier(2)).toBe("medium");
    expect(winTier(19.99)).toBe("medium");
    expect(winTier(20)).toBe("big");
    expect(winTier(100)).toBe("mega");
  });
});

describe("целостность фикстур", () => {
  it("сумма выплат спинов равна итогу раунда, если потолок не сработал", () => {
    for (const round of fixtures.cases) {
      const sum = round.spins.reduce((acc, spin) => acc + spin.win, 0);
      expect(sum).toBe(round.totalWin);
    }
  });
});
