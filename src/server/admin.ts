/** Простая админка (T-031) — только для демо, без ролей. Проверка по X-Admin-Token. */
import type { FastifyInstance } from "fastify";
import type { Database } from "./db.js";
import { checkRtp } from "./monitoring.js";

export interface AdminOptions {
  adminToken: string;
  database: Database;
}

export function registerAdminRoutes(app: FastifyInstance, opts: AdminOptions): void {
  function checkAdmin(request: { headers: Record<string, unknown> }): boolean {
    const token = request.headers["x-admin-token"] ?? request.headers["x-admin-secret"];
    return typeof token === "string" && token === opts.adminToken;
  }

  app.get("/api/v1/admin/players", async (request, reply) => {
    if (!checkAdmin(request as any)) return reply.status(403).send({ code: "FORBIDDEN", message: "Нужен X-Admin-Token" });
    const { limit } = request.query as { limit?: string };
    const lim = Math.min(Math.max(limit ? parseInt(limit, 10) : 50, 1), 200);
    const res = await opts.database.query<{
      id: string;
      username: string;
      status: string;
      created_at: string;
      balance: string | null;
    }>(
      `SELECT p.id, p.username, p.status, p.created_at, w.balance
       FROM players p
       LEFT JOIN wallets w ON w.player_id = p.id AND w.currency_code = 'CHIP'
       ORDER BY p.created_at DESC LIMIT $1`,
      [lim],
    );
    return { players: res.rows };
  });

  app.get("/api/v1/admin/rounds", async (request, reply) => {
    if (!checkAdmin(request as any)) return reply.status(403).send({ code: "FORBIDDEN" });
    const { limit } = request.query as { limit?: string };
    const lim = Math.min(Math.max(limit ? parseInt(limit, 10) : 50, 1), 200);
    const res = await opts.database.query<{
      id: string;
      player_id: string;
      username: string;
      game_code: string;
      total_bet: string;
      total_win: string;
      started_at: string;
    }>(
      `SELECT r.id, r.player_id, p.username, g.code as game_code, r.total_bet, r.total_win, r.started_at
       FROM rounds r
       JOIN players p ON p.id = r.player_id
       JOIN games g ON g.id = r.game_id
       ORDER BY r.started_at DESC LIMIT $1`,
      [lim],
    );
    return { rounds: res.rows };
  });

  app.post("/api/v1/admin/grant", async (request, reply) => {
    if (!checkAdmin(request as any)) return reply.status(403).send({ code: "FORBIDDEN" });
    const body = request.body as { playerId?: string; amount?: number; reason?: string };
    if (!body.playerId || !Number.isInteger(body.amount) || body.amount! <= 0) {
      return reply.status(400).send({ code: "VALIDATION_FAILED", message: "need playerId and positive amount" });
    }
    const amount = BigInt(body.amount!);
    const result = await opts.database.transaction(async (client) => {
      const walletRes = await client.query<{ id: string; balance: string }>(
        "SELECT id, balance FROM wallets WHERE player_id = $1 AND currency_code = 'CHIP' FOR UPDATE",
        [body.playerId],
      );
      if (!walletRes.rows[0]) throw new Error("Wallet not found");
      const walletId = walletRes.rows[0].id;
      const oldBal = BigInt(walletRes.rows[0].balance);
      const newBal = oldBal + amount;
      const idempotencyKey = `admin-grant:${body.playerId}:${Date.now()}:${Math.random()}`;
      await client.query(
        `INSERT INTO ledger_entries (wallet_id, amount, balance_after, tx_type, idempotency_key, reason) VALUES ($1,$2,$3,'grant', $4,$5)`,
        [walletId, amount.toString(), newBal.toString(), idempotencyKey, body.reason ?? "admin grant"],
      );
      await client.query(
        `INSERT INTO audit_log (actor_type, actor_id, event_type, subject_type, subject_id, payload) VALUES ('admin','system','wallet.grant','wallet',$1,$2)`,
        [walletId, JSON.stringify({ playerId: body.playerId, amount: amount.toString(), reason: body.reason })],
      );
      return { walletId, oldBal, newBal };
    });
    return { ok: true, ...result, newBalance: result.newBal.toString() };
  });

  app.get("/api/v1/admin/rtp", async (request, reply) => {
    if (!checkAdmin(request as any)) return reply.status(403).send({ code: "FORBIDDEN" });
    const rtp = await checkRtp(opts.database);
    return rtp;
  });

  app.get("/api/v1/admin/stats", async (request, reply) => {
    if (!checkAdmin(request as any)) return reply.status(403).send({ code: "FORBIDDEN" });
    const players = await opts.database.query<{ c: string }>("SELECT COUNT(*) as c FROM players");
    const rounds = await opts.database.query<{ c: string; total_bet: string; total_win: string }>(
      "SELECT COUNT(*) as c, COALESCE(SUM(total_bet),0) as total_bet, COALESCE(SUM(total_win),0) as total_win FROM rounds WHERE status='settled'",
    );
    const activeSeeds = await opts.database.query<{ c: string }>("SELECT COUNT(*) as c FROM seed_pairs WHERE status='active'");
    return {
      players: Number(players.rows[0]?.c ?? 0),
      rounds: {
        count: Number(rounds.rows[0]?.c ?? 0),
        totalBet: rounds.rows[0]?.total_bet ?? "0",
        totalWin: rounds.rows[0]?.total_win ?? "0",
      },
      activeSeeds: Number(activeSeeds.rows[0]?.c ?? 0),
    };
  });

  app.get("/api/v1/admin/daily", async (request, reply) => {
    if (!checkAdmin(request as any)) return reply.status(403).send({ code: "FORBIDDEN" });
    const { days } = request.query as { days?: string };
    const d = Math.min(Math.max(days ? parseInt(days, 10) : 14, 1), 90);
    const res = await opts.database.query<{
      day: string;
      rounds: string;
      total_bet: string;
      total_win: string;
      rtp: string | null;
    }>(
      `SELECT date_trunc('day', started_at)::date as day,
              COUNT(*) as rounds,
              SUM(total_bet) as total_bet,
              SUM(total_win) as total_win,
              CASE WHEN SUM(total_bet) > 0 THEN SUM(total_win)::float / SUM(total_bet)::float ELSE NULL END as rtp
       FROM rounds
       WHERE status='settled' AND started_at >= now() - ($1::int || ' days')::interval
       GROUP BY 1 ORDER BY 1 ASC`,
      [d],
    );
    return { daily: res.rows };
  });
}
