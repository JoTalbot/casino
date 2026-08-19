import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { runMigrations } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ADMIN = "test-admin-secret";

test("админка: stats, players, grant, rtp, daily", { skip: !databaseUrl }, async () => {
  process.env.ADMIN_TOKEN = ADMIN;
  const dbUrl = databaseUrl!;
  await runMigrations(dbUrl);

  const pool = new Pool({ connectionString: dbUrl });
  try {
    await pool.query("TRUNCATE players, clubs, wallets, ledger_entries, games, game_configs, seed_pairs, rounds, spins, audit_log, sessions, player_limits, self_exclusions CASCADE");

    const { createDatabase } = await import("./db.js");
    const database = createDatabase(dbUrl);
    const app = await buildApp({ jwtSecret: "integration-admin-test-secret-достаточной-длины", database });

    try {
      // создаём гостя
      const demoRes = await app.inject({ method: "POST", url: "/api/v1/auth/demo" });
      assert.equal(demoRes.statusCode, 201);
      const token = demoRes.json().token;
      const authHeader = { authorization: `Bearer ${token}` };

      // играем раунд чтобы была активность
      const roundRes = await app.inject({
        method: "POST",
        url: "/api/v1/rounds",
        headers: { ...authHeader, "idempotency-key": "admin-test-key" },
        payload: { gameCode: "crown-of-fortune", betPerLine: 10, lines: 20 },
      });
      assert.equal(roundRes.statusCode, 201);

      const adminHeaders = { "x-admin-token": ADMIN };

      const statsRes = await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: adminHeaders });
      assert.equal(statsRes.statusCode, 200, statsRes.body);
      assert.equal(statsRes.json().players >= 1, true);

      const playersRes = await app.inject({ method: "GET", url: "/api/v1/admin/players?limit=5", headers: adminHeaders });
      assert.equal(playersRes.statusCode, 200);
      const playerId = playersRes.json().players[0].id;

      const grantRes = await app.inject({
        method: "POST",
        url: "/api/v1/admin/grant",
        headers: adminHeaders,
        payload: { playerId, amount: 5000, reason: "test grant" },
      });
      assert.equal(grantRes.statusCode, 200, grantRes.body);
      assert.equal(grantRes.json().ok, true);

      const rtpRes = await app.inject({ method: "GET", url: "/api/v1/admin/rtp", headers: adminHeaders });
      assert.equal(rtpRes.statusCode, 200);

      const dailyRes = await app.inject({ method: "GET", url: "/api/v1/admin/daily?days=7", headers: adminHeaders });
      assert.equal(dailyRes.statusCode, 200);
      assert.ok(Array.isArray(dailyRes.json().daily));

      const forbidRes = await app.inject({ method: "GET", url: "/api/v1/admin/stats" });
      assert.equal(forbidRes.statusCode, 403);
    } finally {
      await app.close();
      await database.close();
      delete process.env.ADMIN_TOKEN;
    }
  } finally {
    await pool.end();
  }
});
