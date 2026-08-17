/**
 * Тонкий клиент серверного API.
 *
 * Здесь намеренно нет ни одной строчки математики: клиент не знает
 * ни лент, ни вероятностей, ни того, как считается выигрыш. Он умеет
 * только попросить раунд и показать пришедшее. Любая попытка «посчитать
 * выигрыш на клиенте для отзывчивости» — это открытая дверь для
 * подделки результата и повод для провала сертификации.
 *
 * Запросы идут по относительным путям: страница и API живут за одним
 * origin (в dev — через прокси Vite). Абсолютный localhost здесь сломал
 * бы всё, что открыто не с той же машины, где запущен сервер.
 */

/** Одна позиция выигрышной серии: [номер барабана, номер ряда]. */
export type Position = [number, number];

export interface WinDetail {
  line?: number;
  symbol: string;
  count: number;
  positions?: Position[];
  pay: number;
  scatter?: boolean;
}

export interface SpinRecord {
  index: number;
  free: boolean;
  reelStops: number[];
  /** grid[reel][row] — так же, как в движке. */
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
  configHash: string;
  balance: number;
}

export interface GameInfo {
  code: string;
  name: string;
  version: string;
  configHash: string;
  reels: number;
  rows: number;
  lines: number;
  symbols: string[];
  wild: string;
  scatter: string;
  paytable: Record<string, Record<string, number>>;
  scatterPays: Record<string, number>;
  freeSpinsAward: Record<string, number>;
  freeSpinMultiplier: number;
  maxWinCap: number;
  targetRtp: number;
}

export interface SeedInfo {
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

export interface RotateResult {
  revealed: {
    serverSeed: string;
    serverSeedHash: string;
    clientSeed: string;
    roundsPlayed: number;
  };
  nextServerSeedHash: string;
  nonce: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Сервер вернул не JSON (${response.status})`);
  }
  if (!response.ok) {
    const message = (body as { error?: string }).error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  game: () => request<GameInfo>("/api/v1/games/crown-of-fortune"),
  seeds: () => request<SeedInfo>("/api/v1/seeds/current"),
  wallet: () => request<{ balance: number; currency: string }>("/api/v1/wallet"),

  setClientSeed: (clientSeed: string) =>
    request<SeedInfo>("/api/v1/seeds/client", {
      method: "POST",
      body: JSON.stringify({ clientSeed }),
    }),

  rotateSeeds: () =>
    request<RotateResult>("/api/v1/seeds/rotate", { method: "POST" }),

  playRound: (betPerLine: number) =>
    request<RoundRecord>("/api/v1/rounds", {
      method: "POST",
      body: JSON.stringify({ betPerLine }),
    }),
};
