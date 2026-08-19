/** Рефералка (T-059) */
import type { Database } from "./db.js";

const REFERRAL_BONUS = 5000n;
const REFEREE_BONUS = 1000n;

export async function createReferral(database: Database, referrerId: string, refereeId: string): Promise<boolean> {
  if (referrerId === refereeId) return false;
  return database.transaction(async (client) => {
    // Проверяем что реферала ещё никто не приглашал
    const existing = await client.query(`SELECT id FROM referrals WHERE referee_id = $1`, [refereeId]);
    if (existing.rows[0]) return false;

    // Создаём запись рефералки
    await client.query(
      `INSERT INTO referrals (referrer_id, referee_id, bonus_amount) VALUES ($1,$2,$3) ON CONFLICT (referee_id) DO NOTHING`,
      [referrerId, refereeId, REFERRAL_BONUS.toString()],
    );

    // Начисляем бонусы обоим
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
