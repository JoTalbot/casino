/**
 * HTTP-приложение боевого API. Секреты и соединение передаются извне, чтобы
 * приложение можно было проверять через Fastify.inject без PostgreSQL.
 */
import fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { z } from "zod";
import { loadConfig } from "../engine/config.js";
import { playRound } from "../engine/round.js";
import type { Database } from "./db.js";
import { RoundServiceError, settleRound } from "./roundService.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/i, "ожидается SHA-256 в hex");
const roundBody = z.object({
  gameCode: z.literal("crown-of-fortune"),
  betPerLine: z.number().int().positive().max(100),
  lines: z.number().int().positive(),
});

const verifyBody = z.object({
  serverSeed: sha256,
  clientSeed: z.string().min(1).max(256).refine((seed) => !seed.includes(":")),
  nonce: z.number().int().nonnegative(),
  gameCode: z.literal("crown-of-fortune"),
  configHash: sha256.optional(),
});

export interface AppOptions {
  jwtSecret: string;
  database?: Database;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = fastify({ logger: true });
  await app.register(jwt, { secret: options.jwtSecret });
  const loaded = loadConfig();

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ code: "VALIDATION_FAILED", message: error.issues });
    }
    app.log.error(error);
    return reply.status(500).send({ code: "INTERNAL_ERROR", message: "Внутренняя ошибка сервера." });
  });

  app.get("/health", async () => ({ status: "ok" }));

  // Проверка намеренно публичная: не читает БД и не раскрывает серверные сиды.
  app.post("/api/v1/verify", async (request) => {
    const body = verifyBody.parse(request.body);
    if (body.configHash && body.configHash !== loaded.hash) {
      return { valid: false, code: "CONFIG_HASH_MISMATCH", configHash: loaded.hash };
    }
    const round = playRound(loaded.config, body.serverSeed, body.clientSeed, body.nonce);
    return { valid: true, configHash: loaded.hash, round };
  });

  app.get("/api/v1/games", async () => ({
    games: [{ code: "crown-of-fortune", name: loaded.config.name, version: loaded.config.version,
      configHash: loaded.hash, lines: loaded.config.lines, enabled: true }],
  }));

  app.post("/api/v1/rounds", async (request, reply) => {
    try { await request.jwtVerify(); } catch { return reply.status(401).send({ code: "UNAUTHENTICATED" }); }
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 128) {
      return reply.status(400).send({ code: "VALIDATION_FAILED", message: "Нужен заголовок Idempotency-Key длиной 1…128." });
    }
    const body = roundBody.parse(request.body);
    try {
      const settled = await settleRound(options.database, loaded, (request.user as { sub: string }).sub, idempotencyKey, body.betPerLine, body.lines);
      if (settled.idempotent) return reply.status(200).send({ roundId: settled.roundId, idempotent: true });
      return reply.status(201).send({
        roundId: settled.roundId, gameCode: body.gameCode, configHash: loaded.hash, status: "settled",
        bet: { perLine: body.betPerLine, lines: body.lines, total: settled.record.totalBet },
        fairness: { serverSeedHash: settled.record.serverSeedHash, clientSeed: settled.record.clientSeed, nonce: settled.record.nonce },
        spins: settled.record.spins, totalWin: settled.record.totalWin,
        balance: { amount: settled.balance.toString(), currency: "CHIP" },
      });
    } catch (error) {
      if (error instanceof RoundServiceError) return reply.status(409).send({ code: error.code, message: error.message });
      throw error;
    }
  });

  // Этот маршрут проверяет JWT до любого обращения к хранилищу.
  app.get("/api/v1/wallet", async (request, reply) => {
    try { await request.jwtVerify(); } catch { return reply.status(401).send({ code: "UNAUTHENTICATED" }); }
    const playerId = (request.user as { sub: string }).sub;
    if (!options.database) return reply.status(503).send({ code: "DATABASE_UNAVAILABLE" });
    const result = await options.database.query<{ balance: string; currency_code: string }>(
      "SELECT balance, currency_code FROM wallets WHERE player_id = $1 AND currency_code = 'CHIP'", [playerId],
    );
    if (!result.rows[0]) return reply.status(404).send({ code: "WALLET_NOT_FOUND" });
    return { balance: result.rows[0].balance, currency: result.rows[0].currency_code };
  });

  return app;
}
