/** GDPR export — все данные игрока (T-052) */
import type { Database } from "./db.js";

export async function exportPlayerData(database: Database, playerId: string) {
  const player = await database.query<{
    id: string;
    username: string;
    email: string | null;
    status: string;
    locale: string;
    created_at: string;
    master_rtp: string | null;
  }>(`SELECT id, username, email, status, locale, created_at, master_rtp FROM players WHERE id = $1`, [playerId]);

  const wallets = await database.query<{
    id: string;
    currency_code: string;
    balance: string;
    created_at: string;
  }>(`SELECT id, currency_code, balance, created_at FROM wallets WHERE player_id = $1`, [playerId]);

  const rounds = await database.query<{
    id: string;
    game_code: string;
    total_bet: string;
    total_win: string;
    started_at: string;
  }>(
    `SELECT r.id, g.code as game_code, r.total_bet, r.total_win, r.started_at
     FROM rounds r JOIN games g ON g.id = r.game_id
     WHERE r.player_id = $1 ORDER BY r.started_at DESC LIMIT 100`,
    [playerId],
  );

  const ledger = await database.query<{
    id: string;
    amount: string;
    balance_after: string;
    tx_type: string;
    created_at: string;
    reason: string | null;
  }>(
    `SELECT l.id, l.amount, l.balance_after, l.tx_type, l.created_at, l.reason
     FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
     WHERE w.player_id = $1 ORDER BY l.created_at DESC LIMIT 200`,
    [playerId],
  );

  const limits = await database.query<{
    kind: string;
    value: string;
    effective_from: string;
    cooling_until: string | null;
    revoked_at: string | null;
  }>(`SELECT kind, value, effective_from, cooling_until, revoked_at FROM player_limits WHERE player_id = $1 ORDER BY created_at DESC`, [playerId]);

  const exclusions = await database.query<{
    started_at: string;
    ends_at: string | null;
    reason: string | null;
  }>(`SELECT started_at, ends_at, reason FROM self_exclusions WHERE player_id = $1 ORDER BY started_at DESC`, [playerId]);

  const seeds = await database.query<{
    id: string;
    server_seed_hash: string;
    client_seed: string;
    next_nonce: string;
    status: string;
    created_at: string;
    revealed_at: string | null;
  }>(`SELECT id, server_seed_hash, client_seed, next_nonce, status, created_at, revealed_at FROM seed_pairs WHERE player_id = $1 ORDER BY created_at DESC LIMIT 50`, [playerId]);

  return {
    player: player.rows[0] ?? null,
    wallets: wallets.rows,
    rounds: rounds.rows,
    ledger: ledger.rows,
    limits: limits.rows,
    selfExclusions: exclusions.rows,
    seedPairs: seeds.rows.map((s) => ({ ...s, server_seed: undefined })), // не отдаём server_seed активных
    exportedAt: new Date().toISOString(),
    note: "Виртуальные фишки без денежной ценности. Экспорт для GDPR / прозрачности.",
  };
}
