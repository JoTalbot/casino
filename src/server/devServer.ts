/**
 * Учебный сервер раундов для прототипа клиента (T-014).
 *
 * ЭТО НЕ БОЕВОЙ БЭКЕНД. Здесь нет БД, аутентификации, кошелька,
 * идемпотентности и лимитов — всё это описано в `docs/API.md` и
 * `db/schema.sql` и будет реализовано на Fastify по ADR-005.
 *
 * Задача этого файла ровно одна: доказать, что клиент не считает
 * математику. Спин играется здесь, на сервере, через тот же
 * `src/engine/round.ts`, который проверен фикстурами Python. Клиент
 * получает готовый результат и только показывает его.
 *
 * Сиды живут в памяти процесса и обнуляются при перезапуске — для
 * прототипа этого достаточно, но в проде пара сидов и nonce обязаны
 * лежать в БД (таблицы seed_pairs / rounds), иначе игрок не сможет
 * проверить историю.
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

import { loadConfig } from "../engine/config.js";
import { playRound } from "../engine/round.js";
import { hashServerSeed } from "../engine/rng.js";
import {
  ActivityCounters,
  LIMIT_KINDS,
  LimitKind,
  PlayerLimit,
  PlayerState,
  SelfExclusion,
  applyLimitChange,
  applySelfExclusion,
  REALITY_CHECK_MS,
  buildRealityCheck,
  canPlaceBet,
  findLimit,
  isExcluded,
  needsRealityCheck,
  recordRound,
} from "../engine/responsible.js";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";

/**
 * Интервал напоминания о времени в игре.
 *
 * Вынесен в env, потому что час ожидания делает проверку невозможной:
 * `REALITY_CHECK_MS=2000` позволяет увидеть напоминание за несколько
 * секунд. В проде значение задаётся регулятором, а не разработчиком.
 */
const REALITY_CHECK_INTERVAL_MS = Number(
  process.env.REALITY_CHECK_MS ?? REALITY_CHECK_MS,
);

const { config: cfg, hash: configHash } = loadConfig("config/game.json");

interface SeedPair {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

function newSeedPair(clientSeed: string): SeedPair {
  const serverSeed = randomBytes(32).toString("hex");
  return {
    serverSeed,
    serverSeedHash: hashServerSeed(serverSeed),
    clientSeed,
    nonce: 0,
  };
}

/**
 * Единственная активная пара сидов процесса.
 *
 * Серверный сид не покидает сервер до ротации — в этом весь смысл
 * commit-reveal: игрок заранее видит хэш и не может подобрать nonce,
 * а сервер не может подменить сид задним числом.
 */
let seeds = newSeedPair("player-default-seed");

/** Демонстрационный баланс в целых кредитах. Деньги никогда не float. */
let balance = 100_000;

/**
 * Состояние ответственной игры (T-015).
 *
 * В проде это строки таблиц `player_limits`, `self_exclusions` и
 * `sessions`; здесь — память процесса, как и всё остальное в этом
 * учебном сервере. Логика решений при этом настоящая: та же
 * `src/engine/responsible.ts`, что покрыта 41 тестом.
 */
let limits: PlayerLimit[] = [];
let selfExclusion: SelfExclusion | null = null;
let counters: ActivityCounters = {
  lossToday: 0,
  lossThisWeek: 0,
  wageredToday: 0,
  spinsToday: 0,
  sessionStartedAt: Date.now(),
  lastRealityCheckAt: null,
};

function playerState(): PlayerState {
  return { limits, selfExclusion, counters };
}

/** Действующие лимиты в виде, удобном клиенту. */
function activeLimits(now: number) {
  return LIMIT_KINDS.flatMap((kind) => {
    const active = findLimit(limits, kind, now);
    const pending = limits.find((l) => l.kind === kind && l.effectiveFrom > now);
    if (!active && !pending) return [];
    return [
      {
        kind,
        value: active?.value ?? null,
        coolingUntil: active?.coolingUntil ?? null,
        pending: pending
          ? { value: pending.value, effectiveFrom: pending.effectiveFrom }
          : null,
      },
    ];
  });
}

function json(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    try {
      // --- описание игры: клиент берёт отсюда символы и таблицу выплат ---
      if (req.method === "GET" && path === "/api/v1/games/crown-of-fortune") {
        json(res, 200, {
          code: "crown-of-fortune",
          name: cfg.name,
          version: cfg.version,
          configHash,
          reels: 5,
          rows: 3,
          lines: cfg.lines,
          symbols: cfg.symbols,
          wild: cfg.wild,
          scatter: cfg.scatter,
          paytable: cfg.paytable,
          scatterPays: cfg.scatterPays,
          freeSpinsAward: cfg.freeSpinsAward,
          freeSpinMultiplier: cfg.freeSpinMultiplier,
          maxWinCap: cfg.maxWinCap,
          targetRtp: cfg.targetRtp,
        });
        return;
      }

      // --- текущая пара сидов: серверный сид НЕ отдаётся, только хэш ---
      if (req.method === "GET" && path === "/api/v1/seeds/current") {
        json(res, 200, {
          serverSeedHash: seeds.serverSeedHash,
          clientSeed: seeds.clientSeed,
          nonce: seeds.nonce,
        });
        return;
      }

      // --- смена клиентского сида: сбрасывает nonce ---
      if (req.method === "POST" && path === "/api/v1/seeds/client") {
        const body = (await readBody(req)) as { clientSeed?: unknown };
        const clientSeed = String(body.clientSeed ?? "");
        if (!clientSeed || clientSeed.length > 256 || clientSeed.includes(":")) {
          json(res, 400, {
            error: "clientSeed: 1..256 символов, двоеточие запрещено",
          });
          return;
        }
        seeds = { ...seeds, clientSeed, nonce: 0 };
        json(res, 200, {
          serverSeedHash: seeds.serverSeedHash,
          clientSeed: seeds.clientSeed,
          nonce: seeds.nonce,
        });
        return;
      }

      // --- ротация: серверный сид раскрывается, выдаётся новый коммитмент ---
      if (req.method === "POST" && path === "/api/v1/seeds/rotate") {
        const revealed = seeds;
        seeds = newSeedPair(revealed.clientSeed);
        json(res, 200, {
          revealed: {
            serverSeed: revealed.serverSeed,
            serverSeedHash: revealed.serverSeedHash,
            clientSeed: revealed.clientSeed,
            roundsPlayed: revealed.nonce,
          },
          nextServerSeedHash: seeds.serverSeedHash,
          nonce: seeds.nonce,
        });
        return;
      }

      // --- игра раунда ---
      if (req.method === "POST" && path === "/api/v1/rounds") {
        const body = (await readBody(req)) as { betPerLine?: unknown };
        const betPerLine = Number(body.betPerLine ?? 1);
        if (!Number.isInteger(betPerLine) || betPerLine < 1 || betPerLine > 100) {
          json(res, 400, { error: "betPerLine: целое от 1 до 100" });
          return;
        }

        const totalBet = betPerLine * cfg.lines;

        // Ответственная игра проверяется ДО списания: лимит,
        // проверенный после, уже нарушен.
        const now = Date.now();
        const verdict = canPlaceBet(playerState(), totalBet, now);
        if (!verdict.allowed) {
          json(res, verdict.code === "SELF_EXCLUDED" ? 403 : 409, {
            error: verdict.message,
            code: verdict.code,
            limit: verdict.limit ?? null,
            retryAt: verdict.retryAt ?? null,
          });
          return;
        }

        if (totalBet > balance) {
          json(res, 402, { error: "Недостаточно средств", balance });
          return;
        }

        // Ставка списывается ДО спина: если процесс упадёт между
        // списанием и начислением, игрок недосчитается выигрыша, а не
        // сыграет бесплатно. В проде это одна транзакция с ledger.
        balance -= totalBet;

        const nonce = seeds.nonce;
        seeds = { ...seeds, nonce: nonce + 1 };

        const round = playRound(cfg, seeds.serverSeed, seeds.clientSeed, nonce, {
          betPerLine,
        });

        balance += round.totalWin;
        counters = recordRound(counters, totalBet, round.totalWin);

        // Напоминание о времени в игре отдаётся вместе с раундом:
        // отдельный опрос клиентом означал бы, что его можно не делать.
        let realityCheck = null;
        if (needsRealityCheck(counters, now, REALITY_CHECK_INTERVAL_MS)) {
          realityCheck = buildRealityCheck(counters, now);
          counters = { ...counters, lastRealityCheckAt: now };
        }

        json(res, 200, { ...round, configHash, balance, realityCheck });
        return;
      }

      // --- ответственная игра: текущее состояние ---
      if (req.method === "GET" && path === "/api/v1/limits") {
        const now = Date.now();
        json(res, 200, {
          limits: activeLimits(now),
          selfExclusion: isExcluded(selfExclusion, now) ? selfExclusion : null,
          counters,
        });
        return;
      }

      // --- установка или изменение лимита ---
      if (req.method === "POST" && path === "/api/v1/limits") {
        const body = (await readBody(req)) as { kind?: unknown; value?: unknown };
        const kind = String(body.kind ?? "") as LimitKind;
        const value = Number(body.value);

        if (!LIMIT_KINDS.includes(kind)) {
          json(res, 400, {
            error: `kind: одно из ${LIMIT_KINDS.join(", ")}`,
          });
          return;
        }
        if (!Number.isInteger(value) || value <= 0) {
          json(res, 400, { error: "value: целое положительное число" });
          return;
        }

        const now = Date.now();
        const current = findLimit(limits, kind, now);
        const applied = applyLimitChange(current, { kind, value }, now);

        // Ужесточение заменяет запись, ослабление добавляется рядом:
        // старый лимит обязан действовать весь период охлаждения.
        limits = applied.immediate
          ? [...limits.filter((l) => l.kind !== kind), applied.limit]
          : [...limits.filter((l) => l.kind !== kind || l.effectiveFrom <= now), applied.limit];

        json(res, 200, {
          applied: applied.limit,
          tightening: applied.tightening,
          immediate: applied.immediate,
          message: applied.message,
          limits: activeLimits(now),
        });
        return;
      }

      // --- самоисключение ---
      if (req.method === "POST" && path === "/api/v1/self-exclusion") {
        const body = (await readBody(req)) as { durationDays?: unknown };
        const raw = body.durationDays;
        const durationDays = raw === null || raw === undefined ? null : Number(raw);

        if (
          durationDays !== null &&
          (!Number.isInteger(durationDays) || durationDays <= 0)
        ) {
          json(res, 400, {
            error: "durationDays: целое положительное число или null (бессрочно)",
          });
          return;
        }

        const now = Date.now();
        const before = selfExclusion;
        selfExclusion = applySelfExclusion(selfExclusion, durationDays, now);

        json(res, 200, {
          selfExclusion,
          // Досрочное снятие невозможно: если запрос пытался сократить
          // срок, вернётся прежнее значение.
          changed: before?.endsAt !== selfExclusion.endsAt,
          message:
            selfExclusion.endsAt === null
              ? "Самоисключение установлено бессрочно."
              : "Самоисключение действует. Досрочное снятие невозможно.",
        });
        return;
      }

      if (req.method === "GET" && path === "/api/v1/wallet") {
        json(res, 200, { balance, currency: "FUN" });
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (error) {
      json(res, 500, { error: (error as Error).message });
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`[dev-server] раунды на http://${HOST}:${PORT}/api/v1`);
  console.log(`[dev-server] игра: ${cfg.name} ${cfg.version}, configHash ${configHash}`);
  console.log(`[dev-server] коммитмент: ${seeds.serverSeedHash}`);
});
