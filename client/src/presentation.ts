/**
 * Чистые функции показа: серверный раунд → то, что видит игрок.
 *
 * Вынесены из `main.ts` отдельно ради тестируемости. Это единственная
 * часть клиента, где есть логика, а не вызовы Pixi, и именно здесь
 * прячутся ошибки, которые в браузере выглядят как «символы встали
 * не туда» или «подсветилась не та линия».
 *
 * Ни одна функция ниже НЕ решает исход. Все они принимают уже готовый
 * серверный результат и лишь переводят его в термины рендерера.
 */

import type { ColumnTarget, SymbolPosition } from "pixi-reels";
import type { SpinRecord } from "./api.js";

/**
 * Сетка движка в цели барабанов.
 *
 * Обе стороны используют [барабан][ряд], но полагаться на это молча
 * нельзя: перепутанные оси дают транспонированную сетку, которая
 * выглядит правдоподобно и расходится с сервером. Тест это фиксирует.
 */
export function toColumnTargets(grid: string[][]): ColumnTarget[] {
  return grid.map((column) => ({ visible: [...column] }));
}

/**
 * Ячейки для подсветки без повторов.
 *
 * Одна ячейка нередко входит в несколько выигрышных линий. Показывать
 * её дважды нельзя: spotlight переносит символ в отдельный слой, и
 * повторное перемещение того же объекта ломает возврат на место.
 */
export function winningPositions(spin: SpinRecord): SymbolPosition[] {
  const seen = new Set<string>();
  const positions: SymbolPosition[] = [];
  for (const detail of spin.winDetails) {
    for (const [reel, row] of detail.positions ?? []) {
      const key = `${reel}:${row}`;
      if (seen.has(key)) continue;
      seen.add(key);
      positions.push({ reelIndex: reel, cellIndex: row });
    }
  }
  return positions;
}

/**
 * Барабаны, которые стоит притормозить перед остановкой.
 *
 * Скаттеров уже два и решается следующий — тот самый момент, ради
 * которого игрок и сидит. Исход при этом давно известен: считаем по
 * серверной сетке, анимация лишь подаёт его.
 */
export function anticipationReels(grid: string[][], scatter: string): number[] {
  let seen = 0;
  const reels: number[] = [];
  for (let reel = 0; reel < grid.length; reel++) {
    if (seen >= 2 && reel >= 2) reels.push(reel);
    if (grid[reel].includes(scatter)) seen++;
  }
  return reels;
}

/** Кратность выигрыша к ставке — то, чем игроки меряют результат. */
export function winMultiple(totalWin: number, totalBet: number): number {
  if (totalBet <= 0) return 0;
  return totalWin / totalBet;
}

export type WinTier = "none" | "small" | "medium" | "big" | "mega";

/**
 * Категория выигрыша для подачи.
 *
 * Границы взяты из фикстур (`classify()` в `scripts/gen_fixtures.py`):
 * «крупным» там считается выигрыш от 20x. Держим ту же шкалу, чтобы
 * презентация не называла большим то, что математика таковым не считает.
 */
export function winTier(multiple: number): WinTier {
  if (multiple <= 0) return "none";
  if (multiple < 2) return "small";
  if (multiple < 20) return "medium";
  if (multiple < 100) return "big";
  return "mega";
}
