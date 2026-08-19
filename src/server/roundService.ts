/** Атомарное сохранение игрового раунда. Все записи живут в одной SERIALIZABLE-транзакции. */
import type { PoolClient } from "pg";
import { playRound, type RoundRecord } from "../engine/round.js";
import type { LoadedConfig } from "../engine/config.js";
import type { Database } from "./db.js";
import {
  canPlaceBet,
  isExcluded,
  type ActivityCounters,
  type PlayerLimit,
  type SelfExclusion,
  type LimitKind,
} from "../engine/responsible.js";

export class RoundServiceError extends Error {
  constructor(
    readonly code:
      | "INSUFFICIENT_FUNDS"
      | "GAME_DISABLED"
      | "IDEMPOTENCY_CONFLICT"
      | "SEED_NOT_FOUND"
      | "LIMIT_EXCEEDED"
      | "SELF_EXCLUDED",
    message: string,
  ) {
    super(message);
  }
}

interface GameRow {
  game_id: string;
  game_config_id: string;
  config_hash: string;
}
interface WalletRow {
  id: string;
  balance: string;
}
interface SeedRow {
  id: string;
  server_seed: string;
  server_seed_hash: string;
  client_seed: string;
  next_nonce: string;
}
interface ExistingRow {
  id: string;
  bet_per_line: string;
  lines: number;
  total_win: string;
  status: string;
  nonce: string;
  server_seed: string;
  client_seed: string;
}

export interface SavedRound {
  roundId: string;
  record: RoundRecord;
  balance: bigint;
  idempotent: boolean;
}

function toLimit(row: { kind: string; value: string; effective_from: string; cooling_until: string | null }): PlayerLimit {
  return {
    kind: row.kind as LimitKind,
    value: Number(row.value),
    effectiveFrom: new Date(row.effective_from).getTime(),
    coolingUntil: row.cooling_until ? new Date(row.cooling_until).getTime() : null,
  };
}

function toExclusion(row: { started_at: string; ends_at: string | null } | undefined): SelfExclusion | null {
  if (!row) return null;
  return {
    startedAt: new Date(row.started_at).getTime(),
    endsAt: row.ends_at ? new Date(row.ends_at).getTime() : null,
  };
}

async function loadCounters(client: PoolClient, playerId: string): Promise<ActivityCounters> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(dayStart);
  weekStart.setUTCDate(dayStart.getUTCDate() - 6);

  const res = await client.query<{
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

  const row = res.rows[0];
  const lossToday = Math.max(0, row?.loss_today ? Number(row.loss_today) : 0);
  const lossWeek = Math.max(0, row?.loss_week ? Number(row.loss_week) : 0);
  const wageredToday = row?.wager_today ? Number(row.wager_today) : 0;
  const spinsToday = row?.spins_today ? Number(row.spins_today) : 0;

  // Сессия — берём последнюю незакрытую
  let sessionStartedAt = Date.now();
  let lastRealityCheckAt: number | null = null;
  try {
    const sess = await client.query<{ started_at: string; reality_check_at: string | null }>(
      `SELECT started_at, reality_check_at FROM sessions WHERE player_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      [playerId],
    );
    if (sess.rows[0]) {
      sessionStartedAt = new Date(sess.rows[0].started_at).getTime();
      lastRealityCheckAt = sess.rows[0].reality_check_at ? new Date(sess.rows[0].reality_check_at).getTime() : null;
    }
  } catch {
    // ignore if table query fails
  }

  return {
    lossToday,
    lossThisWeek: lossWeek,
    wageredToday,
    spinsToday,
    sessionStartedAt,
    lastRealityCheckAt,
  };
}

export async function settleRound(
  database: Database,
  cfg: LoadedConfig,
  playerId: string,
  externalId: string,
  betPerLine: number,
  lines: number,
): Promise<SavedRound> {
  if (lines !== cfg.config.lines) throw new RoundServiceError("GAME_DISABLED", "Для игры доступно фиксированное число линий.");
  const totalBet = BigInt(betPerLine) * BigInt(lines);

  return database.transaction(async (client) => {
    // Идемпотентность — проверяем первой, до проверки лимитов, чтобы повтор не считался новой ставкой
    const existing = await client.query<ExistingRow>(
      "SELECT r.id, r.bet_per_line, r.lines, r.total_win, r.status, r.nonce, s.server_seed, s.client_seed FROM rounds r JOIN seed_pairs s ON s.id=r.seed_pair_id WHERE r.player_id=$1 AND r.external_id=$2 FOR UPDATE",
      [playerId, externalId],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.bet_per_line !== String(betPerLine) || row.lines !== lines)
        throw new RoundServiceError("IDEMPOTENCY_CONFLICT", "Ключ уже использован с другими параметрами.");
      const currentWallet = await client.query<WalletRow>(
        "SELECT id, balance FROM wallets WHERE player_id=$1 AND currency_code='CHIP' FOR UPDATE",
        [playerId],
      );
      if (!currentWallet.rows[0]) throw new RoundServiceError("INSUFFICIENT_FUNDS", "Кошелёк не найден.");
      const record = playRound(cfg.config, row.server_seed, row.client_seed, Number(row.nonce), { betPerLine });
      return { roundId: row.id, record, balance: BigInt(currentWallet.rows[0].balance), idempotent: true };
    }

    // --- Ответственная игра: лимиты и самоисключение считаются из БД (T-027) ---
    const seRes = await client.query<{ started_at: string; ends_at: string | null }>(
      `SELECT started_at, ends_at FROM self_exclusions WHERE player_id = $1 ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [playerId],
    );
    const selfExclusion = toExclusion(seRes.rows[0]);
    if (selfExclusion && isExcluded(selfExclusion, Date.now())) {
      throw new RoundServiceError("SELF_EXCLUDED", "Действует самоисключение. Игра недоступна.");
    }

    const limitsRes = await client.query<{
      kind: string;
      value: string;
      effective_from: string;
      cooling_until: string | null;
    }>(
      `SELECT kind, value, effective_from, cooling_until FROM player_limits
       WHERE player_id = $1 AND revoked_at IS NULL AND effective_from <= now()
       FOR UPDATE`,
      [playerId],
    );
    const limitsMap = new Map<string, PlayerLimit>();
    for (const r of limitsRes.rows) {
      const pl = toLimit(r);
      if (!limitsMap.has(pl.kind)) limitsMap.set(pl.kind, pl);
    }
    const counters = await loadCounters(client, playerId);
    const state = { limits: Array.from(limitsMap.values()), selfExclusion, counters };
    const decision = canPlaceBet(state, Number(totalBet), Date.now());
    if (!decision.allowed) {
      if (decision.code === "SELF_EXCLUDED") throw new RoundServiceError("SELF_EXCLUDED", decision.message);
      if (decision.code === "LIMIT_EXCEEDED") throw new RoundServiceError("LIMIT_EXCEEDED", decision.message);
      throw new RoundServiceError("GAME_DISABLED", decision.message);
    }

    const game = await client.query<GameRow>(
      `SELECT g.id AS game_id, gc.id AS game_config_id, gc.config_hash FROM games g
       JOIN game_configs gc ON gc.game_id=g.id AND gc.is_active WHERE g.code='crown-of-fortune' AND g.is_enabled`,
    );
    if (!game.rows[0] || game.rows[0].config_hash !== cfg.hash)
      throw new RoundServiceError("GAME_DISABLED", "Игра недоступна.");

    const wallet = await client.query<WalletRow>(
      "SELECT id, balance FROM wallets WHERE player_id=$1 AND currency_code='CHIP' FOR UPDATE",
      [playerId],
    );
    if (!wallet.rows[0] || BigInt(wallet.rows[0].balance) < totalBet)
      throw new RoundServiceError("INSUFFICIENT_FUNDS", "Недостаточно виртуальных фишек.");

    const seed = await client.query<SeedRow>(
      "SELECT id, server_seed, server_seed_hash, client_seed, next_nonce FROM seed_pairs WHERE player_id=$1 AND status='active' FOR UPDATE",
      [playerId],
    );
    if (!seed.rows[0]) throw new RoundServiceError("SEED_NOT_FOUND", "Активная пара сидов не найдена.");
    const seedRow = seed.rows[0];
    const nonce = Number(seedRow.next_nonce);
    const record = playRound(cfg.config, seedRow.server_seed, seedRow.client_seed, nonce, { betPerLine });

    const round = await client.query<{ id: string }>(
      `INSERT INTO rounds (external_id, player_id, game_id, game_config_id, config_hash, wallet_id, currency_code, seed_pair_id, nonce, draw_count, bet_per_line, lines, total_bet, total_win, status, settled_at)
       VALUES ($1,$2,$3,$4,$5,$6,'CHIP',$7,$8,$9,$10,$11,$12,$13,'settled',now()) RETURNING id`,
      [
        externalId,
        playerId,
        game.rows[0].game_id,
        game.rows[0].game_config_id,
        cfg.hash,
        wallet.rows[0].id,
        seedRow.id,
        nonce,
        record.drawCount,
        betPerLine,
        lines,
        totalBet.toString(),
        record.totalWin,
      ],
    );
    const roundId = round.rows[0]!.id;
    const afterBet = BigInt(wallet.rows[0].balance) - totalBet;
    const afterWin = afterBet + BigInt(record.totalWin);
    await client.query(
      "INSERT INTO ledger_entries (wallet_id,amount,balance_after,tx_type,round_id,idempotency_key) VALUES ($1,$2,$3,'bet',$4,$5)",
      [wallet.rows[0].id, (-totalBet).toString(), afterBet.toString(), roundId, `bet:${externalId}`],
    );
    if (record.totalWin > 0)
      await client.query(
        "INSERT INTO ledger_entries (wallet_id,amount,balance_after,tx_type,round_id,idempotency_key) VALUES ($1,$2,$3,'win',$4,$5)",
        [wallet.rows[0].id, record.totalWin, afterWin.toString(), roundId, `win:${externalId}`],
      );

    for (const spin of record.spins)
      await client.query(
        "INSERT INTO spins (round_id,spin_index,is_free,reel_stops,grid,win,multiplier,win_details,scatter_count,triggered_free) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          roundId,
          spin.index,
          spin.free,
          spin.reelStops,
          spin.grid.flat(),
          spin.win,
          spin.multiplier,
          JSON.stringify(spin.winDetails),
          spin.scatterCount,
          spin.triggeredFreeSpins,
        ],
      );

    await client.query("UPDATE seed_pairs SET next_nonce=next_nonce+1 WHERE id=$1", [seedRow.id]);
    await client.query(
      "INSERT INTO audit_log (actor_type,actor_id,event_type,subject_type,subject_id,payload) VALUES ('player',$1,'round.settled','round',$2,$3)",
      [playerId, roundId, JSON.stringify({ externalId, totalBet: totalBet.toString(), totalWin: record.totalWin })],
    );
    return { roundId, record, balance: afterWin, idempotent: false };
  });
}
