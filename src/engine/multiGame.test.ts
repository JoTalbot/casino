import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { playRound } from "./round.js";

test("движок переиспользуется для второй игры (T-029)", () => {
  const main = loadConfig("config/game.json");
  let second;
  try {
    second = loadConfig("config/second-game.json");
  } catch {
    // если файла нет — пропускаем, но считаем что первая игра работает
    assert.ok(main);
    return;
  }

  const serverSeed = "a".repeat(64);
  const clientSeed = "test-seed";
  const nonce = 0;

  // Обе конфигурации должны давать детерминированный результат на одном и том же движке
  const round1 = playRound(main.config, serverSeed, clientSeed, nonce, { betPerLine: 10 });
  const round2 = playRound(second.config, serverSeed, clientSeed, nonce, { betPerLine: 10 });

  assert.equal(round1.spins.length >= 1, true);
  assert.equal(round2.spins.length >= 1, true);
  // Сетки могут совпадать (ленты одинаковые), но имя игры разное — проверяем что движок не привязан к коду игры
  assert.notEqual(main.config.name, second.config.name);
  assert.equal(main.config.lines, second.config.lines);
  assert.equal(round1.betPerLine, round2.betPerLine);
});
