/**
 * HTTP-приложение боевого API. Секреты и соединение передаются извне, чтобы
 * приложение можно было проверять через Fastify.inject без PostgreSQL.
 *
 * Реализует OpenAPI + совместимость с существующим клиентом Pixi.
 * Только виртуальные CHIP, без реальных платежей.
 */
import fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadConfig } from "../engine/config.js";
import { playRound } from "../engine/round.js";
import type { Database } from "./db.js";
import { RoundServiceError, settleRound } from "./roundService.js";
import { createGuestPlayer } from "./auth.js";
import {
  SeedServiceError,
  ensureActiveSeed,
  listSeedHistory,
  rotateSeedPair,
  setClientSeed,
} from "./seeds.js";
import { getRoundFull, listRounds } from "./history.js";
import { getPlayerState, listLimits, setLimit as rgSetLimit, setSelfExclusion } from "./responsibleService.js";
import { LIMIT_KINDS, type LimitKind, needsRealityCheck as rgNeedsCheck, buildRealityCheck as rgBuildCheck, REALITY_CHECK_MS } from "../engine/responsible.js";
import { checkRtp } from "./monitoring.js";
import { loadGames } from "./gameRegistry.js";
import { registerAdminRoutes } from "./admin.js";
import { globalRateLimiter } from "./rateLimit.js";
import { claimDailyBonus } from "./bonus.js";
import { getLeaderboard } from "./leaderboard.js";
import { exportPlayerData } from "./gdpr.js";
import { listTournaments, getTournamentLeaderboard, updateTournamentScores } from "./tournaments.js";
import { createReferral, getReferrals, getReferralProgress, getReferralLeaderboard } from "./referrals.js";
import { subscribePush, unsubscribePush, getSubscriptions } from "./push.js";
import { checkAndUnlockAchievements, listAchievements } from "./achievements.js";
import { canChat, postMessage, listMessages, deleteMessage } from "./chat.js";
import { TelegramAuthError, linkTelegramPlayer, replyForUpdate, sendBotReply, verifyInitData } from "./telegram.js";
import { createPromo, listPromos, redeemPromo } from "./promo.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/i, "ожидается SHA-256 в hex");
const clientSeedSchema = z.string().min(1).max(256).refine((s) => !s.includes(":"), "двоеточие запрещено");

// Поддержка двух игр для T-029
const gameCodes = ["crown-of-fortune", "crown-of-fortune-ii"] as const;
type GameCode = (typeof gameCodes)[number];

const roundBody = z.object({
  gameCode: z.enum(gameCodes).optional().default("crown-of-fortune"),
  betPerLine: z.number().int().positive().max(100),
  lines: z.number().int().positive().optional().default(20),
  // Бонус-игра «Сундуки короны» (T-195): форма серии фриспинов.
  // Матожидание у тиров одинаковое, отличается волатильность.
  bonusTier: z.union([z.literal(1), z.literal(5), z.literal(25)]).optional().default(1),
});

const verifyBody = z.object({
  serverSeed: sha256,
  clientSeed: z.string().min(1).max(256).refine((seed) => !seed.includes(":")),
  nonce: z.number().int().nonnegative(),
  // Без тира сторонний верификатор не воспроизведёт серию фриспинов.
  bonusTier: z.union([z.literal(1), z.literal(5), z.literal(25)]).optional().default(1),
  gameCode: z.enum(gameCodes).optional(),
  configHash: sha256.optional(),
});

export interface AppOptions {
  jwtSecret: string;
  database?: Database;
}

/**
 * Предохранитель денежного режима (T-214).
 *
 * Проект работает на виртуальных фишках. Реальные деньги требуют лицензии
 * PlayCity, сертифицированного софта, KYC 21+ и AML (AGENTS.md §11,
 * docs/LICENSING.md). Проверка стоит на старте приложения, чтобы «включить
 * деньги одной переменной окружения» было нельзя: без явного номера
 * лицензии сервер просто не поднимется в денежном режиме.
 */
export function assertMoneyModeAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const moneyMode = (env.MONEY_MODE ?? "").toLowerCase();
  if (moneyMode !== "real") return;

  const license = (env.GAMBLING_LICENSE_ID ?? "").trim();
  if (!license) {
    throw new Error(
      "MONEY_MODE=real требует GAMBLING_LICENSE_ID — номера действующей лицензии. " +
        "Без лицензии приём реальных ставок запрещён законом и протоколом проекта " +
        "(AGENTS.md §11, docs/LICENSING.md).",
    );
  }
  throw new Error(
    `Денежный режим не реализован. Указана лицензия ${license}, но платёжный контур, ` +
      "KYC и сертификация RNG отсутствуют. См. docs/LICENSING.md — там перечислено, " +
      "что нужно закрыть до первой реальной ставки.",
  );
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  assertMoneyModeAllowed();

  const app = fastify({ logger: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: options.jwtSecret });

  /**
   * Сроки жизни токенов (T-207).
   *
   * Раньше токены не протухали вообще: утёкший однажды работал вечно.
   * Сроки разные не от вкуса, а из-за природы аккаунтов:
   *
   * - Вход из Telegram привязан к telegram_id. Протух токен — клиент молча
   *   получит новый по подписи и вернётся в ТОТ ЖЕ аккаунт, поэтому здесь
   *   можно держать срок коротким.
   * - У гостя токен и ЕСТЬ аккаунт: других признаков у него нет. Короткий
   *   срок означал бы потерю баланса у человека, который просто не заходил
   *   пару недель. Поэтому у гостей срок длинный, и это осознанный
   *   компромисс, а не недосмотр.
   */
  const TOKEN_TTL_TELEGRAM = "7d";
  const TOKEN_TTL_GUEST = "90d";
  const gamesRegistry = loadGames();
  const primary = gamesRegistry.get("crown-of-fortune") ?? { code: "crown-of-fortune", loaded: loadConfig() };
  const loaded = primary.loaded;

  function getGameEntry(code: string) {
    return gamesRegistry.get(code) ?? (code === "crown-of-fortune" ? primary : undefined);
  }

  // Rate limiter для auth/demo (T-045) — 5 req/s per IP
  const authLimiter = new Map<string, number[]>();

  // T-186: JSON.stringify не умеет BigInt и падает с TypeError, а Fastify
  // превращает это в 500. Денежные величины в проекте — BigInt (ADR: деньги
  // только целыми), поэтому отдаём их строками, как уже делает /wallet.
  // Без этого 500 отдавали /admin/grant, /admin/rtp и /monitoring/rtp.
  app.setReplySerializer((payload) =>
    JSON.stringify(payload, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
  );

  // T-189: пустое тело при content-type: application/json — норма для запросов
  // вида POST /auth/demo, у которых нет параметров. Штатный парсер Fastify
  // отвечает на них ошибкой, поэтому пустое тело трактуем как {}.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const raw = typeof body === "string" ? body.trim() : "";
    if (raw === "") return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      const error = new Error("Тело запроса не является корректным JSON.") as Error & { statusCode: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ code: "VALIDATION_FAILED", message: error.issues });
    }
    // T-189: клиентские ошибки нельзя превращать в 500 — иначе браузер видит
    // «внутреннюю ошибку сервера» там, где не так составлен запрос, и
    // отладка уходит в лог сервера вместо ответа. Именно на этом молча
    // ложился демо-вход: 400 от парсера тела отдавался как 500.
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      request.log.info({ err: error }, "клиентская ошибка запроса");
      return reply.status(status).send({
        code: (error as { code?: string }).code ?? "BAD_REQUEST",
        message: (error as Error).message,
      });
    }
    app.log.error(error);
    return reply.status(500).send({ code: "INTERNAL_ERROR", message: "Внутренняя ошибка сервера." });
  });

  app.get("/health", async () => ({ status: "ok" }));

  // --- Публичные: verify ---
  app.post("/api/v1/verify", async (request) => {
    const body = verifyBody.parse(request.body);
    const gameEntry = body.gameCode ? getGameEntry(body.gameCode) : undefined;
    const cfgEntry = gameEntry ?? primary;
    if (body.configHash && body.configHash !== cfgEntry.loaded.hash) {
      return { valid: false, code: "CONFIG_HASH_MISMATCH", configHash: cfgEntry.loaded.hash };
    }
    const round = playRound(cfgEntry.loaded.config, body.serverSeed, body.clientSeed, body.nonce, {
      bonusTier: body.bonusTier,
    });
    return { valid: true, configHash: cfgEntry.loaded.hash, round };
  });

  // --- Вход из Telegram Mini App (T-197) ---
  //
  // Клиент присылает initData как есть; сервер проверяет подпись ключом
  // бота и только после этого выдаёт JWT. Токен бота живёт в окружении —
  // в репозитории его нет и быть не должно.
  app.post("/api/v1/auth/telegram", async (request, reply) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return reply.status(503).send({ code: "TELEGRAM_NOT_CONFIGURED", message: "Бот не настроен." });
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });

    const body = (request.body ?? {}) as { initData?: string };
    try {
      const user = verifyInitData(body.initData ?? "", botToken);
      const linked = await linkTelegramPlayer(options.database, user);
      const seed = await ensureActiveSeed(options.database, linked.playerId);
      const wallet = await options.database.query<{ balance: string }>(
        "SELECT balance FROM wallets WHERE player_id = $1 AND currency_code = 'CHIP'",
        [linked.playerId],
      );
      const token = (app as unknown as { jwt: { sign: (p: object, o?: object) => string } }).jwt.sign(
        { sub: linked.playerId, username: linked.username },
        { expiresIn: TOKEN_TTL_TELEGRAM },
      );
      return reply.status(linked.created ? 201 : 200).send({
        playerId: linked.playerId,
        username: linked.username,
        telegramId: user.id,
        created: linked.created,
        token,
        wallet: { balance: wallet.rows[0]?.balance ?? "0", currency: "CHIP" },
        serverSeedHash: seed.server_seed_hash,
        clientSeed: seed.client_seed,
        nonce: Number(seed.next_nonce),
      });
    } catch (error) {
      if (error instanceof TelegramAuthError) {
        request.log.info({ err: error }, "отклонён вход из Telegram");
        return reply.status(401).send({ code: error.code, message: error.message });
      }
      request.log.error(error);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  // --- Вебхук бота Telegram (T-197) ---
  //
  // Секретный заголовок обязателен: адрес вебхука рано или поздно утекает
  // в логи прокси, и без проверки кто угодно слал бы боту фальшивые
  // обновления. Отвечаем 200 всегда, иначе Telegram будет ретраить.
  app.post("/api/v1/telegram/webhook", async (request, reply) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!botToken) return reply.status(503).send({ ok: false });
    if (secret && request.headers["x-telegram-bot-api-secret-token"] !== secret) {
      request.log.warn("вебхук с неверным секретом");
      return reply.status(401).send({ ok: false });
    }

    const webAppUrl = process.env.TELEGRAM_WEBAPP_URL ?? "";
    try {
      const answer = replyForUpdate(request.body as never, webAppUrl);
      if (answer) await sendBotReply(botToken, answer);
    } catch (error) {
      request.log.error(error);
    }
    return { ok: true };
  });

  // --- Демо-вход: создаёт гостя, кошелёк CHIP 100k, seed pair, возвращает JWT ---
  app.post("/api/v1/auth/demo", async (request, reply) => {
    // T-045: простой rate limit по IP для demo-входа — 5 req/s
    const ip = (request.ip ?? request.headers["x-forwarded-for"] ?? "unknown") as string;
    const now = Date.now();
    const arr = authLimiter.get(ip) ?? [];
    const recent = arr.filter((t) => t > now - 1000);
    if (recent.length >= 5) {
      return reply.status(429).header("Retry-After", "1").send({ code: "RATE_LIMITED", message: "Слишком часто для demo входа" });
    }
    recent.push(now);
    authLimiter.set(ip, recent);

    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    try {
      const guest = await createGuestPlayer(options.database, loaded);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const token = (app as any).jwt.sign(
        { sub: guest.playerId, username: guest.username },
        { expiresIn: TOKEN_TTL_GUEST },
      );
      return reply.status(201).send({
        playerId: guest.playerId,
        username: guest.username,
        token,
        wallet: { balance: guest.walletBalance.toString(), currency: "CHIP" },
        seeds: {
          seedPairId: guest.seedPairId,
          serverSeedHash: guest.serverSeedHash,
          clientSeed: guest.clientSeed,
          nonce: 0,
        },
        configHash: loaded.hash,
      });
    } catch (e) {
      request.log.error(e);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  // Алиас для старого клиента
  app.post("/api/v1/auth/guest", async (request, reply) => {
    // прокси на demo
    // @ts-ignore inject-like internal call: reuse logic
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/demo" });
    return reply.status(res.statusCode).send(res.json());
  });

  // --- Игры (T-029 — вторая игра на том же движке) ---
  app.get("/api/v1/games", async () => {
    const list = Array.from(gamesRegistry.values()).map((entry) => ({
      code: entry.code,
      name: entry.loaded.config.name,
      version: entry.loaded.config.version,
      configHash: entry.loaded.hash,
      lines: entry.loaded.config.lines,
      reels: 5,
      rows: 3,
      enabled: true,
    }));
    if (list.length === 0) {
      list.push({
        code: "crown-of-fortune",
        name: loaded.config.name,
        version: loaded.config.version,
        configHash: loaded.hash,
        lines: loaded.config.lines,
        reels: 5,
        rows: 3,
        enabled: true,
      });
    }
    return { games: list };
  });

  app.get("/api/v1/games/:code", async (request, reply) => {
    const { code } = request.params as { code: string };
    const entry = getGameEntry(code);
    if (!entry) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Игра не найдена" });
    }
    const cfg = entry.loaded.config;
    const hash = entry.loaded.hash;
    return {
      code: entry.code,
      title: cfg.name,
      name: cfg.name,
      version: cfg.version,
      configHash: hash,
      reels: 5,
      rows: 3,
      lines: cfg.lines,
      symbols: cfg.symbols,
      wild: cfg.wild,
      scatter: cfg.scatter,
      paytable: cfg.paytable,
      scatterPays: cfg.scatterPays,
      freeSpins: {
        trigger: cfg.scatterTrigger,
        award: cfg.freeSpinsAward,
        multiplier: cfg.freeSpinMultiplier,
        retriggerEnabled: cfg.retriggerEnabled,
      },
      freeSpinsAward: cfg.freeSpinsAward,
      freeSpinMultiplier: cfg.freeSpinMultiplier,
      wildReels: cfg.wildReels,
      maxWinCap: cfg.maxWinCap,
      declaredRtp: cfg.targetRtp,
      targetRtp: cfg.targetRtp,
      volatilityIndex: 8.06,
      hitFrequency: 0.2585,
      betLevels: [10, 20, 50, 100, 200, 500, 1000],
      currency: "CHIP",
      enabled: true,
    };
  });

  // Алиас для старого пути devServer: GET /api/v1/games/crown-of-fortune
  // Fastify уже покрывает :code, но добавляем явный для совместимости с тестами прокси
  app.get("/api/v1/games/crown-of-fortune", async () => {
    return {
      code: "crown-of-fortune",
      name: loaded.config.name,
      version: loaded.config.version,
      configHash: loaded.hash,
      reels: 5,
      rows: 3,
      lines: loaded.config.lines,
      symbols: loaded.config.symbols,
      wild: loaded.config.wild,
      scatter: loaded.config.scatter,
      paytable: loaded.config.paytable,
      scatterPays: loaded.config.scatterPays,
      freeSpinsAward: loaded.config.freeSpinsAward,
      freeSpinMultiplier: loaded.config.freeSpinMultiplier,
      maxWinCap: loaded.config.maxWinCap,
      targetRtp: loaded.config.targetRtp,
    };
  });

  // --- Seeds (требуют JWT) ---
  app.get("/api/v1/seeds/current", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    const seed = await ensureActiveSeed(options.database, playerId);
    return {
      seedPairId: seed.id,
      serverSeedHash: seed.server_seed_hash,
      clientSeed: seed.client_seed,
      nextNonce: Number(seed.next_nonce),
      nonce: Number(seed.next_nonce),
      createdAt: seed.created_at,
    };
  });

  app.post("/api/v1/seeds/client", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    let body: { clientSeed?: string };
    try {
      body = clientSeedSchema ? { clientSeed: (request.body as { clientSeed?: string })?.clientSeed } : (request.body as { clientSeed?: string });
      clientSeedSchema.parse(body.clientSeed);
    } catch (e) {
      if (e instanceof z.ZodError) return reply.status(400).send({ code: "VALIDATION_FAILED", message: e.issues });
      throw e;
    }
    const playerId = (request.user as { sub: string }).sub;
    try {
      const updated = await setClientSeed(options.database, playerId, (request.body as { clientSeed: string }).clientSeed);
      return {
        seedPairId: updated.id,
        serverSeedHash: updated.server_seed_hash,
        clientSeed: updated.client_seed,
        nextNonce: Number(updated.next_nonce),
        nonce: Number(updated.next_nonce),
      };
    } catch (error) {
      if (error instanceof SeedServiceError) return reply.status(400).send({ code: error.code, message: error.message });
      throw error;
    }
  });

  app.post("/api/v1/seeds/rotate", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    try {
      const { revealed, current } = await rotateSeedPair(options.database, playerId);
      return {
        revealed: {
          seedPairId: revealed.id,
          serverSeed: revealed.server_seed,
          serverSeedHash: revealed.server_seed_hash,
          clientSeed: revealed.client_seed,
          roundsPlayed: Number(revealed.next_nonce),
          noncesUsed: Number(revealed.next_nonce),
          revealedAt: revealed.revealed_at,
        },
        current: {
          seedPairId: current.id,
          serverSeedHash: current.server_seed_hash,
          clientSeed: current.client_seed,
          nextNonce: Number(current.next_nonce),
          nonce: Number(current.next_nonce),
          createdAt: current.created_at,
        },
        // legacy поля для devServer-клиента
        nextServerSeedHash: current.server_seed_hash,
        nonce: Number(current.next_nonce),
      };
    } catch (error) {
      if (error instanceof SeedServiceError) return reply.status(404).send({ code: error.code, message: error.message });
      throw error;
    }
  });

  app.get("/api/v1/seeds/history", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    const { limit } = request.query as { limit?: string };
    const lim = limit ? parseInt(limit, 10) : 20;
    const rows = await listSeedHistory(options.database, playerId, lim);
    return {
      seedPairs: rows.map((r) => ({
        seedPairId: r.id,
        serverSeed: r.server_seed,
        serverSeedHash: r.server_seed_hash,
        clientSeed: r.client_seed,
        noncesUsed: Number(r.next_nonce),
        revealedAt: r.revealed_at,
        createdAt: r.created_at,
      })),
      nextCursor: null,
    };
  });

  // --- Rounds ---
  app.post("/api/v1/rounds", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });

    // Idempotency-Key теперь опционален для совместимости: если нет — генерируем
    let idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 128) {
      idempotencyKey = randomUUID();
    }

    let parsed: { gameCode: string; betPerLine: number; lines: number; bonusTier: number };
    try {
      // Поддержка legacy тела { betPerLine } без gameCode/lines
      const raw = request.body as Record<string, unknown>;
      if (raw && typeof raw.betPerLine === "number" && !raw.gameCode) {
        parsed = {
          gameCode: "crown-of-fortune",
          betPerLine: raw.betPerLine as number,
          lines: (raw.lines as number) ?? 20,
          // Старое тело бонуса не знает — обычная серия фриспинов
          bonusTier: 1,
        };
      } else {
        parsed = roundBody.parse(request.body);
      }
    } catch (e) {
      if (e instanceof z.ZodError) return reply.status(400).send({ code: "VALIDATION_FAILED", message: e.issues });
      throw e;
    }

    const playerId = (request.user as { sub: string }).sub;
    try {
      // Rate limiting 10 req/s (T-038)
      const rl = globalRateLimiter.check(playerId);
      if (!rl.allowed) {
        return reply
          .status(429)
          .header("Retry-After", Math.ceil((rl.retryAfterMs ?? 1000) / 1000).toString())
          .send({ code: "RATE_LIMITED", message: "Слишком часто, попробуйте позже", retryAfterMs: rl.retryAfterMs });
      }

      const gameEntry = getGameEntry(parsed.gameCode);
      if (!gameEntry) return reply.status(404).send({ code: "NOT_FOUND", message: "Игра не найдена" });
      const cfg = gameEntry.loaded;
      const settled = await settleRound(options.database as Database, cfg, playerId, idempotencyKey as string, parsed.betPerLine, parsed.lines, parsed.gameCode, parsed.bonusTier);

      // Reality check (T-039) — проверяем после раунда, отдаём вместе с ответом
      let realityCheck: { message: string; minutesPlayed: number } | null = null;
      try {
        const state = await getPlayerState(options.database as Database, playerId);
        if (rgNeedsCheck(state.counters, Date.now(), REALITY_CHECK_MS)) {
          const rc = rgBuildCheck(state.counters, Date.now());
          realityCheck = { message: rc.message, minutesPlayed: rc.minutesPlayed };
          // Обновляем last reality check в сессии (best effort)
          try {
            await (options.database as Database).query(
              `UPDATE sessions SET reality_check_at = now() WHERE player_id = $1 AND ended_at IS NULL`,
              [playerId],
            );
          } catch {
            // ignore
          }
        }
      } catch {
        // не критично
      }

      // Турниры — обновляем счётчики (best effort, не блокируем ответ)
      try {
        await updateTournamentScores(options.database as Database, playerId, Number(settled.record.totalWin), Number(settled.record.totalBet));
      } catch {
        // ignore
      }

      // Ачивки (T-060) — best effort
      try {
        const multiple = settled.record.totalBet > 0 ? settled.record.totalWin / settled.record.totalBet : 0;
        if (settled.record.totalWin > 0) {
          await checkAndUnlockAchievements(options.database as Database, playerId, { type: "win", totalWin: Number(settled.record.totalWin), totalBet: Number(settled.record.totalBet), multiple }, request.log);
        }
        await checkAndUnlockAchievements(options.database as Database, playerId, { type: "spin" }, request.log);
      } catch {
        // ignore
      }

      // Ответ в формате OpenAPI, но с дополнительными legacy полями для client/src/api.ts
      const common: Record<string, unknown> = {
        roundId: settled.roundId,
        gameCode: parsed.gameCode,
        configHash: cfg.hash,
        status: "settled" as const,
        bet: { perLine: parsed.betPerLine, lines: parsed.lines, total: Number(settled.record.totalBet) },
        fairness: {
          serverSeedHash: settled.record.serverSeedHash,
          clientSeed: settled.record.clientSeed,
          nonce: settled.record.nonce,
          drawCount: settled.record.drawCount,
          // Без тира раунд не переиграть офлайн: серия фриспинов зависит от него.
          bonusTier: settled.record.bonusTier,
        },
        bonus: {
          tier: settled.record.bonusTier,
          multiplier: settled.record.bonusMultiplier,
        },
        spins: settled.record.spins.map((s) => ({
          index: s.index,
          free: s.free,
          reelStops: s.reelStops,
          grid: s.grid,
          win: Number(s.win),
          multiplier: s.multiplier,
          scatterCount: s.scatterCount,
          triggeredFreeSpins: s.triggeredFreeSpins,
          winDetails: s.winDetails,
        })),
        totalWin: Number(settled.record.totalWin),
        balance: { amount: settled.balance.toString(), currency: "CHIP" as const },
        serverSeedHash: settled.record.serverSeedHash,
        clientSeed: settled.record.clientSeed,
        nonce: settled.record.nonce,
        betPerLine: parsed.betPerLine,
        lines: parsed.lines,
        totalBet: Number(settled.record.totalBet),
        capped: settled.record.capped,
        drawCount: settled.record.drawCount,
        configHashLegacy: cfg.hash,
        balanceLegacy: Number(settled.balance),
        realityCheck,
      };

      if (settled.idempotent) {
        return reply.status(200).send({ ...common, idempotent: true });
      }
      return reply.status(201).send(common);
    } catch (error) {
      if (error instanceof RoundServiceError) return reply.status(409).send({ code: error.code, message: error.message });
      throw error;
    }
  });

  app.get("/api/v1/rounds", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    const { limit, offset, gameCode } = request.query as { limit?: string; offset?: string; gameCode?: string };
    const rows = await listRounds(options.database, playerId, limit ? parseInt(limit, 10) : 20, offset ? parseInt(offset, 10) : 0, gameCode);
    return {
      rounds: rows.map((r) => ({
        roundId: r.id,
        gameCode: r.game_code,
        totalBet: Number(r.total_bet),
        totalWin: Number(r.total_win),
        nonce: Number(r.nonce),
        serverSeedHash: r.config_hash,
        configHash: r.config_hash,
        startedAt: r.started_at,
        settledAt: r.settled_at,
        status: r.status,
        spinsCount: r.spins_count ? Number(r.spins_count) : undefined,
      })),
      nextCursor: null,
    };
  });

  app.get("/api/v1/rounds/:roundId", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    const { roundId } = request.params as { roundId: string };
    const full = await getRoundFull(options.database, playerId, roundId);
    if (!full) return reply.status(404).send({ code: "NOT_FOUND", message: "Раунд не найден" });

    // Преобразуем grid из плоского массива в 2D для OpenAPI
    const spins = full.spins.map((s) => {
      const flat = s.grid as unknown as string[];
      // DB хранит grid как TEXT[] flat: 15 элементов (5x3) в порядке reel-major? Проверим roundService: spin.grid.flat()
      // spin.grid оригинал grid[reel][row]? В round.ts grid это [reel][row]. flat() даёт [reel0 row0,row1,row2, reel1...]
      // Восстанавливаем как [reel][row]
      const reels = 5;
      const rows = 3;
      let grid2d: string[][] = [];
      if (flat.length === reels * rows) {
        for (let reel = 0; reel < reels; reel++) {
          grid2d.push(flat.slice(reel * rows, reel * rows + rows));
        }
      } else {
        // уже 2D
        // @ts-ignore
        grid2d = flat as unknown as string[][];
      }
      return {
        index: s.spin_index,
        free: s.is_free,
        reelStops: s.reel_stops,
        grid: grid2d,
        win: Number(s.win),
        multiplier: s.multiplier,
        scatterCount: s.scatter_count,
        triggeredFreeSpins: s.triggered_free,
        winDetails: s.win_details,
      };
    });

    return {
      roundId: full.id,
      gameCode: full.game_code,
      configHash: full.config_hash,
      status: full.status,
      bet: {
        perLine: Number(full.bet_per_line),
        lines: full.lines,
        total: Number(full.total_bet),
      },
      fairness: {
        seedPairId: undefined,
        serverSeedHash: full.server_seed_hash,
        serverSeed: full.server_seed ?? undefined,
        clientSeed: full.client_seed,
        nonce: Number(full.nonce),
        drawCount: spins.reduce((acc, cur) => acc, 0), // drawCount не хранится отдельно в раунде, но есть в record; здесь 0 для простоты
      },
      spins,
      totalWin: Number(full.total_win),
      balance: { currency: "CHIP", exponent: 0, balance: 0, amount: "0" }, // баланс исторически не хранится в round, его можно достать из ledger но для простоты
      settledAt: full.settled_at,
      startedAt: full.started_at,
    };
  });

  // --- Кошелёк ---
  app.get("/api/v1/wallet", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    const playerId = (request.user as { sub: string }).sub;
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const result = await options.database.query<{ balance: string; currency_code: string }>(
      "SELECT balance, currency_code FROM wallets WHERE player_id = $1 AND currency_code = 'CHIP'",
      [playerId],
    );
    if (!result.rows[0]) return reply.status(404).send({ code: "WALLET_NOT_FOUND" });
    return { balance: result.rows[0].balance, currency: result.rows[0].currency_code, amount: result.rows[0].balance };
  });

  // Транзакции кошелька (расширение, не блокирующее T-026)
  app.get("/api/v1/wallet/transactions", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    const { limit } = request.query as { limit?: string };
    const lim = Math.min(Math.max(limit ? parseInt(limit, 10) : 50, 1), 100);
    const res = await options.database.query<{
      id: string;
      amount: string;
      balance_after: string;
      tx_type: string;
      round_id: string | null;
      created_at: string;
    }>(
      `SELECT l.id, l.amount, l.balance_after, l.tx_type, l.round_id, l.created_at
       FROM ledger_entries l
       JOIN wallets w ON w.id = l.wallet_id
       WHERE w.player_id = $1
       ORDER BY l.created_at DESC
       LIMIT $2`,
      [playerId, lim],
    );
    return {
      transactions: res.rows.map((r) => ({
        id: r.id,
        amount: Number(r.amount),
        balanceAfter: Number(r.balance_after),
        type: r.tx_type,
        roundId: r.round_id,
        createdAt: r.created_at,
      })),
    };
  });

  // --- Ответственная игра (T-024, T-027) ---
  app.get("/api/v1/limits", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    try {
      const state = await getPlayerState(options.database, playerId);
      const rows = await listLimits(options.database, playerId);
      return {
        limits: rows.map((r) => ({
          kind: r.kind,
          value: Number(r.value),
          effectiveFrom: r.effective_from,
          coolingUntil: r.cooling_until,
        })),
        selfExclusion: state.selfExclusion,
        counters: state.counters,
      };
    } catch (e) {
      request.log.error(e);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  app.post("/api/v1/limits", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    const body = request.body as { kind?: string; value?: number };
    if (!body.kind || !LIMIT_KINDS.includes(body.kind as LimitKind)) {
      return reply.status(400).send({ code: "VALIDATION_FAILED", message: `kind must be one of ${LIMIT_KINDS.join(",")}` });
    }
    if (!Number.isInteger(body.value) || (body.value as number) <= 0) {
      return reply.status(400).send({ code: "VALIDATION_FAILED", message: "value must be positive integer" });
    }
    try {
      const applied = await rgSetLimit(options.database, playerId, body.kind as LimitKind, body.value as number);
      return {
        kind: applied.limit.kind,
        value: applied.limit.value,
        effectiveFrom: new Date(applied.limit.effectiveFrom).toISOString(),
        coolingUntil: applied.limit.coolingUntil ? new Date(applied.limit.coolingUntil).toISOString() : null,
        tightening: applied.tightening,
        immediate: applied.immediate,
        message: applied.message,
      };
    } catch (e) {
      const err = e as Error & { code?: string; retryAt?: string };
      if (err.code === "COOLING") {
        return reply.status(403).send({ code: "COOLING_PERIOD", message: err.message, retryAt: err.retryAt });
      }
      request.log.error(e);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  app.post("/api/v1/self-exclusion", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    const body = request.body as { durationDays?: number | null; reason?: string };
    let durationDays: number | null = null;
    if (body.durationDays !== undefined && body.durationDays !== null) {
      if (!Number.isInteger(body.durationDays) || body.durationDays <= 0) {
        return reply.status(400).send({ code: "VALIDATION_FAILED", message: "durationDays must be positive integer or null" });
      }
      durationDays = body.durationDays;
    }
    try {
      const { exclusion, changed } = await setSelfExclusion(options.database, playerId, durationDays);
      return {
        startedAt: new Date(exclusion.startedAt).toISOString(),
        endsAt: exclusion.endsAt ? new Date(exclusion.endsAt).toISOString() : null,
        changed,
        message:
          exclusion.endsAt === null
            ? "Самоисключение установлено бессрочно."
            : "Самоисключение действует. Досрочное снятие невозможно.",
      };
    } catch (e) {
      request.log.error(e);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  // --- Мониторинг RTP (T-028, ADR-007) ---
  app.get("/api/v1/monitoring/rtp", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    try {
      const result = await checkRtp(options.database);
      return result;
    } catch (e) {
      request.log.error(e);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  // --- Daily bonus (T-049) ---
  app.post("/api/v1/bonus/daily", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    try {
      const res = await claimDailyBonus(options.database, playerId);
      return {
        claimed: res.claimed,
        amount: res.amount.toString(),
        balance: res.balance.toString(),
        nextClaimAt: res.nextClaimAt,
        currency: "CHIP",
      };
    } catch (e) {
      request.log.error(e);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  // --- Leaderboard (T-050) ---
  app.get("/api/v1/leaderboard", async (request, reply) => {
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const { by, period, limit } = request.query as { by?: string; period?: string; limit?: string };
    const byVal = by === "bet" ? "bet" : "win";
    const periodVal = period === "day" || period === "week" ? period : "all";
    const lim = limit ? parseInt(limit, 10) : 20;
    try {
      const board = await getLeaderboard(options.database, byVal as any, periodVal as any, lim);
      return { by: byVal, period: periodVal, leaderboard: board };
    } catch (e) {
      request.log.error(e);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  // --- Промокоды (T-213) ---
  //
  // Начисляют ТОЛЬКО виртуальные фишки. Это не платёжный функционал:
  // лицензии у проекта нет, режим реальных денег запрещён протоколом
  // (AGENTS.md §11). Механика намеренно сделана «как для денег» — лимиты,
  // идемпотентность, аудит, — чтобы при появлении лицензии её не пришлось
  // переписывать.
  const PROMO_MESSAGES: Record<string, { status: number; message: string }> = {
    NOT_FOUND: { status: 404, message: "Такого промокода нет." },
    INACTIVE: { status: 409, message: "Промокод отключён." },
    NOT_STARTED: { status: 409, message: "Промокод ещё не начал действовать." },
    EXPIRED: { status: 409, message: "Срок действия промокода истёк." },
    EXHAUSTED: { status: 409, message: "Лимит активаций исчерпан." },
    ALREADY_USED: { status: 409, message: "Этот промокод вы уже использовали." },
    NO_WALLET: { status: 409, message: "Кошелёк не найден." },
  };

  app.post("/api/v1/promo/redeem", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });

    const body = (request.body ?? {}) as { code?: string };
    if (!body.code || typeof body.code !== "string") {
      return reply.status(400).send({ code: "VALIDATION_FAILED", message: "Нужен код." });
    }

    const playerId = (request.user as { sub: string }).sub;
    try {
      const result = await redeemPromo(options.database, playerId, body.code);
      if (!result.ok) {
        const info = PROMO_MESSAGES[result.reason ?? "NOT_FOUND"] ?? PROMO_MESSAGES.NOT_FOUND;
        return reply.status(info.status).send({ code: result.reason, message: info.message });
      }
      return { ok: true, code: result.code, chips: result.chips, balance: result.balance, currency: "CHIP" };
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  app.post("/api/v1/admin/promo", async (request, reply) => {
    const adminSecret = process.env.ADMIN_TOKEN || process.env.ADMIN_SECRET;
    if (!adminSecret || request.headers["x-admin-token"] !== adminSecret) {
      return reply.status(403).send({ code: "FORBIDDEN" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    try {
      const created = await createPromo(options.database, request.body as never);
      return reply.status(201).send(created);
    } catch (error) {
      return reply.status(400).send({ code: "VALIDATION_FAILED", message: (error as Error).message });
    }
  });

  app.get("/api/v1/admin/promo", async (request, reply) => {
    const adminSecret = process.env.ADMIN_TOKEN || process.env.ADMIN_SECRET;
    if (!adminSecret || request.headers["x-admin-token"] !== adminSecret) {
      return reply.status(403).send({ code: "FORBIDDEN" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    return { promos: await listPromos(options.database) };
  });

  // --- Tournaments (T-055) ---
  app.get("/api/v1/tournaments", async (request, reply) => {
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    try {
      const list = await listTournaments(options.database);
      return { tournaments: list };
    } catch (e) {
      request.log.error(e);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  app.get("/api/v1/tournaments/:code/leaderboard", async (request, reply) => {
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const { code } = request.params as { code: string };
    const { limit } = request.query as { limit?: string };
    const lim = limit ? parseInt(limit, 10) : 20;
    try {
      const board = await getTournamentLeaderboard(options.database, code, lim);
      if (!board) return reply.status(404).send({ code: "NOT_FOUND", message: "Турнир не найден" });
      return board;
    } catch (e) {
      request.log.error(e);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  // --- GDPR export (T-052) ---
  app.get("/api/v1/me/export", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    try {
      const data = await exportPlayerData(options.database, playerId);
      return data;
    } catch (e) {
      request.log.error(e);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  // --- Referrals (T-059) ---
  app.post("/api/v1/referrals", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const referrerId = (request.user as { sub: string }).sub;
    const { refereeId, referralCode } = request.body as { refereeId?: string; referralCode?: string };
    // Для простоты: если передан referralCode, считаем что это playerId реферера, а реферал — текущий игрок
    // Или если передан refereeId, текущий игрок — реферер
    let refId: string | undefined;
    let referee: string | undefined;
    if (referralCode) {
      // текущий игрок вводит код реферера
      refId = referralCode;
      referee = referrerId;
    } else if (refereeId) {
      refId = referrerId;
      referee = refereeId;
    } else {
      return reply.status(400).send({ code: "VALIDATION_FAILED", message: "need refereeId or referralCode" });
    }
    // T-180: понятные коды ошибок вместо общего 409
    const rejections: Record<string, { status: number; code: string; message: string }> = {
      self: { status: 400, code: "SELF_REFERRAL", message: "Нельзя пригласить самого себя" },
      "referrer-not-found": { status: 404, code: "REFERRER_NOT_FOUND", message: "Пригласивший игрок не найден" },
      "referee-not-found": { status: 404, code: "REFEREE_NOT_FOUND", message: "Приглашённый игрок не найден" },
      "referee-not-new": { status: 409, code: "REFEREE_NOT_NEW", message: "Код можно применить только до первого спина" },
      "already-referred": { status: 409, code: "ALREADY_REFERRED", message: "Реферал уже привязан" },
    };
    try {
      const result = await createReferral(options.database, refId, referee!);
      if (!result.ok) {
        const r = rejections[result.reason ?? "already-referred"] ?? rejections["already-referred"];
        return reply.status(r.status).send({ code: r.code, message: r.message });
      }
      // Ачивка реферала
      try { await checkAndUnlockAchievements(options.database, refId, { type: "referral" }, request.log); } catch (e) { request.log.error(e); }
      return { ok: true, referrerId: refId, refereeId: referee };
    } catch (e) {
      request.log.error(e);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  app.get("/api/v1/referrals", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    const list = await getReferrals(options.database, playerId);
    return { referrals: list, inviteCode: playerId, inviteLink: `/api/v1/referrals?code=${playerId}` };
  });

  // T-099 referral leaderboard top referrers
  // ВАЖНО: маршрут публичный и регистрируется на уровне сборки приложения.
  // Раньше (T-174) он был по ошибке вложен внутрь обработчика /referrals/progress —
  // из-за этого сам маршрут не существовал (404), а /referrals/progress падал
  // с 500 при попытке зарегистрировать роут после старта Fastify.
  app.get("/api/v1/referrals/leaderboard", async (request, reply) => {
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const { limit } = request.query as { limit?: string };
    const lim = limit ? parseInt(limit, 10) : 20;
    try {
      const board = await getReferralLeaderboard(options.database, lim);
      return { leaderboard: board };
    } catch (e) {
      request.log.error(e);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  // T-070 referral progress
  app.get("/api/v1/referrals/progress", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    try {
      const prog = await getReferralProgress(options.database, playerId);
      return prog;
    } catch (e) {
      request.log.error(e);
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    }
  });

  // --- Achievements (T-060) ---
  app.get("/api/v1/achievements", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    const list = await listAchievements(options.database, playerId);
    return { achievements: list };
  });

  // --- Chat (T-061) ---
  app.get("/api/v1/chat", async (request, reply) => {
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const { limit } = request.query as { limit?: string };
    const lim = limit ? parseInt(limit, 10) : 50;
    const msgs = await listMessages(options.database, lim);
    return { messages: msgs };
  });

  app.post("/api/v1/chat", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ code: "UNAUTHENTICATED" });
    }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const playerId = (request.user as { sub: string }).sub;
    const username = (request.user as { username?: string }).username ?? (request.user as { sub: string }).sub.slice(0, 8);
    const { message } = request.body as { message?: string };
    if (!message) return reply.status(400).send({ code: "VALIDATION_FAILED", message: "message required" });

    const rl = canChat(playerId);
    if (!rl.allowed) {
      return reply.status(429).header("Retry-After", Math.ceil((rl.retryAfterMs ?? 1000)/1000).toString()).send({ code: "RATE_LIMITED", message: "Слишком часто в чате" });
    }

    try {
      const msg = await postMessage(options.database, playerId, username, message);
      return msg;
    } catch (e) {
      return reply.status(400).send({ code: "VALIDATION_FAILED", message: (e as Error).message });
    }
  });

  // --- Push notifications (T-079) ---
  app.post("/api/v1/push/subscribe", async (request, reply) => {
    try { await request.jwtVerify(); } catch { return reply.status(401).send({ code: "UNAUTHENTICATED" }); }
    const playerId = (request.user as { sub: string }).sub;
    const { endpoint, keys } = request.body as { endpoint?: string; keys?: { p256dh: string; auth: string } };
    if (!endpoint || !keys) return reply.status(400).send({ code: "VALIDATION_FAILED", message: "need endpoint and keys" });
    await subscribePush(playerId, { endpoint, keys }, options.database);
    return { ok: true };
  });

  // T-178: отписка — браузер вызывает при отзыве разрешения на уведомления
  app.delete("/api/v1/push/subscribe", async (request, reply) => {
    try { await request.jwtVerify(); } catch { return reply.status(401).send({ code: "UNAUTHENTICATED" }); }
    const { endpoint } = (request.body ?? {}) as { endpoint?: string };
    if (!endpoint) return reply.status(400).send({ code: "VALIDATION_FAILED", message: "need endpoint" });
    await unsubscribePush(endpoint, options.database);
    return { ok: true };
  });

  app.get("/api/v1/push/subscriptions", async (request, reply) => {
    try { await request.jwtVerify(); } catch { return reply.status(401).send({ code: "UNAUTHENTICATED" }); }
    const playerId = (request.user as { sub: string }).sub;
    const list = await getSubscriptions(playerId, options.database);
    return { subscriptions: list };
  });

  // --- Backup restore UI (T-077, T-083) — admin only ---
  app.post("/api/v1/admin/backup", async (request, reply) => {
    const adminToken = process.env.ADMIN_TOKEN || process.env.ADMIN_SECRET;
    const token = (request.headers["x-admin-token"] as string) ?? "";
    if (!adminToken || token !== adminToken) return reply.status(403).send({ code: "FORBIDDEN" });
    // В реальности здесь вызываем backup.sh, для демо возвращаем фиктивный путь
    return { ok: true, file: `backups/casino_${new Date().toISOString().slice(0,10)}.sql.gz`, message: "Бэкап запущен (mock)" };
  });

  // --- Админка (T-031) — включается если задан ADMIN_TOKEN ---
  const adminToken = process.env.ADMIN_TOKEN || process.env.ADMIN_SECRET;
  if (adminToken && options.database) {
    registerAdminRoutes(app, { adminToken, database: options.database });
    app.log.info("Admin routes enabled");
  }

  // --- Совместимость со старым devServer ---

  return app;
}
