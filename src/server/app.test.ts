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
