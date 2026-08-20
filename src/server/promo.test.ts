/**
 * Тесты промокодов (T-213).
 *
 * Промокод — это выдача ценности по внешнему вводу, поэтому проверяются
 * не только удачные пути, но и каждый способ получить фишки дважды.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";
import { createFakeDatabase } from "./fakeDb.js";
import { normalizeCode, redeemPromo } from "./promo.js";

const JWT = "секрет-для-тестов-промокодов-достаточной-длины";

function promoDb(overrides: {
  promo?: Record<string, unknown> | null;
  total?: number;
  mine?: number;
  wallet?: { id: string; balance: string } | null;
}) {
  const inserted: Array<{ sql: string; values: readonly unknown[] }> = [];
  const database = createFakeDatabase({
    routes: [
      ["FROM promo_codes WHERE code", overrides.promo === null ? [] : [overrides.promo ?? {
        id: "promo-1",
        code: "WELCOME",
        chips: "5000",
        max_activations: 10,
        per_player: 1,
        starts_at: "2020-01-01T00:00:00Z",
        expires_at: null,
        is_active: true,
      }]],
      ["FROM promo_redemptions WHERE promo_id", [{ total: String(overrides.total ?? 0), mine: String(overrides.mine ?? 0) }]],
      ["FROM wallets WHERE player_id", overrides.wallet === null ? [] : [overrides.wallet ?? { id: "w1", balance: "1000" }]],
      ["INSERT INTO promo_redemptions", (v) => { inserted.push({ sql: "redemption", values: v }); return []; }],
      ["INSERT INTO ledger_entries", (v) => { inserted.push({ sql: "ledger", values: v }); return []; }],
      ["INSERT INTO audit_log", []],
    ],
  });
  return { database, inserted };
}

test("код нормализуется: регистр и пробелы не важны", () => {
  assert.equal(normalizeCode(" welcome 2026 "), "WELCOME2026");
  assert.equal(normalizeCode("Bonus"), "BONUS");
});

test("валидный код начисляет фишки и пишет проводку", async () => {
  const { database, inserted } = promoDb({});
  const result = await redeemPromo(database, "p1", " welcome ");
  assert.equal(result.ok, true);
  assert.equal(result.chips, 5000);
  assert.equal(result.balance, "6000");

  const ledger = inserted.find((i) => i.sql === "ledger");
  assert.ok(ledger, "должна появиться проводка");
  assert.equal(ledger!.values[1], "5000");
  assert.equal(ledger!.values[2], "6000", "баланс после начисления");
  assert.match(String(ledger!.values[3]), /^promo:promo-1:p1:1$/);
});

test("повторная активация тем же игроком отклоняется", async () => {
  const { database, inserted } = promoDb({ mine: 1 });
  const result = await redeemPromo(database, "p1", "WELCOME");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ALREADY_USED");
  assert.equal(inserted.length, 0, "ничего не начисляем");
});

test("исчерпанный лимит активаций отклоняется", async () => {
  const { database, inserted } = promoDb({ total: 10 });
  const result = await redeemPromo(database, "p2", "WELCOME");
  assert.equal(result.reason, "EXHAUSTED");
  assert.equal(inserted.length, 0);
});

test("просроченный, отключённый и будущий коды отклоняются", async () => {
  const expired = promoDb({ promo: {
    id: "p", code: "OLD", chips: "100", max_activations: null, per_player: 1,
    starts_at: "2020-01-01T00:00:00Z", expires_at: "2020-02-01T00:00:00Z", is_active: true,
  } });
  assert.equal((await redeemPromo(expired.database, "p1", "OLD")).reason, "EXPIRED");

  const off = promoDb({ promo: {
    id: "p", code: "OFF", chips: "100", max_activations: null, per_player: 1,
    starts_at: "2020-01-01T00:00:00Z", expires_at: null, is_active: false,
  } });
  assert.equal((await redeemPromo(off.database, "p1", "OFF")).reason, "INACTIVE");

  const future = promoDb({ promo: {
    id: "p", code: "SOON", chips: "100", max_activations: null, per_player: 1,
    starts_at: "2999-01-01T00:00:00Z", expires_at: null, is_active: true,
  } });
  assert.equal((await redeemPromo(future.database, "p1", "SOON")).reason, "NOT_STARTED");
});

test("неизвестный код отклоняется", async () => {
  const { database } = promoDb({ promo: null });
  assert.equal((await redeemPromo(database, "p1", "НЕТТАКОГО")).reason, "NOT_FOUND");
});

test("строка промокода блокируется до проверки лимита", async () => {
  // Без FOR UPDATE два одновременных запроса на последнюю активацию оба
  // прошли бы проверку и выдали фишки дважды.
  const { database } = promoDb({});
  await redeemPromo(database, "p1", "WELCOME");
  const select = database.calls.find((c) => c.sql.includes("FROM promo_codes WHERE code"));
  assert.match(select!.sql, /FOR UPDATE/, "выборка промокода обязана быть с блокировкой");
});

test("маршрут активации требует JWT и отдаёт понятные коды ошибок", async () => {
  const { database } = promoDb({ promo: null });
  const app = await buildApp({ jwtSecret: JWT, database });
  try {
    const anon = await app.inject({ method: "POST", url: "/api/v1/promo/redeem", payload: { code: "X" } });
    assert.equal(anon.statusCode, 401);

    const token = (app as unknown as { jwt: { sign: (p: object) => string } }).jwt.sign({ sub: "p1" });
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/promo/redeem",
      headers: { authorization: `Bearer ${token}` },
      payload: { code: "НЕТТАКОГО" },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().code, "NOT_FOUND");
    assert.match(missing.json().message, /нет/i);

    const empty = await app.inject({
      method: "POST",
      url: "/api/v1/promo/redeem",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    assert.equal(empty.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("создание промокода доступно только с админ-токеном", async () => {
  process.env.ADMIN_TOKEN = "admin-secret-for-test";
  const { database } = promoDb({});
  database.on("INSERT INTO promo_codes", [{ id: "new-1", code: "SUMMER" }]);
  const app = await buildApp({ jwtSecret: JWT, database });
  try {
    const forbidden = await app.inject({ method: "POST", url: "/api/v1/admin/promo", payload: { code: "SUMMER", chips: 100 } });
    assert.equal(forbidden.statusCode, 403);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/promo",
      headers: { "x-admin-token": "admin-secret-for-test" },
      payload: { code: "summer", chips: 100, maxActivations: 5 },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().code, "SUMMER");

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/admin/promo",
      headers: { "x-admin-token": "admin-secret-for-test" },
      payload: { code: "ab", chips: 100 },
    });
    assert.equal(bad.statusCode, 400, "слишком короткий код");
  } finally {
    await app.close();
    delete process.env.ADMIN_TOKEN;
  }
});

test("денежный режим не включается переменной окружения (T-214)", async () => {
  const { assertMoneyModeAllowed } = await import("./app.js");

  // Обычный режим — молчит
  assert.doesNotThrow(() => assertMoneyModeAllowed({} as NodeJS.ProcessEnv));
  assert.doesNotThrow(() => assertMoneyModeAllowed({ MONEY_MODE: "demo" } as NodeJS.ProcessEnv));

  // Попытка включить деньги без лицензии — отказ с объяснением
  assert.throws(
    () => assertMoneyModeAllowed({ MONEY_MODE: "real" } as NodeJS.ProcessEnv),
    /GAMBLING_LICENSE_ID/,
  );

  // Даже с номером лицензии: контура нет, поднимать сервер нельзя
  assert.throws(
    () => assertMoneyModeAllowed({ MONEY_MODE: "real", GAMBLING_LICENSE_ID: "123-Р" } as NodeJS.ProcessEnv),
    /не реализован/,
  );
});
