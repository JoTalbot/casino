/** Рефералка (T-059, T-070, T-095) */
import type { Database } from "./db.js";

const REFERRAL_BONUS = 5000n;
const REFEREE_BONUS = 1000n;

export async function createReferral(database: Database, referrerId: string, refereeId: string): Promise<boolean> {
  if (referrerId === refereeId) return false;
  return database.transaction(async (client) => {
    const existing = await client.query(`SELECT id FROM referrals WHERE referee_id = $1`, [refereeId]);
    if (existing.rows[0]) return false;

    await client.query(
      `INSERT INTO referrals (referrer_id, referee_id, bonus_amount) VALUES ($1,$2,$3) ON CONFLICT (referee_id) DO NOTHING`,
      [referrerId, refereeId, REFERRAL_BONUS.toString()],
    );

    for (const [pid, amount] of [[referrerId, REFERRAL_BONUS], [refereeId, REFEREE_BONUS]] as const) {
      const walletRes = await client.query<{ id: string; balance: string }>(
        `SELECT id, balance FROM wallets WHERE player_id = $1 AND currency_code = 'CHIP' FOR UPDATE`,
        [pid],
      );
      if (!walletRes.rows[0]) continue;
      const walletId = walletRes.rows[0].id;
      const newBal = BigInt(walletRes.rows[0].balance) + amount;
      const key = `referral:${referrerId}:${refereeId}:${pid}`;
      await client.query(
        `INSERT INTO ledger_entries (wallet_id, amount, balance_after, tx_type, idempotency_key, reason) VALUES ($1,$2,$3,'grant',$4,'referral-bonus') ON CONFLICT (idempotency_key) DO NOTHING`,
        [walletId, amount.toString(), newBal.toString(), key],
      );
    }

    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, event_type, subject_type, subject_id, payload) VALUES ('player',$1,'referral.created','player',$2,$3)`,
      [referrerId, refereeId, JSON.stringify({ referrerId, refereeId })],
    );

    return true;
  });
}

export async function getReferrals(database: Database, playerId: string) {
  const res = await database.query<{
    id: string;
    referee_id: string;
    username: string;
    bonus_amount: string;
    created_at: string;
  }>(
    `SELECT r.id, r.referee_id, p.username, r.bonus_amount, r.created_at
     FROM referrals r JOIN players p ON p.id = r.referee_id
     WHERE r.referrer_id = $1 ORDER BY r.created_at DESC`,
    [playerId],
  );
  return res.rows;
}

export async function getReferralProgress(database: Database, playerId: string) {
  const cntRes = await database.query<{ count: string }>(`SELECT COUNT(*) as count FROM referrals WHERE referrer_id = $1`, [playerId]);
  const count = Number(cntRes.rows[0]?.count ?? 0);
  const target = 5;
  return {
    count,
    target,
    progress: Math.min(count / target, 1),
    remaining: Math.max(target - count, 0),
    hasMaster: count >= target,
  };
}

export async function getReferralLeaderboard(database: Database, limit = 20) {
  const lim = Math.min(Math.max(limit, 1), 100);
  const res = await database.query<{
    referrer_id: string;
    username: string;
    count: string;
    total_bonus: string;
  }>(
    `SELECT r.referrer_id, p.username, COUNT(*) as count, SUM(r.bonus_amount) as total_bonus
     FROM referrals r JOIN players p ON p.id = r.referrer_id
     GROUP BY r.referrer_id, p.username
     ORDER BY COUNT(*) DESC LIMIT $1`,
    [lim],
  );
  return res.rows.map((r, i) => ({
    rank: i + 1,
    playerId: r.referrer_id,
    username: r.username,
    count: Number(r.count),
    totalBonus: Number(r.total_bonus),
  }));
}

export async function getReferralDaily(database: Database, days = 14) {
  const d = Math.min(Math.max(days, 1), 90);
  const res = await database.query<{
    day: string;
    count: string;
  }>(
    `SELECT date_trunc('day', created_at)::date as day, COUNT(*) as count
     FROM referrals
     WHERE created_at >= now() - ($1::int || ' days')::interval
     GROUP BY 1 ORDER BY 1 ASC`,
    [d],
  );
  return res.rows;
}
