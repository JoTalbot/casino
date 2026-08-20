/**
 * Тесты соц-слоя без PostgreSQL (T-175, T-177).
 *
 * Покрывают то, что раньше не покрывал никто: маршруты чата, ачивок,
 * рефералов, турниров и push. Работают на стабе БД (`fakeDb.ts`),
 * поэтому идут в CI на каждом пуше, а не пропускаются как PG-тесты.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";
import { createFakeDatabase } from "./fakeDb.js";
import { resetChatLimits } from "./chat.js";

const JWT_SECRET = "секрет-для-тестов-соц-слоя-достаточной-длины";

function authHeader(app: { jwt: { sign: (p: object) => string } }, sub: string, username = "tester") {
  return { authorization: `Bearer ${app.jwt.sign({ sub, username })}` };
}

test("referrals/leaderboard зарегистрирован и отдаёт таблицу", async () => {
  const database = createFakeDatabase({
    routes: [
      [
        "FROM referrals r JOIN players p ON p.id = r.referrer_id",
        [{ referrer_id: "p1", username: "alice", count: "3", total_bonus: "15000" }],
      ],
    ],
  });
  const app = await buildApp({ jwtSecret: JWT_SECRET, database });
  try {
    const res = await app.inject({ method: "GET", url: "/api/v1/referrals/leaderboard?limit=5" });
    assert.equal(res.statusCode, 200, res.body);
    const board = res.json().leaderboard;
    assert.equal(board.length, 1);
    assert.deepEqual(board[0], { rank: 1, playerId: "p1", username: "alice", count: 3, totalBonus: 15000 });
  } finally {
    await app.close();
  }
});

test("referrals/progress требует JWT и считает прогресс", async () => {
  const database = createFakeDatabase({
    routes: [["SELECT COUNT(*) as count FROM referrals WHERE referrer_id", [{ count: "2" }]]],
  });
  const app = await buildApp({ jwtSecret: JWT_SECRET, database });
  try {
    const anon = await app.inject({ method: "GET", url: "/api/v1/referrals/progress" });
    assert.equal(anon.statusCode, 401);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/referrals/progress",
      headers: authHeader(app as never, "p1"),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { count: 2, target: 5, progress: 0.4, remaining: 3, hasMaster: false });
  } finally {
    await app.close();
  }
});

test("нельзя пригласить самого себя", async () => {
  const database = createFakeDatabase();
  const app = await buildApp({ jwtSecret: JWT_SECRET, database });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/referrals",
      headers: authHeader(app as never, "p1"),
      payload: { refereeId: "p1" },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().code, "SELF_REFERRAL");
  } finally {
    await app.close();
  }
});

test("реферал: приглашение несуществующего игрока отклоняется", async () => {
  const database = createFakeDatabase({
    routes: [["FROM players WHERE id IN", [{ id: "p1" }]]],
  });
  const app = await buildApp({ jwtSecret: JWT_SECRET, database });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/referrals",
      headers: authHeader(app as never, "p1"),
      payload: { refereeId: "ghost" },
    });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().code, "REFEREE_NOT_FOUND");
    assert.equal(
      database.calls.some((c) => c.sql.includes("INSERT INTO referrals")),
      false,
      "бонус не должен начисляться за несуществующего игрока",
    );
  } finally {
    await app.close();
  }
});

test("реферал: нельзя привязать игрока, который уже играл", async () => {
  const database = createFakeDatabase({
    routes: [
      ["FROM players WHERE id IN", [{ id: "p1" }, { id: "p2" }]],
      ["COUNT(*) AS c FROM rounds", [{ c: "42" }]],
    ],
  });
  const app = await buildApp({ jwtSecret: JWT_SECRET, database });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/referrals",
      headers: authHeader(app as never, "p1"),
      payload: { refereeId: "p2" },
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().code, "REFEREE_NOT_NEW");
  } finally {
    await app.close();
  }
});

test("реферал: корректная привязка новичка начисляет оба бонуса", async () => {
  const database = createFakeDatabase({
    routes: [
      ["FROM players WHERE id IN", [{ id: "p1" }, { id: "p2" }]],
      ["COUNT(*) AS c FROM rounds", [{ c: "0" }]],
      ["SELECT id FROM referrals WHERE referee_id", []],
      ["INSERT INTO referrals", []],
      ["FROM wallets WHERE player_id", (values) => [{ id: `w-${values[0]}`, balance: "1000" }]],
      ["INSERT INTO ledger_entries", []],
      ["INSERT INTO audit_log", []],
      ["FROM player_achievements pa JOIN achievements a", []],
      ["SELECT COUNT(*) as c FROM referrals WHERE referrer_id", [{ c: "1" }]],
    ],
  });
  const app = await buildApp({ jwtSecret: JWT_SECRET, database });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/referrals",
      headers: authHeader(app as never, "p1"),
      payload: { refereeId: "p2" },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { ok: true, referrerId: "p1", refereeId: "p2" });

    const ledger = database.calls.filter((c) => c.sql.includes("INSERT INTO ledger_entries"));
    assert.equal(ledger.length, 2, "бонус пригласившему и приглашённому");
    assert.deepEqual(
      ledger.map((c) => c.values[1]),
      ["5000", "1000"],
    );
    // Идемпотентные ключи различаются, повторный вызов не удвоит бонус
    assert.notEqual(ledger[0].values[3], ledger[1].values[3]);
  } finally {
    await app.close();
  }
});

test("POST /referrals без параметров — 400", async () => {
  const database = createFakeDatabase();
  const app = await buildApp({ jwtSecret: JWT_SECRET, database });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/referrals",
      headers: authHeader(app as never, "p1"),
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, "VALIDATION_FAILED");
  } finally {
    await app.close();
  }
});

test("турниры: список отдаётся, неизвестный код — 404", async () => {
  const database = createFakeDatabase({
    routes: [
      [
        "FROM tournaments ORDER BY starts_at DESC",
        [
          {
            id: "t1",
            code: "weekly",
            title: "Недельный",
            description: "топ по выигрышу",
            status: "active",
            game_code: "crown-of-fortune",
            starts_at: "2026-08-18T00:00:00Z",
            ends_at: "2026-08-25T00:00:00Z",
            prize_pool: "100000",
          },
        ],
      ],
      ["FROM tournaments WHERE code = $1", []],
    ],
  });
  const app = await buildApp({ jwtSecret: JWT_SECRET, database });
  try {
    const list = await app.inject({ method: "GET", url: "/api/v1/tournaments" });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().tournaments[0].code, "weekly");

    const missing = await app.inject({ method: "GET", url: "/api/v1/tournaments/nope/leaderboard" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().code, "NOT_FOUND");
  } finally {
    await app.close();
  }
});

test("турнирная таблица ранжируется по выигрышу", async () => {
  const database = createFakeDatabase({
    routes: [
      [
        "FROM tournaments WHERE code = $1",
        [{ id: "t1", starts_at: "2026-08-18T00:00:00Z", ends_at: "2026-08-25T00:00:00Z" }],
      ],
      [
        "JOIN players p ON p.id = r.player_id",
        [
          { player_id: "p1", username: "alice", total_win: "5000", total_bet: "3000", rounds: "12" },
          { player_id: "p2", username: "bob", total_win: "2500", total_bet: "4000", rounds: "20" },
        ],
      ],
    ],
  });
  const app = await buildApp({ jwtSecret: JWT_SECRET, database });
  try {
    const res = await app.inject({ method: "GET", url: "/api/v1/tournaments/weekly/leaderboard" });
    assert.equal(res.statusCode, 200, res.body);
    const board = res.json().leaderboard;
    assert.equal(board[0].rank, 1);
    assert.equal(board[0].username, "alice");
    assert.equal(board[1].rank, 2);
    assert.equal(board[1].totalWin, 2500);
  } finally {
    await app.close();
  }
});

test("чат: список публичен, отправка требует JWT", async () => {
  resetChatLimits();
  const database = createFakeDatabase({
    routes: [
      [
        "FROM chat_messages ORDER BY created_at DESC",
        [{ id: "m1", player_id: "p1", username: "alice", message: "привет", created_at: "2026-08-20T00:00:00Z" }],
      ],
      ["INSERT INTO chat_messages", [{ id: "m2", created_at: "2026-08-20T01:00:00Z" }]],
    ],
  });
  const app = await buildApp({ jwtSecret: JWT_SECRET, database });
  try {
    const list = await app.inject({ method: "GET", url: "/api/v1/chat?limit=10" });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().messages[0].message, "привет");

    const anon = await app.inject({ method: "POST", url: "/api/v1/chat", payload: { message: "эй" } });
    assert.equal(anon.statusCode, 401);

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: authHeader(app as never, "chat-player-1"),
      payload: { message: "  всем удачи  " },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().id, "m2");
  } finally {
    await app.close();
  }
});

test("чат: фильтр слов, пустое сообщение и лимит частоты", async () => {
  resetChatLimits();
  const database = createFakeDatabase({
    routes: [["INSERT INTO chat_messages", [{ id: "m", created_at: "2026-08-20T01:00:00Z" }]]],
  });
  const app = await buildApp({ jwtSecret: JWT_SECRET, database });
  try {
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: authHeader(app as never, "chat-player-2"),
      payload: { message: "это scam, не ведитесь" },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().code, "VALIDATION_FAILED");

    const empty = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: authHeader(app as never, "chat-player-2"),
      payload: { message: "   " },
    });
    assert.equal(empty.statusCode, 400);

    // 5 сообщений в минуту — шестое должно упереться в лимит
    const headers = authHeader(app as never, "chat-player-3");
    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({ method: "POST", url: "/api/v1/chat", headers, payload: { message: `msg ${i}` } });
      last = res.statusCode;
    }
    assert.equal(last, 429);
  } finally {
    await app.close();
  }
});

test("ачивки: список отдаётся с датой открытия", async () => {
  const database = createFakeDatabase({
    routes: [
      [
        "FROM achievements a LEFT JOIN player_achievements",
        [
          { code: "first_win", title: "Первый выигрыш", description: "…", reward: "500", unlocked_at: "2026-08-19T10:00:00Z" },
          { code: "big_win", title: "Крупный выигрыш", description: "…", reward: "5000", unlocked_at: null },
        ],
      ],
    ],
  });
  const app = await buildApp({ jwtSecret: JWT_SECRET, database });
  try {
    const anon = await app.inject({ method: "GET", url: "/api/v1/achievements" });
    assert.equal(anon.statusCode, 401);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/achievements",
      headers: authHeader(app as never, "p1"),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().achievements.length, 2);
    assert.equal(res.json().achievements[1].unlocked_at, null);
  } finally {
    await app.close();
  }
});

test("push: подписка требует endpoint и keys, дедуплицируется", async () => {
  // Подписки с T-178 живут в таблице push_subscriptions — моделируем её в стабе.
  const rows: Array<{ endpoint: string; p256dh: string; auth: string; created_at: string }> = [];
  const database = createFakeDatabase({
    routes: [
      [
        "INSERT INTO push_subscriptions",
        (values) => {
          const [, endpoint, p256dh, auth] = values as string[];
          if (!rows.some((r) => r.endpoint === endpoint)) {
            rows.push({ endpoint, p256dh, auth, created_at: "2026-08-20T00:00:00Z" });
          }
          return [];
        },
      ],
      ["FROM push_subscriptions", () => rows],
    ],
  });
  const app = await buildApp({ jwtSecret: JWT_SECRET, database });
  try {
    const headers = authHeader(app as never, "push-player-1");

    const bad = await app.inject({ method: "POST", url: "/api/v1/push/subscribe", headers, payload: { endpoint: "https://x" } });
    assert.equal(bad.statusCode, 400);

    const payload = { endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } };
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({ method: "POST", url: "/api/v1/push/subscribe", headers, payload });
      assert.equal(res.statusCode, 200, res.body);
    }

    const list = await app.inject({ method: "GET", url: "/api/v1/push/subscriptions", headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().subscriptions.length, 1, "повторная подписка не должна дублироваться");
  } finally {
    await app.close();
  }
});

test("соц-маршруты отвечают 503, если БД не подключена", async () => {
  const app = await buildApp({ jwtSecret: JWT_SECRET });
  try {
    for (const url of ["/api/v1/tournaments", "/api/v1/chat", "/api/v1/referrals/leaderboard"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 503, `${url}: ${res.body}`);
      assert.equal(res.json().code, "DATABASE_UNAVAILABLE");
    }
  } finally {
    await app.close();
  }
});

test("бонус-тир проходит валидацию и попадает в проверку раунда", async () => {
  const app = await buildApp({ jwtSecret: JWT_SECRET });
  try {
    // Проверка раунда с тиром — публичный маршрут, БД не нужна
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/verify",
      payload: { serverSeed: "c".repeat(64), clientSeed: "bonus", nonce: 3, bonusTier: 5 },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().valid, true);
    assert.equal(ok.json().round.bonusTier, 5);

    // Тир вне списка отклоняется, а не молча приводится к единице
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/verify",
      payload: { serverSeed: "c".repeat(64), clientSeed: "bonus", nonce: 3, bonusTier: 7 },
    });
    assert.equal(bad.statusCode, 400);

    // Тир по умолчанию — обычная серия
    const plain = await app.inject({
      method: "POST",
      url: "/api/v1/verify",
      payload: { serverSeed: "c".repeat(64), clientSeed: "bonus", nonce: 3 },
    });
    assert.equal(plain.json().round.bonusTier, 1);
  } finally {
    await app.close();
  }
});
