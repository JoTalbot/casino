/** Сервис ответственной игры, считающий счётчики из БД (T-027) */
import type { Database } from "./db.js";
import {
  LIMIT_KINDS,
  type ActivityCounters,
  type LimitKind,
  type PlayerLimit,
  type PlayerState,
  type SelfExclusion,
  COOLING_MS,
  applyLimitChange,
  applySelfExclusion,
  isExcluded,
} from "../engine/responsible.js";

function toPlayerLimit(row: {
  kind: string;
  value: string;
  effective_from: string;
  cooling_until: string | null;
}): PlayerLimit {
  return {
    kind: row.kind as LimitKind,
    value: Number(row.value),
    effectiveFrom: new Date(row.effective_from).getTime(),
    coolingUntil: row.cooling_until ? new Date(row.cooling_until).getTime() : null,
  };
}

function toSelfExclusion(row: { started_at: string; ends_at: string | null } | undefined): SelfExclusion | null {
  if (!row) return null;
  return {
    startedAt: new Date(row.started_at).getTime(),
    endsAt: row.ends_at ? new Date(row.ends_at).getTime() : null,
  };
}

export async function getPlayerState(database: Database, playerId: string, now = Date.now()): Promise<PlayerState> {
  // Лимиты
  const limitsRes = await database.query<{
    kind: string;
    value: string;
    effective_from: string;
    cooling_until: string | null;
  }>(
    `SELECT kind, value, effective_from, cooling_until
     FROM player_limits
     WHERE player_id = $1 AND revoked_at IS NULL AND effective_from <= now()
     ORDER BY effective_from DESC`,
    [playerId],
  );

  const limitsMap = new Map<LimitKind, PlayerLimit>();
  for (const row of limitsRes.rows) {
    const pl = toPlayerLimit(row);
    if (!limitsMap.has(pl.kind)) limitsMap.set(pl.kind, pl);
  }
  const limits = Array.from(limitsMap.values());

  // Самоисключение — последняя запись, если активна
  const seRes = await database.query<{ started_at: string; ends_at: string | null }>(
    `SELECT started_at, ends_at FROM self_exclusions
     WHERE player_id = $1
     ORDER BY started_at DESC LIMIT 1`,
    [playerId],
  );
  let selfExclusion: SelfExclusion | null = toSelfExclusion(seRes.rows[0]);
  if (selfExclusion && !isExcluded(selfExclusion, now)) {
    selfExclusion = null;
  }

  // Счётчики из БД (T-027 — календарные окна из ledger/rounds, а не из памяти)
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(dayStart);
  weekStart.setUTCDate(dayStart.getUTCDate() - 6); // 7 дней включая сегодня

  const countersRes = await database.query<{
    loss_today: string | null;
    wager_today: string | null;
    spins_today: string | null;
    loss_week: string | null;
  }>(
    `SELECT
       SUM(CASE WHEN r.started_at >= $2 THEN r.total_bet - r.total_win ELSE 0 END) as loss_today,
       SUM(CASE WHEN r.started_at >= $2 THEN r.total_bet ELSE 0 END) as wager_today,
       COUNT(CASE WHEN r.started_at >= $2 THEN 1 END) as spins_today,
       SUM(CASE WHEN r.started_at >= $3 THEN r.total_bet - r.total_win ELSE 0 END) as loss_week
     FROM rounds r
     WHERE r.player_id = $1 AND r.status = 'settled'`,
    [playerId, dayStart.toISOString(), weekStart.toISOString()],
  );

  const row = countersRes.rows[0];
  const lossTodayRaw = row?.loss_today ? Number(row.loss_today) : 0;
  const lossWeekRaw = row?.loss_week ? Number(row.loss_week) : 0;
  const lossToday = Math.max(0, lossTodayRaw);
  const lossThisWeek = Math.max(0, lossWeekRaw);
  const wageredToday = row?.wager_today ? Number(row.wager_today) : 0;
  const spinsToday = row?.spins_today ? Number(row.spins_today) : 0;

  // Сессия
  let sessionStartedAt = now;
  let lastRealityCheckAt: number | null = null;
  try {
    const sessRes = await database.query<{ started_at: string; reality_check_at: string | null }>(
      `SELECT started_at, reality_check_at FROM sessions
       WHERE player_id = $1 AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [playerId],
    );
    if (sessRes.rows[0]) {
      sessionStartedAt = new Date(sessRes.rows[0].started_at).getTime();
      lastRealityCheckAt = sessRes.rows[0].reality_check_at ? new Date(sessRes.rows[0].reality_check_at).getTime() : null;
    }
  } catch {
    // sessions таблица существует, но запрос может падать если нет данных — ignore
  }

  const counters: ActivityCounters = {
    lossToday,
    lossThisWeek,
    wageredToday,
    spinsToday,
    sessionStartedAt,
    lastRealityCheckAt,
  };

  return { limits, selfExclusion, counters };
}

export interface LimitRow {
  id: string;
  kind: string;
  value: string;
  effective_from: string;
  cooling_until: string | null;
}

export async function listLimits(database: Database, playerId: string): Promise<LimitRow[]> {
  const res = await database.query<LimitRow>(
    `SELECT id, kind, value, effective_from, cooling_until
     FROM player_limits WHERE player_id = $1 AND revoked_at IS NULL
     ORDER BY kind`,
    [playerId],
  );
  return res.rows;
}

export async function setLimit(
  database: Database,
  playerId: string,
  kind: LimitKind,
  value: number,
  now = Date.now(),
): Promise<{ limit: PlayerLimit; tightening: boolean; immediate: boolean; message: string }> {
  if (!LIMIT_KINDS.includes(kind)) throw new Error(`kind must be one of ${LIMIT_KINDS.join(",")}`);
  if (!Number.isInteger(value) || value <= 0) throw new Error("value must be positive integer");

  return database.transaction(async (client) => {
    const existingRes = await client.query<{
      id: string;
      kind: string;
      value: string;
      effective_from: string;
      cooling_until: string | null;
    }>(
      `SELECT id, kind, value, effective_from, cooling_until
       FROM player_limits WHERE player_id = $1 AND kind = $2 AND revoked_at IS NULL
       FOR UPDATE`,
      [playerId, kind],
    );

    const current = existingRes.rows[0] ? toPlayerLimit(existingRes.rows[0]) : undefined;

    // Проверка периода охлаждения: если текущий лимит в охлаждении и новый больше — отклоняем
    if (current && current.coolingUntil && current.coolingUntil > now && value > current.value) {
      const err = new Error(`Повышение лимита возможно после ${new Date(current.coolingUntil).toISOString()}`) as Error & { code?: string; retryAt?: string };
      err.code = "COOLING";
      err.retryAt = new Date(current.coolingUntil).toISOString();
      throw err;
    }

    const applied = applyLimitChange(current, { kind, value }, now, COOLING_MS);

    if (existingRes.rows[0]) {
      await client.query(`UPDATE player_limits SET revoked_at = now() WHERE id = $1`, [existingRes.rows[0].id]);
    }

    await client.query(
      `INSERT INTO player_limits (player_id, kind, value, effective_from, cooling_until)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0))`,
      [playerId, kind, value, applied.limit.effectiveFrom, applied.limit.coolingUntil ?? null],
    );

    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, event_type, subject_type, subject_id, payload)
       VALUES ('player', $1, 'limit.set', 'player_limit', $1, $2)`,
      [playerId, JSON.stringify({ kind, value, tightening: applied.tightening })],
    );

    return applied;
  });
}

export async function setSelfExclusion(
  database: Database,
  playerId: string,
  durationDays: number | null,
  now = Date.now(),
): Promise<{ exclusion: SelfExclusion; changed: boolean }> {
  return database.transaction(async (client) => {
    const curRes = await client.query<{ started_at: string; ends_at: string | null }>(
      `SELECT started_at, ends_at FROM self_exclusions WHERE player_id = $1 ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [playerId],
    );
    const current = toSelfExclusion(curRes.rows[0]);

    const next = applySelfExclusion(current, durationDays, now);

    // Если не изменилось — возвращаем как есть
    if (current && current.endsAt === next.endsAt && current.startedAt === next.startedAt) {
      return { exclusion: next, changed: false };
    }

    await client.query(
      `INSERT INTO self_exclusions (player_id, started_at, ends_at, reason, created_by)
       VALUES ($1, to_timestamp($2 / 1000.0), CASE WHEN $3::bigint IS NULL THEN NULL ELSE to_timestamp($3 / 1000.0) END, $4, 'player')`,
      [playerId, next.startedAt, next.endsAt, durationDays === null ? "бессрочное" : `${durationDays} дней`],
    );

    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, event_type, subject_type, subject_id, payload)
       VALUES ('player', $1, 'self_exclusion.set', 'self_exclusion', $1, $2)`,
      [playerId, JSON.stringify({ durationDays, endsAt: next.endsAt })],
    );

    // При самоисключении закрываем активные сессии
    await client.query(`UPDATE sessions SET ended_at = now() WHERE player_id = $1 AND ended_at IS NULL`, [playerId]);
    await client.query(`UPDATE players SET status = 'self_excluded' WHERE id = $1`, [playerId]);

    return { exclusion: next, changed: true };
  });
}
