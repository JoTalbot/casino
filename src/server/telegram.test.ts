/**
 * Тесты аутентификации Telegram Mini App (T-197).
 *
 * Подпись initData — единственное, что отделяет настоящего пользователя
 * Telegram от любого, кто открыл наш URL в браузере. Поэтому здесь
 * проверяются не только удачные случаи, но и каждый способ обойти проверку.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { buildApp } from "./app.js";
import { createFakeDatabase } from "./fakeDb.js";
import { TelegramAuthError, playerNameFor, replyForUpdate, verifyInitData } from "./telegram.js";

const BOT_TOKEN = "123456:TEST-TOKEN-НЕ-НАСТОЯЩИЙ";

/** Собирает валидный initData так же, как это делает Telegram. */
function makeInitData(
  user: Record<string, unknown>,
  authDate = Math.floor(Date.now() / 1000),
  token = BOT_TOKEN,
): string {
  const params = new URLSearchParams({
    query_id: "AAF_test",
    user: JSON.stringify(user),
    auth_date: String(authDate),
  });
  const checkString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(checkString).digest("hex"));
  return params.toString();
}

test("валидный initData разбирается в пользователя", () => {
  const initData = makeInitData({ id: 4242, username: "Player_One", first_name: "Иван", language_code: "ru" });
  const user = verifyInitData(initData, BOT_TOKEN);
  assert.equal(user.id, 4242);
  assert.equal(user.username, "Player_One");
  assert.equal(user.languageCode, "ru");
});

test("подделанная подпись отклоняется", () => {
  const initData = makeInitData({ id: 1 }, undefined, "чужой-токен");
  assert.throws(() => verifyInitData(initData, BOT_TOKEN), (e: unknown) => {
    assert.ok(e instanceof TelegramAuthError);
    assert.equal((e as TelegramAuthError).code, "INIT_DATA_BAD_SIGNATURE");
    return true;
  });
});

test("подменённые данные при валидной подписи отклоняются", () => {
  // Классическая атака: взять чужой initData и подставить свой id
  const initData = makeInitData({ id: 1, username: "honest" });
  const tampered = initData.replace("%22id%22%3A1", "%22id%22%3A999");
  assert.notEqual(tampered, initData);
  assert.throws(() => verifyInitData(tampered, BOT_TOKEN), /подпись|Подпись/i);
});

test("просроченный initData отклоняется", () => {
  const old = Math.floor(Date.now() / 1000) - 48 * 3600;
  const initData = makeInitData({ id: 7 }, old);
  assert.throws(() => verifyInitData(initData, BOT_TOKEN), (e: unknown) => {
    assert.equal((e as TelegramAuthError).code, "INIT_DATA_EXPIRED");
    return true;
  });
});

test("пустой initData и отсутствие подписи отклоняются", () => {
  assert.throws(() => verifyInitData("", BOT_TOKEN), /пуст/i);
  assert.throws(() => verifyInitData("user=%7B%22id%22%3A1%7D&auth_date=1", BOT_TOKEN), /подпис/i);
});

test("имя игрока безопасно и уникально по telegram id", () => {
  const a = playerNameFor({ id: 10, username: "Крутой Игрок!" });
  const b = playerNameFor({ id: 11, username: "Крутой Игрок!" });
  assert.match(a, /^tg_[a-z0-9_]*_[a-z0-9]+$/);
  assert.notEqual(a, b, "разные аккаунты Telegram не должны совпасть по имени");
});

test("маршрут входа отвечает 503 без настроенного бота", async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  const app = await buildApp({ jwtSecret: "секрет-для-тестов-telegram-достаточной-длины" });
  try {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/telegram", payload: { initData: "x" } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, "TELEGRAM_NOT_CONFIGURED");
  } finally {
    await app.close();
  }
});

test("маршрут входа выдаёт JWT по валидной подписи", async () => {
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  const database = createFakeDatabase({
    routes: [
      ["SELECT id, username FROM players WHERE telegram_id", []],
      ["INSERT INTO players", [{ id: "p-tg-1" }]],
      ["INSERT INTO wallets", [{ id: "w-tg-1" }]],
      ["INSERT INTO ledger_entries", []],
      ["INSERT INTO audit_log", []],
      [
        "FROM seed_pairs",
        [{
          id: "s1",
          server_seed: "a".repeat(64),
          server_seed_hash: "b".repeat(64),
          client_seed: "c".repeat(16),
          next_nonce: "0",
          status: "active",
          created_at: "2026-08-20T00:00:00Z",
          revealed_at: null,
        }],
      ],
      ["SELECT balance FROM wallets", [{ balance: "100000" }]],
    ],
  });
  const app = await buildApp({ jwtSecret: "секрет-для-тестов-telegram-достаточной-длины", database });
  try {
    const initData = makeInitData({ id: 555, username: "tester", language_code: "ru" });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/telegram", payload: { initData } });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.telegramId, 555);
    assert.ok(body.token, "должен вернуться JWT");
    assert.equal(body.wallet.balance, "100000");

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/telegram",
      payload: { initData: makeInitData({ id: 555 }, undefined, "не-тот-токен") },
    });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json().code, "INIT_DATA_BAD_SIGNATURE");
  } finally {
    await app.close();
    delete process.env.TELEGRAM_BOT_TOKEN;
  }
});

test("бот отвечает на /start кнопкой запуска игры", () => {
  const url = "https://example.org/parts/casino/";
  const start = replyForUpdate({ message: { chat: { id: 5 }, text: "/start", from: { first_name: "Иван" } } }, url);
  assert.ok(start);
  assert.equal(start!.chatId, 5);
  assert.equal(start!.webAppUrl, url);
  assert.match(start!.text, /Иван/);
  assert.match(start!.text, /виртуальных фишках/);

  const help = replyForUpdate({ message: { chat: { id: 5 }, text: "/help" } }, url);
  assert.match(help!.text, /\/start/);

  const other = replyForUpdate({ message: { chat: { id: 5 }, text: "привет" } }, url);
  assert.match(other!.text, /Не понял/);

  // Обновление без чата игнорируется, а не роняет обработчик
  assert.equal(replyForUpdate({}, url), null);
});
