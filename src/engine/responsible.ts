/**
 * Модуль ответственной игры (T-015): лимиты, самоисключение, reality check.
 *
 * Здесь только чистая логика решений. Никакого доступа к БД, времени и
 * сети: всё состояние приходит аргументом, текущее время — параметром.
 * Причина не в академизме, а в проверяемости — правила ответственной
 * игры это последнее место, где допустима формулировка «вроде работает».
 * Хранение описано в `db/schema.sql` (`player_limits`, `self_exclusions`,
 * `sessions`), транспорт — в `docs/API.md` §3.7.
 *
 * Три правила, ради которых всё написано:
 *
 *  1. **Ужесточение немедленно, ослабление через охлаждение.** Игрок в
 *     азарте не должен иметь возможности поднять себе лимит одним
 *     кликом. Снижение применяется сразу, повышение — через 24 часа.
 *  2. **Самоисключение необратимо** до истечения срока. Ни игрок, ни
 *     поддержка не снимают его досрочно.
 *  3. **Проверка ДО списания ставки.** Лимит, проверенный после
 *     списания, уже нарушен.
 *
 * Все суммы — целые числа в минорных единицах (кредитах), как в БД.
 * Время — миллисекунды Unix, чтобы не тащить зависимости.
 */

/** Виды лимитов. Совпадает с ENUM `limit_kind` в `db/schema.sql`. */
export type LimitKind =
  | "loss_daily"
  | "loss_weekly"
  | "wager_daily"
  | "session_minutes"
  | "spins_daily";

export const LIMIT_KINDS: readonly LimitKind[] = [
  "loss_daily",
  "loss_weekly",
  "wager_daily",
  "session_minutes",
  "spins_daily",
];

/** Период охлаждения перед ослаблением лимита: 24 часа. */
export const COOLING_MS = 24 * 60 * 60 * 1000;

/** Интервал напоминания о времени в игре по умолчанию: 60 минут. */
export const REALITY_CHECK_MS = 60 * 60 * 1000;

/** Действующий лимит игрока. */
export interface PlayerLimit {
  kind: LimitKind;
  /** Порог: кредиты для денежных видов, минуты и спины для остальных. */
  value: number;
  /** С какого момента лимит действует. */
  effectiveFrom: number;
  /** До какого момента запрещено ослабление; null — можно сразу. */
  coolingUntil: number | null;
}

/** Запрос на изменение лимита. */
export interface LimitChange {
  kind: LimitKind;
  value: number;
}

/** Самоисключение. `endsAt: null` — бессрочное. */
export interface SelfExclusion {
  startedAt: number;
  endsAt: number | null;
}

/**
 * Счётчики активности игрока.
 *
 * Считаются по журналу (`ledger_entries`, `rounds`) за календарные
 * окна в часовом поясе оператора, а не «за последние 24 часа»:
 * игрок должен понимать, когда лимит обнулится.
 */
export interface ActivityCounters {
  /** Чистый проигрыш за текущие сутки: ставки минус выигрыши, ≥ 0. */
  lossToday: number;
  /** Чистый проигрыш за текущую неделю. */
  lossThisWeek: number;
  /** Оборот ставок за текущие сутки. */
  wageredToday: number;
  /** Сыграно раундов за текущие сутки. */
  spinsToday: number;
  /** Начало текущей сессии. */
  sessionStartedAt: number;
  /** Когда последний раз показывали reality check. */
  lastRealityCheckAt: number | null;
}

/** Состояние игрока, достаточное для всех решений модуля. */
export interface PlayerState {
  limits: PlayerLimit[];
  selfExclusion: SelfExclusion | null;
  counters: ActivityCounters;
}

/** Причина отказа. Коды совпадают с `docs/API.md` §2. */
export type DenyCode =
  | "SELF_EXCLUDED"
  | "LIMIT_EXCEEDED"
  | "INVALID_BET";

/** Решение о допуске ставки. */
export type Decision =
  | { allowed: true }
  | {
      allowed: false;
      code: DenyCode;
      /** Какой именно лимит сработал; отсутствует для прочих отказов. */
      limit?: LimitKind;
      /** Человекочитаемое объяснение для игрока (русский, ADR-003). */
      message: string;
      /** Когда ограничение снимется само; null — не снимется. */
      retryAt?: number | null;
    };

const ALLOWED: Decision = { allowed: true };

/** Денежные лимиты, значение которых — сумма в кредитах. */
const MONETARY: ReadonlySet<LimitKind> = new Set<LimitKind>([
  "loss_daily",
  "loss_weekly",
  "wager_daily",
]);

/**
 * Активен ли лимит на момент `now`.
 *
 * Лимит с `effectiveFrom` в будущем — это отложенное ослабление,
 * которое ещё не вступило в силу.
 */
export function isLimitActive(limit: PlayerLimit, now: number): boolean {
  return limit.effectiveFrom <= now;
}

/** Находит действующий лимит указанного вида. */
export function findLimit(
  limits: readonly PlayerLimit[],
  kind: LimitKind,
  now: number,
): PlayerLimit | undefined {
  return limits.find((l) => l.kind === kind && isLimitActive(l, now));
}

/** Действует ли самоисключение прямо сейчас. */
export function isExcluded(
  exclusion: SelfExclusion | null,
  now: number,
): boolean {
  if (!exclusion) return false;
  if (exclusion.startedAt > now) return false;
  return exclusion.endsAt === null || exclusion.endsAt > now;
}

/** Длительность текущей сессии в минутах. */
export function sessionMinutes(counters: ActivityCounters, now: number): number {
  return Math.max(0, Math.floor((now - counters.sessionStartedAt) / 60_000));
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/**
 * Можно ли принять ставку.
 *
 * Вызывается ДО списания. `totalBet` — полная ставка за раунд
 * (ставка на линию × число линий), в кредитах.
 *
 * Денежные лимиты проверяются с учётом будущей ставки: если раунд
 * способен пробить порог в худшем случае (полный проигрыш), он не
 * принимается. Это строже, чем «остановиться по факту превышения»,
 * и именно так требуют регуляторы: лимит потерь не должен быть
 * превышен ни при каком исходе.
 */
export function canPlaceBet(
  state: PlayerState,
  totalBet: number,
  now: number,
): Decision {
  if (!Number.isInteger(totalBet) || totalBet <= 0) {
    return {
      allowed: false,
      code: "INVALID_BET",
      message: "Ставка должна быть целым положительным числом кредитов.",
    };
  }

  if (isExcluded(state.selfExclusion, now)) {
    const endsAt = state.selfExclusion!.endsAt;
    return {
      allowed: false,
      code: "SELF_EXCLUDED",
      message:
        endsAt === null
          ? "Действует бессрочное самоисключение. Игра недоступна."
          : "Действует самоисключение. Игра будет доступна после его окончания.",
      retryAt: endsAt,
    };
  }

  const { counters, limits } = state;

  // Лимит проигрыша за сутки: худший исход раунда — потерять всю ставку.
  const lossDaily = findLimit(limits, "loss_daily", now);
  if (lossDaily && counters.lossToday + totalBet > lossDaily.value) {
    return {
      allowed: false,
      code: "LIMIT_EXCEEDED",
      limit: "loss_daily",
      message:
        `Дневной лимит проигрыша ${lossDaily.value} кредитов почти достигнут ` +
        `(сейчас ${counters.lossToday}). Ставка ${totalBet} не принята.`,
      retryAt: null,
    };
  }

  const lossWeekly = findLimit(limits, "loss_weekly", now);
  if (lossWeekly && counters.lossThisWeek + totalBet > lossWeekly.value) {
    return {
      allowed: false,
      code: "LIMIT_EXCEEDED",
      limit: "loss_weekly",
      message:
        `Недельный лимит проигрыша ${lossWeekly.value} кредитов почти достигнут ` +
        `(сейчас ${counters.lossThisWeek}). Ставка ${totalBet} не принята.`,
      retryAt: null,
    };
  }

  // Лимит оборота: ставка увеличивает оборот при любом исходе.
  const wagerDaily = findLimit(limits, "wager_daily", now);
  if (wagerDaily && counters.wageredToday + totalBet > wagerDaily.value) {
    return {
      allowed: false,
      code: "LIMIT_EXCEEDED",
      limit: "wager_daily",
      message:
        `Дневной лимит ставок ${wagerDaily.value} кредитов исчерпан ` +
        `(поставлено ${counters.wageredToday}).`,
      retryAt: null,
    };
  }

  const spinsDaily = findLimit(limits, "spins_daily", now);
  if (spinsDaily && counters.spinsToday + 1 > spinsDaily.value) {
    return {
      allowed: false,
      code: "LIMIT_EXCEEDED",
      limit: "spins_daily",
      message:
        `Дневной лимит ${spinsDaily.value} ` +
        `${plural(spinsDaily.value, "спин", "спина", "спинов")} исчерпан.`,
      retryAt: null,
    };
  }

  const sessionLimit = findLimit(limits, "session_minutes", now);
  if (sessionLimit) {
    const played = sessionMinutes(counters, now);
    if (played >= sessionLimit.value) {
      return {
        allowed: false,
        code: "LIMIT_EXCEEDED",
        limit: "session_minutes",
        message:
          `Лимит длительности сессии ${sessionLimit.value} ` +
          `${plural(sessionLimit.value, "минута", "минуты", "минут")} исчерпан. ` +
          `Сделайте перерыв.`,
        retryAt: null,
      };
    }
  }

  return ALLOWED;
}

/** Результат применения изменения лимита. */
export interface LimitApplication {
  /** Лимит, каким он станет в хранилище. */
  limit: PlayerLimit;
  /** Ужесточение (немедленно) или ослабление (отложено). */
  tightening: boolean;
  /** Вступает в силу немедленно? */
  immediate: boolean;
  /** Пояснение для игрока. */
  message: string;
}

/**
 * Применяет запрос на изменение лимита.
 *
 * Ужесточение — это уменьшение значения (для всех видов лимитов
 * меньшее значение строже). Оно вступает в силу немедленно и
 * заново запускает период охлаждения: игрок, только что снизивший
 * лимит, не может передумать через минуту.
 *
 * Ослабление откладывается на `COOLING_MS`. Старый лимит продолжает
 * действовать всё это время — здесь возвращается запись с
 * `effectiveFrom` в будущем, вызывающий код обязан сохранить её,
 * не удаляя текущую (см. `docs/API.md` §3.7).
 *
 * Установка первого лимита считается ужесточением: до неё
 * ограничения не было вовсе.
 */
export function applyLimitChange(
  current: PlayerLimit | undefined,
  change: LimitChange,
  now: number,
  coolingMs: number = COOLING_MS,
): LimitApplication {
  if (!Number.isInteger(change.value) || change.value <= 0) {
    throw new RangeError("Значение лимита должно быть целым положительным");
  }

  const tightening = current === undefined || change.value < current.value;

  if (tightening) {
    return {
      limit: {
        kind: change.kind,
        value: change.value,
        effectiveFrom: now,
        coolingUntil: now + coolingMs,
      },
      tightening: true,
      immediate: true,
      message: "Лимит снижен и действует немедленно.",
    };
  }

  // Ослабление: отложено на период охлаждения. Отсчёт идёт от
  // coolingUntil действующего лимита, если тот ещё не истёк, —
  // иначе повторными запросами можно было бы сбрасывать таймер.
  const base = Math.max(now, current.coolingUntil ?? now);
  const effectiveFrom = base === now ? now + coolingMs : base;

  return {
    limit: {
      kind: change.kind,
      value: change.value,
      effectiveFrom,
      coolingUntil: effectiveFrom + coolingMs,
    },
    tightening: false,
    immediate: false,
    message:
      "Повышение лимита вступит в силу после периода охлаждения. " +
      "До этого момента действует прежний лимит.",
  };
}

/**
 * Нужно ли показать reality check.
 *
 * Напоминание о времени в игре: сколько игрок играет, сколько поставил
 * и сколько потерял. Показывается по таймеру от последнего показа, а
 * при первом срабатывании — от начала сессии.
 */
export function needsRealityCheck(
  counters: ActivityCounters,
  now: number,
  intervalMs: number = REALITY_CHECK_MS,
): boolean {
  const since = counters.lastRealityCheckAt ?? counters.sessionStartedAt;
  return now - since >= intervalMs;
}

/** Содержимое напоминания. */
export interface RealityCheck {
  minutesPlayed: number;
  spinsToday: number;
  wageredToday: number;
  /** Чистый результат сессии: положительный — выигрыш, отрицательный — проигрыш. */
  netToday: number;
  message: string;
}

/**
 * Собирает текст напоминания.
 *
 * Формулировки намеренно нейтральные и без «почти повезло»: цель
 * напоминания — вернуть игроку чувство времени и суммы, а не
 * подтолкнуть к следующей ставке.
 */
export function buildRealityCheck(
  counters: ActivityCounters,
  now: number,
): RealityCheck {
  const minutes = sessionMinutes(counters, now);
  const net = -counters.lossToday;
  const verdict =
    net < 0
      ? `проигрыш ${Math.abs(net)} кредитов`
      : net > 0
        ? `выигрыш ${net} кредитов`
        : "результат в ноль";

  return {
    minutesPlayed: minutes,
    spinsToday: counters.spinsToday,
    wageredToday: counters.wageredToday,
    netToday: net,
    message:
      `Вы играете ${minutes} ${plural(minutes, "минуту", "минуты", "минут")}. ` +
      `Сегодня: ${counters.spinsToday} ` +
      `${plural(counters.spinsToday, "спин", "спина", "спинов")}, ` +
      `поставлено ${counters.wageredToday} кредитов, ${verdict}.`,
  };
}

/**
 * Обновляет счётчики после сыгранного раунда.
 *
 * Возвращает новый объект, состояние не мутируется: счётчики попадают
 * и в решение о следующей ставке, и в аудит, поэтому неизменяемость
 * здесь дешевле отладки.
 *
 * Проигрыш считается неотрицательным: выигрышный раунд уменьшает
 * накопленный проигрыш, но не уводит его ниже нуля. Иначе крупный
 * выигрыш в начале дня снял бы лимит потерь на весь день.
 */
export function recordRound(
  counters: ActivityCounters,
  totalBet: number,
  totalWin: number,
): ActivityCounters {
  const delta = totalBet - totalWin;
  return {
    ...counters,
    lossToday: Math.max(0, counters.lossToday + delta),
    lossThisWeek: Math.max(0, counters.lossThisWeek + delta),
    wageredToday: counters.wageredToday + totalBet,
    spinsToday: counters.spinsToday + 1,
  };
}

/**
 * Создаёт самоисключение.
 *
 * `durationDays = null` — бессрочно. Продлить можно всегда, сократить
 * или снять досрочно — нельзя: попытка вернёт прежнее самоисключение.
 */
export function applySelfExclusion(
  current: SelfExclusion | null,
  durationDays: number | null,
  now: number,
): SelfExclusion {
  const requested: SelfExclusion = {
    startedAt: now,
    endsAt: durationDays === null ? null : now + durationDays * 24 * 60 * 60 * 1000,
  };

  if (!isExcluded(current, now)) return requested;

  // Уже исключён: разрешено только удлинение.
  const cur = current!;
  if (cur.endsAt === null) return cur; // бессрочное не сократить
  if (requested.endsAt === null) return { startedAt: cur.startedAt, endsAt: null };
  return requested.endsAt > cur.endsAt
    ? { startedAt: cur.startedAt, endsAt: requested.endsAt }
    : cur;
}
