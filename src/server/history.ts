/** История раундов игрока. */
import type { Database } from "./db.js";

export interface RoundListItem {
  id: string;
  external_id: string;
  game_code: string;
  total_bet: string;
  total_win: string;
  nonce: string;
  config_hash: string;
  status: string;
  started_at: string;
  settled_at: string | null;
  spins_count?: number;
}

export interface RoundFull {
  id: string;
  external_id: string;
  player_id: string;
  game_code: string;
  config_hash: string;
  bet_per_line: string;
  lines: number;
  total_bet: string;
  total_win: string;
  nonce: string;
  status: string;
  started_at: string;
  settled_at: string;
  server_seed_hash: string;
  server_seed?: string | null;
  client_seed: string;
  seed_status: string;
  spins: {
    spin_index: number;
    is_free: boolean;
    reel_stops: number[];
    grid: string[];
    win: string;
    multiplier: number;
    win_details: unknown;
    scatter_count: number;
    triggered_free: number;
  }[];
}

export async function listRounds(
  database: Database,
  playerId: string,
  limit = 20,
  offset = 0,
  gameCode?: string,
): Promise<RoundListItem[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const safeOffset = Math.max(offset, 0);
  let sql: string;
  let params: unknown[];
  if (gameCode) {
    sql = `
      SELECT r.id, r.external_id, g.code as game_code, r.total_bet, r.total_win, r.nonce, r.config_hash, r.status, r.started_at, r.settled_at,
             (SELECT COUNT(*) FROM spins s WHERE s.round_id = r.id) as spins_count
      FROM rounds r
      JOIN games g ON g.id = r.game_id
      WHERE r.player_id = $1 AND g.code = $2
      ORDER BY r.started_at DESC
      LIMIT $3 OFFSET $4
    `;
    params = [playerId, gameCode, safeLimit, safeOffset];
  } else {
    sql = `
      SELECT r.id, r.external_id, g.code as game_code, r.total_bet, r.total_win, r.nonce, r.config_hash, r.status, r.started_at, r.settled_at,
             (SELECT COUNT(*) FROM spins s WHERE s.round_id = r.id) as spins_count
      FROM rounds r
      JOIN games g ON g.id = r.game_id
      WHERE r.player_id = $1
      ORDER BY r.started_at DESC
      LIMIT $2 OFFSET $3
    `;
    params = [playerId, safeLimit, safeOffset];
  }
  const res = await database.query<RoundListItem>(sql, params);
  return res.rows;
}

export async function getRoundFull(database: Database, playerId: string, roundId: string): Promise<RoundFull | null> {
  const roundRes = await database.query<{
    id: string;
    external_id: string;
    player_id: string;
    game_code: string;
    config_hash: string;
    bet_per_line: string;
    lines: number;
    total_bet: string;
    total_win: string;
    nonce: string;
    status: string;
    started_at: string;
    settled_at: string;
    server_seed_hash: string;
    server_seed: string | null;
    client_seed: string;
    seed_status: string;
  }>(
    `SELECT r.id, r.external_id, r.player_id, g.code as game_code, r.config_hash, r.bet_per_line, r.lines, r.total_bet, r.total_win, r.nonce, r.status, r.started_at, r.settled_at,
            sp.server_seed_hash, CASE WHEN sp.status = 'revealed' THEN sp.server_seed ELSE NULL END as server_seed,
            sp.client_seed, sp.status as seed_status
     FROM rounds r
     JOIN games g ON g.id = r.game_id
     JOIN seed_pairs sp ON sp.id = r.seed_pair_id
     WHERE r.id = $1 AND r.player_id = $2`,
    [roundId, playerId],
  );
  if (!roundRes.rows[0]) return null;
  const round = roundRes.rows[0];

  const spinsRes = await database.query<{
    spin_index: number;
    is_free: boolean;
    reel_stops: number[];
    grid: string[];
    win: string;
    multiplier: number;
    win_details: unknown;
    scatter_count: number;
    triggered_free: number;
  }>(
    `SELECT spin_index, is_free, reel_stops, grid, win, multiplier, win_details, scatter_count, triggered_free as triggered_free
     FROM spins WHERE round_id = $1 ORDER BY spin_index ASC`,
    [roundId],
  );

  return {
    ...round,
    spins: spinsRes.rows,
  };
}
