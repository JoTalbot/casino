/**
 * Тонкий клиент серверного API.
 *
 * Здесь намеренно нет ни одной строчки математики: клиент не знает
 * ни лент, ни вероятностей, ни того, как считается выигрыш. Он умеет
 * только попросить раунд и показать пришедшее.
 *
 * Работает с двумя бэкендами:
 * - учебный devServer (node:http, без JWT, без Idempotency-Key)
 * - боевой Fastify + PostgreSQL (JWT, Idempotency-Key, OpenAPI)
 *
 * Для боевого сервера клиент получает JWT через POST /api/v1/auth/demo
 * (гостевой вход, только CHIP фишки). Токен хранится в localStorage и
 * добавляется в заголовок Authorization: Bearer <token>.
 */

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

/* ------------------------------------------------------------------ */
/* Токен и Idempotency                                                */
/* ------------------------------------------------------------------ */

const TOKEN_KEY = "casino_jwt";

function getStoredToken(): string | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Node-тесты: localStorage отсутствует
  }
  return null;
}

function setStoredToken(token: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // ignore
  }
}

function clearStoredToken(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T; rawText: string }> {
  const resp = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await resp.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Сервер вернул не JSON (${resp.status})`);
  }
  return { status: resp.status, body: body as T, rawText: text };
}

/** Обеспечивает наличие JWT: если нет — создаёт гостя через /auth/demo */
async function ensureAuth(): Promise<string | null> {
  const existing = getStoredToken();
  if (existing) return existing;
  try {
    const { status, body } = await fetchJson<{ token: string }>(`/api/v1/auth/demo`, { method: "POST" });
    if (status === 201 || status === 200) {
      const token = (body as { token: string }).token;
      if (token) {
        setStoredToken(token);
        return token;
      }
    }
  } catch {
    // devServer не имеет /auth/demo — это нормально, работаем без JWT
  }
  return null;
}

async function request<T>(path: string, init?: RequestInit, retryAuth = true): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (token) headers["authorization"] = `Bearer ${token}`;

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Сервер вернул не JSON (${response.status})`);
  }

  if (response.status === 401 && retryAuth) {
    // Токен истёк или отсутствует — пробуем получить новый через demo
    clearStoredToken();
    const newToken = await ensureAuth();
    if (newToken) {
      const retryHeaders = { ...headers, authorization: `Bearer ${newToken}` };
      const retryResp = await fetch(path, { ...init, headers: retryHeaders });
      const retryText = await retryResp.text();
      let retryBody: unknown;
      try {
        retryBody = retryText ? JSON.parse(retryText) : {};
      } catch {
        throw new Error(`Сервер вернул не JSON (${retryResp.status})`);
      }
      if (!retryResp.ok) {
        const msg = (retryBody as { error?: string; message?: string; code?: string }).error
          ?? (retryBody as { message?: string }).message
          ?? `HTTP ${retryResp.status}`;
        throw new Error(msg);
      }
      return retryBody as T;
    }
  }

  if (!response.ok) {
    const msg =
      (body as { error?: string; message?: string; code?: string }).error ??
      (body as { message?: string }).message ??
      `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return body as T;
}

/* ------------------------------------------------------------------ */
/* Нормализаторы: приводят ответ боевого API к формату devServer      */
/* ------------------------------------------------------------------ */

function normalizeRound(raw: unknown): RoundRecord {
  const r = raw as Record<string, unknown>;

  // Баланс может быть числом, строкой, объектом {amount} или {balance}
  let balanceNum = 0;
  if (typeof r.balance === "number") balanceNum = r.balance;
  else if (typeof (r as { balanceLegacy?: number }).balanceLegacy === "number") balanceNum = (r as { balanceLegacy: number }).balanceLegacy;
  else if (typeof r.balance === "object" && r.balance !== null) {
    const b = r.balance as Record<string, unknown>;
    if (typeof b.amount === "string") balanceNum = Number(b.amount);
    else if (typeof b.amount === "number") balanceNum = b.amount;
    else if (typeof (b as { balance?: number }).balance === "number") balanceNum = (b as { balance: number }).balance;
    else if (typeof (b as { balance?: string }).balance === "string") balanceNum = Number((b as { balance: string }).balance);
  }

  const bet = (r.bet as { perLine?: number; lines?: number; total?: number }) ?? {};
  const fairness = (r.fairness as { serverSeedHash?: string; clientSeed?: string; nonce?: number; drawCount?: number }) ?? {};

  return {
    serverSeedHash: (r.serverSeedHash as string) ?? fairness.serverSeedHash ?? "",
    clientSeed: (r.clientSeed as string) ?? fairness.clientSeed ?? "",
    nonce: (r.nonce as number) ?? fairness.nonce ?? 0,
    betPerLine: (r.betPerLine as number) ?? bet.perLine ?? 10,
    lines: (r.lines as number) ?? bet.lines ?? 20,
    totalBet: (r.totalBet as number) ?? bet.total ?? 0,
    totalWin: (r.totalWin as number) ?? 0,
    capped: (r.capped as boolean) ?? false,
    drawCount: (r.drawCount as number) ?? fairness.drawCount ?? 0,
    spins: (r.spins as SpinRecord[]) ?? [],
    configHash: (r.configHash as string) ?? "",
    balance: balanceNum,
  };
}

function normalizeGame(raw: unknown): GameInfo {
  const g = raw as Record<string, unknown>;
  // Новый сервер возвращает title + name, старый — только name.
  // Поддерживаем оба.
  return {
    code: (g.code as string) ?? "crown-of-fortune",
    name: (g.name as string) ?? (g.title as string) ?? "Crown of Fortune",
    version: (g.version as string) ?? "1.0.0",
    configHash: (g.configHash as string) ?? "",
    reels: (g.reels as number) ?? 5,
    rows: (g.rows as number) ?? 3,
    lines: (g.lines as number) ?? 20,
    symbols: (g.symbols as string[]) ?? [],
    wild: (g.wild as string) ?? "WILD",
    scatter: (g.scatter as string) ?? "SCATTER",
    paytable: (g.paytable as Record<string, Record<string, number>>) ?? {},
    scatterPays: (g.scatterPays as Record<string, number>) ?? (g.scatterPays as Record<string, number>) ?? {},
    freeSpinsAward: (g.freeSpinsAward as Record<string, number>) ?? (g as { freeSpins?: { award?: Record<string, number> } }).freeSpins?.award ?? {},
    freeSpinMultiplier: (g.freeSpinMultiplier as number) ?? (g as { freeSpins?: { multiplier?: number } }).freeSpins?.multiplier ?? 2,
    maxWinCap: (g.maxWinCap as number) ?? 5000,
    targetRtp: (g.targetRtp as number) ?? (g as { declaredRtp?: number }).declaredRtp ?? 0.96,
  };
}

function normalizeSeed(raw: unknown): SeedInfo {
  const s = raw as Record<string, unknown>;
  // Боевой: { serverSeedHash, clientSeed, nextNonce, nonce }
  // Учебный: { serverSeedHash, clientSeed, nonce }
  const nonce = (s.nonce as number) ?? (s.nextNonce as number) ?? 0;
  return {
    serverSeedHash: (s.serverSeedHash as string) ?? "",
    clientSeed: (s.clientSeed as string) ?? "",
    nonce,
  };
}

function normalizeRotate(raw: unknown): RotateResult {
  const r = raw as Record<string, unknown>;
  // Боевой возвращает { revealed: { serverSeed, serverSeedHash, clientSeed, roundsPlayed, noncesUsed }, current: {...}, nextServerSeedHash, nonce }
  // Учебный возвращает { revealed: {...}, nextServerSeedHash, nonce }
  const revealed = (r.revealed as Record<string, unknown>) ?? {};
  const current = (r.current as Record<string, unknown>) ?? {};

  const roundsPlayed =
    (revealed.roundsPlayed as number) ??
    (revealed.noncesUsed as number) ??
    0;

  return {
    revealed: {
      serverSeed: (revealed.serverSeed as string) ?? "",
      serverSeedHash: (revealed.serverSeedHash as string) ?? "",
      clientSeed: (revealed.clientSeed as string) ?? "",
      roundsPlayed,
    },
    nextServerSeedHash: (r.nextServerSeedHash as string) ?? (current.serverSeedHash as string) ?? "",
    nonce: (r.nonce as number) ?? (current.nextNonce as number) ?? (current.nonce as number) ?? 0,
  };
}

export const api = {
  // При первом обращении пробуем получить JWT (для боевого сервера)
  async game(): Promise<GameInfo> {
    await ensureAuth();
    const raw = await request<unknown>("/api/v1/games/crown-of-fortune");
    return normalizeGame(raw);
  },

  async seeds(): Promise<SeedInfo> {
    const token = (await ensureAuth()) ?? getStoredToken();
    if (!token) {
      // Учебный сервер без JWT
      const raw = await request<unknown>("/api/v1/seeds/current");
      return normalizeSeed(raw);
    }
    const raw = await request<unknown>("/api/v1/seeds/current");
    return normalizeSeed(raw);
  },

  async wallet(): Promise<{ balance: number; currency: string }> {
    await ensureAuth();
    const raw = await request<unknown>("/api/v1/wallet");
    const obj = raw as Record<string, unknown>;
    let bal = 0;
    if (typeof obj.balance === "string") bal = Number(obj.balance);
    else if (typeof obj.balance === "number") bal = obj.balance;
    else if (typeof (obj as { amount?: string }).amount === "string") bal = Number((obj as { amount: string }).amount);
    return { balance: bal, currency: (obj.currency as string) ?? "CHIP" };
  },

  async setClientSeed(clientSeed: string): Promise<SeedInfo> {
    await ensureAuth();
    const raw = await request<unknown>("/api/v1/seeds/client", {
      method: "POST",
      body: JSON.stringify({ clientSeed }),
    });
    return normalizeSeed(raw);
  },

  async rotateSeeds(): Promise<RotateResult> {
    await ensureAuth();
    const raw = await request<unknown>("/api/v1/seeds/rotate", { method: "POST" });
    return normalizeRotate(raw);
  },

  async playRound(betPerLine: number): Promise<RoundRecord> {
    await ensureAuth();
    const idempotencyKey = (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`) as string;
    const raw = await request<unknown>("/api/v1/rounds", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ gameCode: "crown-of-fortune", betPerLine, lines: 20 }),
    });
    return normalizeRound(raw);
  },

  async limits(): Promise<{ limits: { kind: string; value: number; effectiveFrom: string; coolingUntil: string | null }[]; counters?: { lossToday:number; wageredToday:number; spinsToday:number; lossThisWeek:number } }> {
    await ensureAuth();
    return request("/api/v1/limits");
  },

  async setLimit(kind: string, value: number): Promise<unknown> {
    await ensureAuth();
    return request("/api/v1/limits", { method: "POST", body: JSON.stringify({ kind, value }) });
  },

  async selfExclude(durationDays: number | null): Promise<unknown> {
    await ensureAuth();
    return request("/api/v1/self-exclusion", { method: "POST", body: JSON.stringify({ durationDays }) });
  },

  // Утилиты для отладки / ручной ротации токена
  clearToken() {
    clearStoredToken();
  },

  async demoLogin(): Promise<{ playerId: string; token: string }> {
    const { body } = await fetchJson<{ playerId: string; token: string }>("/api/v1/auth/demo", { method: "POST" });
    if (body.token) setStoredToken(body.token);
    return { playerId: (body as { playerId: string }).playerId, token: body.token };
  },
};
