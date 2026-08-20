import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";

test("публичные маршруты API доступны без JWT", async () => {
  const app = await buildApp({ jwtSecret: "тестовый-секрет-достаточной-длины" });
  try {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: "ok" });

    const games = await app.inject({ method: "GET", url: "/api/v1/games" });
    assert.equal(games.statusCode, 200);
    assert.equal(games.json().games[0].code, "crown-of-fortune");
  } finally {
    await app.close();
  }
});

test("проверка раунда не требует JWT, а кошелёк требует", async () => {
  const app = await buildApp({ jwtSecret: "тестовый-секрет-достаточной-длины" });
  try {
    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/verify",
      payload: { serverSeed: "a".repeat(64), clientSeed: "player-seed", nonce: 0, gameCode: "crown-of-fortune" },
    });
    assert.equal(verify.statusCode, 200);
    assert.equal(verify.json().valid, true);

    const wallet = await app.inject({ method: "GET", url: "/api/v1/wallet" });
    assert.equal(wallet.statusCode, 401);
    assert.equal(wallet.json().code, "UNAUTHENTICATED");
  } finally {
    await app.close();
  }
});

test("проверка отклоняет неверную форму входа", async () => {
  const app = await buildApp({ jwtSecret: "тестовый-секрет-достаточной-длины" });
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/verify", payload: {} });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "VALIDATION_FAILED");
  } finally {
    await app.close();
  }
});

test("пустое тело при content-type json не превращается в 500 (T-189)", async () => {
  // Именно на этом ложился весь клиент: браузер шлёт POST /auth/demo
  // с заголовком application/json и без тела, Fastify отвечал ошибкой
  // парсера, а обработчик превращал её в 500 — токен не выдавался,
  // и спин был невозможен.
  const app = await buildApp({ jwtSecret: "тестовый-секрет-достаточной-длины" });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo",
      headers: { "content-type": "application/json" },
      payload: "",
    });
    assert.notEqual(res.statusCode, 500, res.body);
    // БД в этом тесте не подключена, поэтому ожидаем честный 503
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, "DATABASE_UNAVAILABLE");
  } finally {
    await app.close();
  }
});

test("битый JSON отдаёт 400, а не 500 (T-189)", async () => {
  const app = await buildApp({ jwtSecret: "тестовый-секрет-достаточной-длины" });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/verify",
      headers: { "content-type": "application/json" },
      payload: "{это не json",
    });
    assert.equal(res.statusCode, 400, res.body);
  } finally {
    await app.close();
  }
});

test("клиентские ошибки Fastify сохраняют свой код состояния (T-189)", async () => {
  const app = await buildApp({ jwtSecret: "тестовый-секрет-достаточной-длины" });
  try {
    const res = await app.inject({ method: "GET", url: "/api/v1/не-существует" });
    assert.equal(res.statusCode, 404, res.body);
  } finally {
    await app.close();
  }
});
