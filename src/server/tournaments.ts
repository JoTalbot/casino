/** Турниры (T-055) — топ по win за период турнира */
import type { Database } from "./db.js";

export async function listTournaments(database: Database) {
  const res = await database.query<{
    id: string;
    code: string;
    title: string;
    description: string;
    status: string;
    game_code: string;
    starts_at: string;
    ends_at: string;
    prize_pool: string;
  }>(`SELECT id, code, title, description, status, game_code, starts_at, ends_at, prize_pool FROM tournaments ORDER BY starts_at DESC`);
  return res.rows;
}

export async function getTournamentLeaderboard(database: Database, code: string, limit = 20) {
  const lim = Math.min(Math.max(limit, 1), 100);
  const tourRes = await database.query<{ id: string; starts_at: string; ends_at: string }>(
    `SELECT id, starts_at, ends_at FROM tournaments WHERE code = $1 LIMIT 1`,
    [code],
  );
  if (!tourRes.rows[0]) return null;
  const tour = tourRes.rows[0];

  const res = await database.query<{
    player_id: string;
    username: string;
    total_win: string;
    total_bet: string;
    rounds: string;
  }>(
    `SELECT p.id as player_id, p.username, SUM(r.total_win) as total_win, SUM(r.total_bet) as total_bet, COUNT(*) as rounds
     FROM rounds r
     JOIN players p ON p.id = r.player_id
     WHERE r.status = 'settled' AND r.started_at >= $1 AND r.started_at <= $2
     GROUP BY p.id, p.username
     HAVING SUM(r.total_win) > 0
     ORDER BY SUM(r.total_win) DESC
     LIMIT $3`,
    [tour.starts_at, tour.ends_at, lim],
  );

  return {
    tournamentId: tour.id,
    startsAt: tour.starts_at,
    endsAt: tour.ends_at,
    leaderboard: res.rows.map((r, i) => ({
      rank: i + 1,
      playerId: r.player_id,
      username: r.username,
      totalWin: Number(r.total_win),
      totalBet: Number(r.total_bet),
      rounds: Number(r.rounds),
    })),
  };
}

export async function updateTournamentScores(database: Database, playerId: string, totalWin: number, totalBet: number): Promise<void> {
  // Обновляем все активные турниры для игрока (best effort, не в критическом пути раунда)
  try {
    await database.query(
      `INSERT INTO tournament_scores (tournament_id, player_id, total_win, total_bet, rounds, updated_at)
       SELECT t.id, $1, $2, $3, 1, now()
       FROM tournaments t WHERE t.status = 'active' AND t.starts_at <= now() AND t.ends_at >= now()
       ON CONFLICT (tournament_id, player_id) DO UPDATE SET
         total_win = tournament_scores.total_win + EXCLUDED.total_win,
         total_bet = tournament_scores.total_bet + EXCLUDED.total_bet,
         rounds = tournament_scores.rounds + 1,
         updated_at = now()`,
      [playerId, totalWin, totalBet],
    );
  } catch {
    // ignore
  }
}
