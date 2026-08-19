/** Атомарное сохранение игрового раунда. Все записи ниже живут в одной SERIALIZABLE-транзакции. */
import type { PoolClient } from "pg";
import { playRound, type RoundRecord } from "../engine/round.js";
import type { LoadedConfig } from "../engine/config.js";
import type { Database } from "./db.js";

export class RoundServiceError extends Error {
  constructor(readonly code: "INSUFFICIENT_FUNDS" | "GAME_DISABLED" | "IDEMPOTENCY_CONFLICT" | "SEED_NOT_FOUND", message: string) {
    super(message);
  }
}

interface GameRow { game_id: string; game_config_id: string; config_hash: string; }
interface WalletRow { id: string; balance: string; }
interface SeedRow { id: string; server_seed: string; server_seed_hash: string; client_seed: string; next_nonce: string; }
interface ExistingRow { id: string; bet_per_line: string; lines: number; total_win: string; status: string; nonce: string; server_seed: string; client_seed: string; }

export interface SavedRound { roundId: string; record: RoundRecord; balance: bigint; idempotent: boolean; }

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
    const existing = await client.query<ExistingRow>(
      "SELECT r.id, r.bet_per_line, r.lines, r.total_win, r.status, r.nonce, s.server_seed, s.client_seed FROM rounds r JOIN seed_pairs s ON s.id=r.seed_pair_id WHERE r.player_id=$1 AND r.external_id=$2 FOR UPDATE", [playerId, externalId],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.bet_per_line !== String(betPerLine) || row.lines !== lines) throw new RoundServiceError("IDEMPOTENCY_CONFLICT", "Ключ уже использован с другими параметрами.");
      const currentWallet = await client.query<WalletRow>("SELECT id, balance FROM wallets WHERE player_id=$1 AND currency_code='CHIP' FOR UPDATE", [playerId]);
      if (!currentWallet.rows[0]) throw new RoundServiceError("INSUFFICIENT_FUNDS", "Кошелёк не найден.");
      const record = playRound(cfg.config, row.server_seed, row.client_seed, Number(row.nonce), { betPerLine });
      return { roundId: row.id, record, balance: BigInt(currentWallet.rows[0].balance), idempotent: true };
    }
    const game = await client.query<GameRow>(
      `SELECT g.id AS game_id, gc.id AS game_config_id, gc.config_hash FROM games g
       JOIN game_configs gc ON gc.game_id=g.id AND gc.is_active WHERE g.code='crown-of-fortune' AND g.is_enabled`,
    );
    if (!game.rows[0] || game.rows[0].config_hash !== cfg.hash) throw new RoundServiceError("GAME_DISABLED", "Игра недоступна.");
    const wallet = await client.query<WalletRow>("SELECT id, balance FROM wallets WHERE player_id=$1 AND currency_code='CHIP' FOR UPDATE", [playerId]);
    if (!wallet.rows[0] || BigInt(wallet.rows[0].balance) < totalBet) throw new RoundServiceError("INSUFFICIENT_FUNDS", "Недостаточно виртуальных фишек.");
    const seed = await client.query<SeedRow>("SELECT id, server_seed, server_seed_hash, client_seed, next_nonce FROM seed_pairs WHERE player_id=$1 AND status='active' FOR UPDATE", [playerId]);
    if (!seed.rows[0]) throw new RoundServiceError("SEED_NOT_FOUND", "Активная пара сидов не найдена.");
    const seedRow = seed.rows[0]; const nonce = Number(seedRow.next_nonce);
    const record = playRound(cfg.config, seedRow.server_seed, seedRow.client_seed, nonce, { betPerLine });
    const round = await client.query<{ id: string }>(
      `INSERT INTO rounds (external_id, player_id, game_id, game_config_id, config_hash, wallet_id, currency_code, seed_pair_id, nonce, draw_count, bet_per_line, lines, total_bet, total_win, status, settled_at)
       VALUES ($1,$2,$3,$4,$5,$6,'CHIP',$7,$8,$9,$10,$11,$12,$13,'settled',now()) RETURNING id`,
      [externalId, playerId, game.rows[0].game_id, game.rows[0].game_config_id, cfg.hash, wallet.rows[0].id, seedRow.id, nonce, record.drawCount, betPerLine, lines, totalBet.toString(), record.totalWin],
    );
    const roundId = round.rows[0]!.id; const afterBet = BigInt(wallet.rows[0].balance) - totalBet; const afterWin = afterBet + BigInt(record.totalWin);
    await client.query("INSERT INTO ledger_entries (wallet_id,amount,balance_after,tx_type,round_id,idempotency_key) VALUES ($1,$2,$3,'bet',$4,$5)", [wallet.rows[0].id, (-totalBet).toString(), afterBet.toString(), roundId, `bet:${externalId}`]);
    if (record.totalWin > 0) await client.query("INSERT INTO ledger_entries (wallet_id,amount,balance_after,tx_type,round_id,idempotency_key) VALUES ($1,$2,$3,'win',$4,$5)", [wallet.rows[0].id, record.totalWin, afterWin.toString(), roundId, `win:${externalId}`]);
    for (const spin of record.spins) await client.query(
      "INSERT INTO spins (round_id,spin_index,is_free,reel_stops,grid,win,multiplier,win_details,scatter_count,triggered_free) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [roundId, spin.index, spin.free, spin.reelStops, spin.grid.flat(), spin.win, spin.multiplier, JSON.stringify(spin.winDetails), spin.scatterCount, spin.triggeredFreeSpins],
    );
    await client.query("UPDATE seed_pairs SET next_nonce=next_nonce+1 WHERE id=$1", [seedRow.id]);
    await client.query("INSERT INTO audit_log (actor_type,actor_id,event_type,subject_type,subject_id,payload) VALUES ('player',$1,'round.settled','round',$2,$3)", [playerId, roundId, JSON.stringify({ externalId, totalBet: totalBet.toString(), totalWin: record.totalWin })]);
    return { roundId, record, balance: afterWin, idempotent: false };
  });
}
