/**
 * Тесты выдачи ачивок и хранения push-подписок (T-178, T-179).
 * Работают на стабе БД — без PostgreSQL.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { checkAndUnlockAchievements } from "./achievements.js";
import { createFakeDatabase } from "./fakeDb.js";
import { getSubscriptions, resetPushMemory, subscribePush, unsubscribePush } from "./push.js";

test("первая победа открывается один раз и начисляет награду", async () => {
  let unlockedRows = 0;
  const database = createFakeDatabase({
    routes: [
      ["FROM player_achievements pa JOIN achievements a", () => (unlockedRows ? [{ code: "first_win" }] : [])],
      ["SELECT id, reward FROM achievements WHERE code", [{ id: "a1", reward: "100" }]],
      [
        "INSERT INTO player_achievements",
        () => {
          unlockedRows += 1;
          return [{ player_id: "p1" }];
        },
      ],
      ["FROM wallets WHERE player_id", [{ id: "w1", balance: "1000" }]],
      ["INSERT INTO ledger_entries", []],
    ],
  });

  const first = await checkAndUnlockAchievements(database, "p1", { type: "win", totalWin: 250 });
  assert.deepEqual(first, ["first_win"]);

  // Проводка на 100 фишек с итоговым балансом 1100 и идемпотентным ключом
  const ledger = database.calls.find((c) => c.sql.includes("INSERT INTO ledger_entries"));
  assert.ok(ledger, "ожидалась проводка награды");
  assert.equal(ledger!.values[1], "100");
  assert.equal(ledger!.values[2], "1100");
  assert.equal(ledger!.values[3], "ach:p1:first_win");

  // Повторный вызов не открывает ачивку второй раз
  const second = await checkAndUnlockAchievements(database, "p1", { type: "win", totalWin: 250 });
  assert.deepEqual(second, []);
});

test("параллельная вставка не даёт выдать награду дважды", async () => {
  const database = createFakeDatabase({
    routes: [
      ["FROM player_achievements pa JOIN achievements a", []],
      ["SELECT id, reward FROM achievements WHERE code", [{ id: "a1", reward: "100" }]],
      // ON CONFLICT DO NOTHING: строка не вставилась — значит, успел кто-то другой
      ["INSERT INTO player_achievements", []],
      ["FROM wallets WHERE player_id", [{ id: "w1", balance: "1000" }]],
    ],
  });

  const unlocked = await checkAndUnlockAchievements(database, "p1", { type: "win", totalWin: 250 });
  assert.deepEqual(unlocked, []);
  assert.equal(
    database.calls.some((c) => c.sql.includes("INSERT INTO ledger_entries")),
    false,
    "награда не должна начисляться, если ачивка уже была открыта",
  );
});

test("сотня спинов открывается только после 100 раундов", async () => {
  function build(count: string) {
    return createFakeDatabase({
      routes: [
        ["FROM player_achievements pa JOIN achievements a", []],
        ["SELECT COUNT(*) as c FROM rounds", [{ c: count }]],
        ["SELECT id, reward FROM achievements WHERE code", [{ id: "a3", reward: "1000" }]],
        ["INSERT INTO player_achievements", [{ player_id: "p1" }]],
        ["FROM wallets WHERE player_id", [{ id: "w1", balance: "0" }]],
        ["INSERT INTO ledger_entries", []],
      ],
    });
  }

  assert.deepEqual(await checkAndUnlockAchievements(build("99"), "p1", { type: "spin" }), []);
  assert.deepEqual(await checkAndUnlockAchievements(build("100"), "p1", { type: "spin" }), ["hundred_spins"]);
});

test("push-подписки сохраняются в БД и снимаются при отписке", async () => {
  const rows: Array<{ endpoint: string; p256dh: string; auth: string; created_at: string; revoked: boolean }> = [];
  const database = createFakeDatabase({
    routes: [
      [
        "INSERT INTO push_subscriptions",
        (values) => {
          const [, endpoint, p256dh, auth] = values as string[];
          const existing = rows.find((r) => r.endpoint === endpoint);
          if (existing) Object.assign(existing, { p256dh, auth, revoked: false });
          else rows.push({ endpoint, p256dh, auth, created_at: "2026-08-20T00:00:00Z", revoked: false });
          return [];
        },
      ],
      [
        "UPDATE push_subscriptions SET revoked_at",
        (values) => {
          const row = rows.find((r) => r.endpoint === values[0]);
          if (row) row.revoked = true;
          return [];
        },
      ],
      ["FROM push_subscriptions", () => rows.filter((r) => !r.revoked)],
    ],
  });

  const sub = { endpoint: "https://push.example/a", keys: { p256dh: "k", auth: "a" } };
  await subscribePush("p1", sub, database);
  await subscribePush("p1", sub, database);
  assert.equal((await getSubscriptions("p1", database)).length, 1, "повтор не должен дублировать подписку");

  await unsubscribePush(sub.endpoint, database);
  assert.equal((await getSubscriptions("p1", database)).length, 0);
});

test("без БД push-подписки живут в памяти процесса", async () => {
  resetPushMemory();
  await subscribePush("p2", { endpoint: "https://push.example/b", keys: { p256dh: "k", auth: "a" } });
  assert.equal((await getSubscriptions("p2")).length, 1);
  await unsubscribePush("https://push.example/b");
  assert.equal((await getSubscriptions("p2")).length, 0);
});
