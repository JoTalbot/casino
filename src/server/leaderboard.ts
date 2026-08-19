/** Leaderboard — топ игроков по win/bet за период (T-050) */
import type { Database } from "./db.js";

export type LeaderboardBy = "win" | "bet";
export type LeaderboardPeriod = "day" | "week" | "all";

export async function getLeaderboard(
  database: Database,
  by: LeaderboardBy = "win",
  period: LeaderboardPeriod = "all",
  limit = 20,
) {
  const lim = Math.min(Math.max(limit, 1), 100);
  let since: string | null = null;
  if (period === "day") {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    since = d.toISOString();
  } else if (period === "week") {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 6);
    d.setUTCHours(0, 0, 0, 0);
    since = d.toISOString();
  }

  const orderField = by === "bet" ? "total_bet" : "total_win";

  let sql = `
    SELECT p.id as player_id, p.username, 
           SUM(r.total_bet) as total_bet,
           SUM(r.total_win) as total_win,
           COUNT(*) as rounds,
           SUM(r.total_win - r.total_bet) as net
    FROM rounds r
    JOIN players p ON p.id = r.player_id
    WHERE r.status = 'settled'
  `;
  const params: unknown[] = [];
  let idx = 1;
  if (since) {
    sql += ` AND r.started_at >= $${idx}`;
    params.push(since);
    idx++;
  }
  sql += ` GROUP BY p.id, p.username HAVING SUM(r.total_bet) > 0 ORDER BY ${orderField} DESC LIMIT $${idx}`;
  params.push(lim);

  const res = await database.query<{
    player_id: string;
    username: string;
    total_bet: string;
    total_win: string;
    rounds: string;
    net: string;
  }>(sql, params);

  return res.rows.map((r, i) => ({
    rank: i + 1,
    playerId: r.player_id,
    username: r.username,
    totalBet: Number(r.total_bet),
    totalWin: Number(r.total_win),
    rounds: Number(r.rounds),
    net: Number(r.net),
    rtp: Number(r.total_bet) > 0 ? Number(r.total_win) / Number(r.total_bet) : 0,
  }));
}
