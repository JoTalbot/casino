import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { runMigrations } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("полный сценарий: demo-auth, seeds, раунд, идемпотентность, история", { skip: !databaseUrl }, async () => {
  const dbUrl = databaseUrl!;
  await runMigrations(dbUrl);

  // Чистим данные предыдущего прогона, но сохраняем схему миграций
  const pool = new Pool({ connectionString: dbUrl });
  try {
    await pool.query("TRUNCATE players, clubs, wallets, ledger_entries, games, game_configs, seed_pairs, rounds, spins, audit_log, sessions, player_limits, self_exclusions CASCADE");

    const { createDatabase } = await import("./db.js");
    const database = createDatabase(dbUrl);
    const app = await buildApp({ jwtSecret: "integration-test-secret-достаточной-длины-32+", database });

    try {
      // 1. demo-auth
      const demoRes = await app.inject({ method: "POST", url: "/api/v1/auth/demo" });
      assert.equal(demoRes.statusCode, 201, `demo auth: ${demoRes.body}`);
      const demoBody = demoRes.json() as { playerId: string; token: string; wallet: { balance: string } };
      assert.ok(demoBody.playerId);
      assert.ok(demoBody.token);
      const token = demoBody.token;
      const authHeader = { authorization: `Bearer ${token}` };

      // 2. текущий сид
      const curRes = await app.inject({ method: "GET", url: "/api/v1/seeds/current", headers: authHeader });
      assert.equal(curRes.statusCode, 200, curRes.body);
      const cur = curRes.json() as { serverSeedHash: string; clientSeed: string; nonce: number };
      assert.equal(cur.nonce, 0);

      // 3. смена клиентского сида
      const setRes = await app.inject({
        method: "POST",
        url: "/api/v1/seeds/client",
        headers: authHeader,
        payload: { clientSeed: "test-client-seed" },
      });
      assert.equal(setRes.statusCode, 200, setRes.body);
      assert.equal(setRes.json().clientSeed, "test-client-seed");

      // 4. игра раунда с Idempotency-Key
      const key = "integration-test-key-1";
      const roundRes = await app.inject({
        method: "POST",
        url: "/api/v1/rounds",
        headers: { ...authHeader, "idempotency-key": key },
        payload: { gameCode: "crown-of-fortune", betPerLine: 10, lines: 20 },
      });
      assert.equal(roundRes.statusCode, 201, roundRes.body);
      const roundBody = roundRes.json() as { roundId: string; totalWin: number; bet: { total: number } };
      assert.ok(roundBody.roundId);
      const firstRoundId = roundBody.roundId;

      // 5. повтор с тем же ключом и теми же параметрами — идемпотентный 200
      const repeatRes = await app.inject({
        method: "POST",
        url: "/api/v1/rounds",
        headers: { ...authHeader, "idempotency-key": key },
        payload: { gameCode: "crown-of-fortune", betPerLine: 10, lines: 20 },
      });
      assert.equal(repeatRes.statusCode, 200, repeatRes.body);
      assert.equal(repeatRes.json().roundId, firstRoundId);
      assert.ok(repeatRes.json().idempotent);

      // 6. повтор с тем же ключом но другими параметрами — конфликт 409
      const conflictRes = await app.inject({
        method: "POST",
        url: "/api/v1/rounds",
        headers: { ...authHeader, "idempotency-key": key },
        payload: { gameCode: "crown-of-fortune", betPerLine: 20, lines: 20 },
      });
      assert.equal(conflictRes.statusCode, 409, conflictRes.body);
      assert.equal(conflictRes.json().code, "IDEMPOTENCY_CONFLICT");

      // 7. новый раунд с другим ключом
      const roundRes2 = await app.inject({
        method: "POST",
        url: "/api/v1/rounds",
        headers: { ...authHeader, "idempotency-key": "integration-test-key-2" },
        payload: { gameCode: "crown-of-fortune", betPerLine: 10, lines: 20 },
      });
      assert.equal(roundRes2.statusCode, 201);
      assert.notEqual(roundRes2.json().roundId, firstRoundId);

      // 8. история раундов
      const histRes = await app.inject({ method: "GET", url: "/api/v1/rounds?limit=10", headers: authHeader });
      assert.equal(histRes.statusCode, 200, histRes.body);
      const hist = histRes.json() as { rounds: unknown[] };
      assert.equal(hist.rounds.length, 2);

      // 9. полная карточка раунда
      const fullRes = await app.inject({ method: "GET", url: `/api/v1/rounds/${firstRoundId}`, headers: authHeader });
      assert.equal(fullRes.statusCode, 200, fullRes.body);
      const full = fullRes.json() as { roundId: string; spins: unknown[] };
      assert.equal(full.roundId, firstRoundId);
      assert.ok((full.spins as unknown[]).length >= 1);

      // 10. кошелёк
      const walletRes = await app.inject({ method: "GET", url: "/api/v1/wallet", headers: authHeader });
      assert.equal(walletRes.statusCode, 200, walletRes.body);

      // 11. транзакции кошелька
      const txRes = await app.inject({ method: "GET", url: "/api/v1/wallet/transactions?limit=10", headers: authHeader });
      assert.equal(txRes.statusCode, 200, txRes.body);
      assert.ok((txRes.json() as { transactions: unknown[] }).transactions.length >= 2);

      // 12. ротация сидов
      const rotateRes = await app.inject({ method: "POST", url: "/api/v1/seeds/rotate", headers: authHeader });
      assert.equal(rotateRes.statusCode, 200, rotateRes.body);
      const rotated = rotateRes.json() as { revealed: { serverSeed: string }; current: { serverSeedHash: string } };
      assert.ok(rotated.revealed.serverSeed);
      assert.ok(rotated.current.serverSeedHash);

      // 13. история сидов
      const shRes = await app.inject({ method: "GET", url: "/api/v1/seeds/history?limit=5", headers: authHeader });
      assert.equal(shRes.statusCode, 200, shRes.body);
      assert.equal((shRes.json() as { seedPairs: unknown[] }).seedPairs.length, 1);

      // 14. verify публичный
      const verifyRes = await app.inject({
        method: "POST",
        url: "/api/v1/verify",
        payload: {
          serverSeed: rotated.revealed.serverSeed,
          clientSeed: "test-client-seed",
          nonce: 0,
          gameCode: "crown-of-fortune",
        },
      });
      assert.equal(verifyRes.statusCode, 200, verifyRes.body);
      assert.equal(verifyRes.json().valid, true);

      // 15. legacy клиент: POST /rounds без Idempotency-Key и только betPerLine (должен работать через совместимость)
      const legacyRes = await app.inject({
        method: "POST",
        url: "/api/v1/rounds",
        headers: authHeader,
        payload: { betPerLine: 10 },
      });
      assert.equal(legacyRes.statusCode, 201, legacyRes.body);
    } finally {
      await app.close();
      await database.close();
    }
  } finally {
    await pool.end();
  }
});
