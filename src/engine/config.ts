/**
 * Загрузка и валидация конфигурации игры.
 *
 * Единственный источник правды — `config/game.json`, собираемый
 * `scripts/build_game.py`. Здесь он только читается и проверяется:
 * TypeScript-код НИКОГДА не пересчитывает ленты и таблицу выплат
 * самостоятельно, иначе появится вторая версия математики.
 *
 * Хэш конфигурации (SHA-256 канонического JSON) обязан совпадать с тем,
 * что посчитал Python. Он пишется в каждый раунд: без него история
 * непроверяема — игрок не докажет, на какой именно математике он играл.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NUM_REELS, NUM_LINES } from "./paylines.js";

/** Ярусы выплат: число совпадений -> выплата в ставках на линию. */
export type PayTiers = Readonly<Record<string, number>>;

export interface GameConfig {
  readonly name: string;
  readonly version: string;
  readonly symbols: readonly string[];
  readonly wild: string;
  readonly scatter: string;
  readonly lines: number;
  readonly paytable: Readonly<Record<string, PayTiers>>;
  readonly baseReels: readonly (readonly string[])[];
  readonly freeReels: readonly (readonly string[])[];
  readonly scatterTrigger: number;
  readonly freeSpinsAward: Readonly<Record<string, number>>;
  readonly scatterPays: Readonly<Record<string, number>>;
  readonly freeSpinMultiplier: number;
  readonly retriggerEnabled: boolean;
  readonly wildReels: readonly number[];
  readonly targetRtp: number;
  readonly maxWinCap: number;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Канонический JSON для хэширования.
 *
 * Формат обязан посимвольно совпадать с эталоном на Python
 * (`GameConfig.config_hash` в `slotmath/config.py`), иначе при одной и той
 * же математике хэши разойдутся и раунды перестанут проверяться.
 *
 * Эталон использует `json.dumps(sort_keys=True, ensure_ascii=False)` с
 * РАЗДЕЛИТЕЛЯМИ ПО УМОЛЧАНИЮ, то есть `", "` между элементами и `": "`
 * после ключа. Это не компактная форма: пробелы входят в хэшируемую
 * строку. Хэш 5f9b9c35… уже записан в фикстуры, PAR sheet и вшит в
 * офлайн-верификатор, поэтому подгоняется реализация, а не эталон.
 *
 * Ключи сортируются как в Python — по кодовым точкам. `Array.prototype.sort`
 * по умолчанию сравнивает строки в UTF-16, что совпадает с порядком кодовых
 * точек для всего BMP; ключи конфигурации — ASCII, так что расхождение
 * возможно только на суррогатных парах, которых в схеме нет.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(", ") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (key) =>
      JSON.stringify(key) + ": " + canonicalJson((value as Record<string, unknown>)[key]),
  );
  return "{" + parts.join(", ") + "}";
}

export function configHash(raw: unknown): string {
  return createHash("sha256").update(canonicalJson(raw), "utf8").digest("hex");
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ConfigError(`${field}: ожидался массив`);
  return value;
}

/**
 * Проверки, каждая из которых закрывает конкретную ошибку,
 * способную тихо увести RTP или сломать воспроизводимость раунда.
 */
function validate(cfg: GameConfig): void {
  if (cfg.lines !== NUM_LINES) {
    throw new ConfigError(
      `lines=${cfg.lines}, а в paylines.ts определено ${NUM_LINES} линий`,
    );
  }

  for (const [field, reels] of [
    ["baseReels", cfg.baseReels],
    ["freeReels", cfg.freeReels],
  ] as const) {
    if (reels.length !== NUM_REELS) {
      throw new ConfigError(`${field}: барабанов ${reels.length}, ожидалось ${NUM_REELS}`);
    }
    reels.forEach((strip, index) => {
      if (strip.length === 0) throw new ConfigError(`${field}[${index}]: пустая лента`);
      for (const symbol of strip) {
        if (!cfg.symbols.includes(symbol)) {
          throw new ConfigError(`${field}[${index}]: неизвестный символ "${symbol}"`);
        }
      }
    });
  }

  if (!cfg.symbols.includes(cfg.wild)) {
    throw new ConfigError(`wild "${cfg.wild}" отсутствует в списке символов`);
  }
  if (!cfg.symbols.includes(cfg.scatter)) {
    throw new ConfigError(`scatter "${cfg.scatter}" отсутствует в списке символов`);
  }

  // Wild и scatter не должны иметь линейных выплат: wild платит как
  // замещаемый символ, scatter — по всему окну, а не по линии.
  if (cfg.paytable[cfg.wild]) {
    throw new ConfigError("wild не должен присутствовать в paytable");
  }
  if (cfg.paytable[cfg.scatter]) {
    throw new ConfigError("scatter не должен присутствовать в paytable");
  }

  // Scatter обязан встречаться на каждом барабане, иначе триггер недостижим.
  cfg.baseReels.forEach((strip, index) => {
    if (!strip.includes(cfg.scatter)) {
      throw new ConfigError(`baseReels[${index}]: нет ни одного scatter`);
    }
  });

  // Wild только на разрешённых барабанах. Wild на первом барабане —
  // классическая ошибка, разгоняющая RTP на единицы процентов.
  cfg.baseReels.forEach((strip, index) => {
    const hasWild = strip.includes(cfg.wild);
    const allowed = cfg.wildReels.includes(index);
    if (hasWild && !allowed) {
      throw new ConfigError(`baseReels[${index}]: wild вне разрешённых wildReels`);
    }
  });

  if (cfg.scatterTrigger < 2) {
    throw new ConfigError(`scatterTrigger=${cfg.scatterTrigger} слишком мал`);
  }
  if (cfg.freeSpinMultiplier < 1) {
    throw new ConfigError(`freeSpinMultiplier=${cfg.freeSpinMultiplier} меньше единицы`);
  }
  if (cfg.maxWinCap <= 0) {
    throw new ConfigError(`maxWinCap=${cfg.maxWinCap} должен быть положительным`);
  }

  for (const [count, tiers] of Object.entries(cfg.paytable)) {
    for (const [matches, pay] of Object.entries(tiers)) {
      if (!Number.isInteger(pay) || pay < 0) {
        throw new ConfigError(`paytable[${count}][${matches}]: выплата должна быть целой и неотрицательной`);
      }
    }
  }
}

export interface LoadedConfig {
  readonly config: GameConfig;
  readonly hash: string;
  /** Исходный разобранный JSON — нужен для повторного хэширования. */
  readonly raw: unknown;
}

/** Разбирает уже прочитанный JSON. Полезно в тестах и в браузере. */
export function parseConfig(raw: unknown): LoadedConfig {
  if (raw === null || typeof raw !== "object") {
    throw new ConfigError("конфигурация должна быть объектом JSON");
  }
  const obj = raw as Record<string, unknown>;

  requireArray(obj.symbols, "symbols");
  requireArray(obj.baseReels, "baseReels");
  requireArray(obj.freeReels, "freeReels");

  const config = obj as unknown as GameConfig;
  validate(config);

  return { config, hash: configHash(raw), raw };
}

export function loadConfig(path = "config/game.json"): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`не удалось прочитать ${path}: ${(error as Error).message}`);
  }
  return parseConfig(JSON.parse(text));
}
