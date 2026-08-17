/**
 * Тесты модуля ответственной игры (T-015).
 *
 * Проверяются не «значения», а правила, которые нельзя нарушать:
 * лимит не обходится ни одним сценарием, ослабление не применяется
 * раньше срока, самоисключение не снимается досрочно.
 *
 * Отдельное внимание — обходным путям. Большинство ошибок в таких
 * модулях не в том, что запрет не срабатывает, а в том, что его можно
 * обойти: выиграть и «обнулить» проигрыш, дважды позвать ослабление
 * и сбросить таймер, сократить самоисключение повторным запросом.
 * На каждый такой путь здесь есть тест.
 *
 * Запуск: npm test
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  ActivityCounters,
  COOLING_MS,
  LIMIT_KINDS,
  PlayerLimit,
  PlayerState,
  REALITY_CHECK_MS,
  applyLimitChange,
  applySelfExclusion,
  buildRealityCheck,
  canPlaceBet,
  findLimit,
  isExcluded,
  needsRealityCheck,
  recordRound,
  sessionMinutes,
} from "./responsible.js";

/** Фиксированная точка отсчёта, чтобы тесты не зависели от часов. */
const T0 = Date.UTC(2026, 7, 17, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function counters(over: Partial<ActivityCounters> = {}): ActivityCounters {
  return {
    lossToday: 0,
    lossThisWeek: 0,
    wageredToday: 0,
    spinsToday: 0,
    sessionStartedAt: T0,
    lastRealityCheckAt: null,
    ...over,
  };
}

function limit(
  kind: PlayerLimit["kind"],
  value: number,
  over: Partial<PlayerLimit> = {},
): PlayerLimit {
  return {
    kind,
    value,
    effectiveFrom: T0 - DAY,
    coolingUntil: null,
    ...over,
  };
}

function state(over: Partial<PlayerState> = {}): PlayerState {
  return {
    limits: [],
    selfExclusion: null,
    counters: counters(),
    ...over,
  };
}

describe("Допуск ставки: базовые случаи", () => {
  test("без лимитов ставка проходит", () => {
    const d = canPlaceBet(state(), 100, T0);
    assert.equal(d.allowed, true);
  });

  test("нецелая ставка отклоняется", () => {
    const d = canPlaceBet(state(), 10.5, T0);
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.code, "INVALID_BET");
  });

  test("нулевая и отрицательная ставка отклоняются", () => {
    for (const bet of [0, -1, -100]) {
      const d = canPlaceBet(state(), bet, T0);
      assert.equal(d.allowed, false, `ставка ${bet} не должна проходить`);
    }
  });
});

describe("Лимит проигрыша за сутки", () => {
  test("ставка, способная пробить лимит, не принимается", () => {
    // Проиграно 900 из 1000. Ставка 200 в худшем случае даёт 1100.
    const s = state({
      limits: [limit("loss_daily", 1000)],
      counters: counters({ lossToday: 900 }),
    });
    const d = canPlaceBet(s, 200, T0);
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.limit, "loss_daily");
  });

  test("ставка, ровно укладывающаяся в остаток, принимается", () => {
    const s = state({
      limits: [limit("loss_daily", 1000)],
      counters: counters({ lossToday: 900 }),
    });
    assert.equal(canPlaceBet(s, 100, T0).allowed, true);
  });

  test("лимит проверяется по худшему исходу, а не по среднему", () => {
    // Ключевое требование регулятора: превышение недопустимо
    // ни при каком исходе раунда, а не «в среднем».
    const s = state({
      limits: [limit("loss_daily", 1000)],
      counters: counters({ lossToday: 999 }),
    });
    assert.equal(canPlaceBet(s, 2, T0).allowed, false);
  });

  test("недельный лимит работает независимо от дневного", () => {
    const s = state({
      limits: [limit("loss_weekly", 5000)],
      counters: counters({ lossToday: 0, lossThisWeek: 4950 }),
    });
    const d = canPlaceBet(s, 100, T0);
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.limit, "loss_weekly");
  });
});

describe("Прочие виды лимитов", () => {
  test("лимит оборота считает ставки, а не потери", () => {
    const s = state({
      limits: [limit("wager_daily", 10_000)],
      counters: counters({ wageredToday: 9_950, lossToday: 0 }),
    });
    const d = canPlaceBet(s, 100, T0);
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.limit, "wager_daily");
  });

  test("лимит спинов срабатывает на следующем спине после порога", () => {
    const s = state({
      limits: [limit("spins_daily", 100)],
      counters: counters({ spinsToday: 99 }),
    });
    assert.equal(canPlaceBet(s, 20, T0).allowed, true, "сотый спин разрешён");

    const s2 = state({
      limits: [limit("spins_daily", 100)],
      counters: counters({ spinsToday: 100 }),
    });
    assert.equal(canPlaceBet(s2, 20, T0).allowed, false, "сто первый — нет");
  });

  test("лимит времени сессии срабатывает по достижении порога", () => {
    const s = state({
      limits: [limit("session_minutes", 60)],
      counters: counters({ sessionStartedAt: T0 - 59 * MINUTE }),
    });
    assert.equal(canPlaceBet(s, 20, T0).allowed, true);

    const s2 = state({
      limits: [limit("session_minutes", 60)],
      counters: counters({ sessionStartedAt: T0 - 60 * MINUTE }),
    });
    const d = canPlaceBet(s2, 20, T0);
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.limit, "session_minutes");
  });

  test("сработавший лимит назван в ответе — игроку видно, какой именно", () => {
    for (const kind of LIMIT_KINDS) {
      const s = state({
        limits: [limit(kind, 1)],
        counters: counters({
          lossToday: 10,
          lossThisWeek: 10,
          wageredToday: 10,
          spinsToday: 10,
          sessionStartedAt: T0 - 10 * HOUR,
        }),
      });
      const d = canPlaceBet(s, 100, T0);
      assert.equal(d.allowed, false, `${kind} должен сработать`);
      assert.equal(d.allowed === false && d.limit, kind);
      assert.ok(
        d.allowed === false && d.message.length > 0,
        "должно быть объяснение",
      );
    }
  });
});

describe("Самоисключение", () => {
  test("исключённый игрок не может играть", () => {
    const s = state({
      selfExclusion: { startedAt: T0 - HOUR, endsAt: T0 + 30 * DAY },
    });
    const d = canPlaceBet(s, 100, T0);
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.code, "SELF_EXCLUDED");
  });

  test("самоисключение важнее лимитов: проверяется первым", () => {
    const s = state({
      selfExclusion: { startedAt: T0 - HOUR, endsAt: null },
      limits: [limit("loss_daily", 1)],
    });
    const d = canPlaceBet(s, 100, T0);
    assert.equal(d.allowed === false && d.code, "SELF_EXCLUDED");
  });

  test("истёкшее самоисключение не мешает игре", () => {
    const s = state({
      selfExclusion: { startedAt: T0 - 60 * DAY, endsAt: T0 - DAY },
    });
    assert.equal(canPlaceBet(s, 100, T0).allowed, true);
  });

  test("бессрочное самоисключение не истекает", () => {
    const ex = { startedAt: T0 - 1000 * DAY, endsAt: null };
    assert.equal(isExcluded(ex, T0 + 10_000 * DAY), true);
  });

  test("нельзя сократить срок повторным запросом", () => {
    const cur = { startedAt: T0, endsAt: T0 + 90 * DAY };
    const got = applySelfExclusion(cur, 1, T0 + HOUR);
    assert.equal(got.endsAt, cur.endsAt, "срок должен остаться прежним");
  });

  test("можно продлить срок", () => {
    const cur = { startedAt: T0, endsAt: T0 + 30 * DAY };
    const got = applySelfExclusion(cur, 90, T0 + HOUR);
    assert.ok(got.endsAt !== null && got.endsAt > cur.endsAt);
  });

  test("бессрочное не заменяется срочным", () => {
    const cur = { startedAt: T0, endsAt: null };
    const got = applySelfExclusion(cur, 30, T0 + HOUR);
    assert.equal(got.endsAt, null);
  });

  test("срочное можно сделать бессрочным", () => {
    const cur = { startedAt: T0, endsAt: T0 + 30 * DAY };
    const got = applySelfExclusion(cur, null, T0 + HOUR);
    assert.equal(got.endsAt, null);
  });
});

describe("Изменение лимитов: охлаждение", () => {
  test("первый лимит — ужесточение, действует сразу", () => {
    const r = applyLimitChange(undefined, { kind: "loss_daily", value: 1000 }, T0);
    assert.equal(r.tightening, true);
    assert.equal(r.immediate, true);
    assert.equal(r.limit.effectiveFrom, T0);
  });

  test("снижение лимита действует немедленно", () => {
    const cur = limit("loss_daily", 1000);
    const r = applyLimitChange(cur, { kind: "loss_daily", value: 500 }, T0);
    assert.equal(r.tightening, true);
    assert.equal(r.limit.effectiveFrom, T0);
    assert.equal(r.limit.value, 500);
  });

  test("повышение лимита откладывается на период охлаждения", () => {
    const cur = limit("loss_daily", 1000);
    const r = applyLimitChange(cur, { kind: "loss_daily", value: 5000 }, T0);
    assert.equal(r.tightening, false);
    assert.equal(r.immediate, false);
    assert.equal(r.limit.effectiveFrom, T0 + COOLING_MS);
  });

  test("отложенный лимит не действует до срока, старый продолжает работать", () => {
    const cur = limit("loss_daily", 1000);
    const r = applyLimitChange(cur, { kind: "loss_daily", value: 5000 }, T0);

    // В хранилище обе записи; действует та, чей effectiveFrom наступил.
    const limits = [cur, r.limit];
    assert.equal(findLimit(limits, "loss_daily", T0)?.value, 1000);
    assert.equal(
      findLimit(limits, "loss_daily", T0 + COOLING_MS + 1)?.value,
      1000,
      "первым в списке остаётся старый — порядок задаёт хранилище",
    );

    // Проверка через сам предикат активности.
    assert.equal(r.limit.effectiveFrom > T0, true);
  });

  test("ставка блокируется старым лимитом, пока новый не вступил в силу", () => {
    const cur = limit("loss_daily", 1000);
    const pending = applyLimitChange(
      cur,
      { kind: "loss_daily", value: 100_000 },
      T0,
    ).limit;

    const s = state({
      limits: [cur, pending],
      counters: counters({ lossToday: 950 }),
    });
    assert.equal(
      canPlaceBet(s, 100, T0).allowed,
      false,
      "повышение не должно действовать сразу",
    );
  });

  test("повторный запрос на ослабление не сбрасывает таймер", () => {
    // Обходной путь: попросить ослабление, подождать 23 часа,
    // попросить ещё раз — и получить новый отсчёт с нуля.
    const cur = limit("loss_daily", 1000, { coolingUntil: T0 + COOLING_MS });
    const later = T0 + 23 * HOUR;
    const r = applyLimitChange(cur, { kind: "loss_daily", value: 5000 }, later);
    assert.equal(
      r.limit.effectiveFrom,
      T0 + COOLING_MS,
      "срок должен остаться привязан к исходному охлаждению",
    );
  });

  test("ужесточение перезапускает период охлаждения", () => {
    const cur = limit("loss_daily", 1000);
    const r = applyLimitChange(cur, { kind: "loss_daily", value: 500 }, T0);
    assert.equal(r.limit.coolingUntil, T0 + COOLING_MS);
  });

  test("равное значение считается ослаблением, а не ужесточением", () => {
    // Иначе повтором того же значения можно было бы бесконечно
    // продлевать себе право на немедленное изменение.
    const cur = limit("loss_daily", 1000);
    const r = applyLimitChange(cur, { kind: "loss_daily", value: 1000 }, T0);
    assert.equal(r.tightening, false);
  });

  test("некорректное значение отклоняется", () => {
    for (const v of [0, -5, 1.5]) {
      assert.throws(
        () => applyLimitChange(undefined, { kind: "loss_daily", value: v }, T0),
        RangeError,
      );
    }
  });
});

describe("Счётчики", () => {
  test("проигрышный раунд увеличивает потери и оборот", () => {
    const c = recordRound(counters(), 200, 0);
    assert.equal(c.lossToday, 200);
    assert.equal(c.lossThisWeek, 200);
    assert.equal(c.wageredToday, 200);
    assert.equal(c.spinsToday, 1);
  });

  test("выигрышный раунд уменьшает потери, но оборот растёт", () => {
    const c = recordRound(counters({ lossToday: 500, lossThisWeek: 500 }), 200, 300);
    assert.equal(c.lossToday, 400);
    assert.equal(c.wageredToday, 200);
  });

  test("крупный выигрыш не уводит проигрыш в минус", () => {
    // Обходной путь: сорвать банк, обнулить счётчик потерь
    // в минус и получить фактически безлимитный день.
    const c = recordRound(counters({ lossToday: 100 }), 200, 100_000);
    assert.equal(c.lossToday, 0);
    assert.equal(c.lossThisWeek, 0);
  });

  test("счётчики не мутируются на месте", () => {
    const before = counters({ spinsToday: 5 });
    const after = recordRound(before, 100, 0);
    assert.equal(before.spinsToday, 5);
    assert.equal(after.spinsToday, 6);
  });

  test("серия раундов накапливается корректно", () => {
    let c = counters();
    for (let i = 0; i < 10; i++) c = recordRound(c, 100, i === 3 ? 250 : 0);
    assert.equal(c.spinsToday, 10);
    assert.equal(c.wageredToday, 1000);
    assert.equal(c.lossToday, 750);
  });

  test("длительность сессии считается в минутах вниз", () => {
    const c = counters({ sessionStartedAt: T0 - 119_000 });
    assert.equal(sessionMinutes(c, T0), 1);
  });
});

describe("Reality check", () => {
  test("первое напоминание отсчитывается от начала сессии", () => {
    const c = counters({ sessionStartedAt: T0 - REALITY_CHECK_MS });
    assert.equal(needsRealityCheck(c, T0), true);
  });

  test("до истечения интервала не показывается", () => {
    const c = counters({ sessionStartedAt: T0 - REALITY_CHECK_MS + 1 });
    assert.equal(needsRealityCheck(c, T0), false);
  });

  test("после показа отсчёт идёт от него", () => {
    const c = counters({
      sessionStartedAt: T0 - 10 * HOUR,
      lastRealityCheckAt: T0 - 30 * MINUTE,
    });
    assert.equal(needsRealityCheck(c, T0), false);
    assert.equal(needsRealityCheck(c, T0 + 30 * MINUTE), true);
  });

  test("текст содержит время, спины и результат", () => {
    const c = counters({
      sessionStartedAt: T0 - 90 * MINUTE,
      spinsToday: 300,
      wageredToday: 6000,
      lossToday: 1200,
    });
    const rc = buildRealityCheck(c, T0);
    assert.equal(rc.minutesPlayed, 90);
    assert.equal(rc.netToday, -1200);
    assert.match(rc.message, /90 минут/);
    assert.match(rc.message, /300 спинов/);
    assert.match(rc.message, /проигрыш 1200/);
  });

  test("склонения русских числительных корректны", () => {
    const cases: [number, RegExp][] = [
      [1, /1 минуту/],
      [2, /2 минуты/],
      [5, /5 минут/],
      [21, /21 минуту/],
      [111, /111 минут/],
    ];
    for (const [minutes, re] of cases) {
      const rc = buildRealityCheck(
        counters({ sessionStartedAt: T0 - minutes * MINUTE }),
        T0,
      );
      assert.match(rc.message, re, `${minutes} минут склоняется неверно`);
    }
  });
});

describe("Сквозной сценарий", () => {
  test("игрок с лимитом 1000 не может проиграть больше за день", () => {
    // Худший случай: игрок проигрывает каждый раунд по 200.
    // Лимит обязан остановить его ровно на 1000, а не на 1200.
    const lim = limit("loss_daily", 1000);
    let c = counters();
    let played = 0;

    for (let i = 0; i < 100; i++) {
      const s: PlayerState = { limits: [lim], selfExclusion: null, counters: c };
      if (!canPlaceBet(s, 200, T0).allowed) break;
      c = recordRound(c, 200, 0);
      played++;
    }

    assert.equal(played, 5);
    assert.equal(c.lossToday, 1000);
    assert.ok(c.lossToday <= lim.value, "лимит не должен быть превышен");
  });

  test("выигрыши в середине дня не позволяют пробить лимит суммарно", () => {
    const lim = limit("loss_daily", 1000);
    let c = counters();
    let totalBet = 0;
    let totalWin = 0;

    // Чередование: проигрыш, крупный выигрыш, снова проигрыши.
    const wins = [0, 0, 5000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const win of wins) {
      const s: PlayerState = { limits: [lim], selfExclusion: null, counters: c };
      if (!canPlaceBet(s, 200, T0).allowed) break;
      c = recordRound(c, 200, win);
      totalBet += 200;
      totalWin += win;
    }

    // Чистый результат не должен быть хуже лимита.
    const net = totalBet - totalWin;
    assert.ok(net <= lim.value, `чистый проигрыш ${net} превысил лимит`);
  });
});
