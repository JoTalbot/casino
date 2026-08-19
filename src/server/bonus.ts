/** Daily bonus — 1000 CHIP раз в сутки (T-049) */
import type { Database } from "./db.js";

const DAILY_AMOUNT = 1000n;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function claimDailyBonus(database: Database, playerId: string): Promise<{ claimed: boolean; amount: bigint; balance: bigint; nextClaimAt: string | null }> {
  return database.transaction(async (client) => {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);

    // Проверяем был ли уже daily grant сегодня
    const existing = await client.query<{ id: string }>(
      `SELECT l.id FROM ledger_entries l
       JOIN wallets w ON w.id = l.wallet_id
       WHERE w.player_id = $1 AND l.tx_type = 'grant' AND l.reason = 'daily-bonus' AND l.created_at >= $2
       LIMIT 1`,
      [playerId, dayStart.toISOString()],
    );
    if (existing.rows[0]) {
      const walletRes = await client.query<{ balance: string }>("SELECT balance FROM wallets WHERE player_id = $1 AND currency_code = 'CHIP'", [playerId]);
      const bal = walletRes.rows[0] ? BigInt(walletRes.rows[0].balance) : 0n;
      const next = new Date(dayStart.getTime() + DAY_MS);
      return { claimed: false, amount: 0n, balance: bal, nextClaimAt: next.toISOString() };
    }

    const walletRes = await client.query<{ id: string; balance: string }>(
      "SELECT id, balance FROM wallets WHERE player_id = $1 AND currency_code = 'CHIP' FOR UPDATE",
      [playerId],
    );
    if (!walletRes.rows[0]) throw new Error("Wallet not found");
    const walletId = walletRes.rows[0].id;
    const oldBal = BigInt(walletRes.rows[0].balance);
    const newBal = oldBal + DAILY_AMOUNT;
    const idempKey = `daily-bonus:${playerId}:${dayStart.toISOString().slice(0,10)}`;

    await client.query(
      `INSERT INTO ledger_entries (wallet_id, amount, balance_after, tx_type, idempotency_key, reason) VALUES ($1,$2,$3,'grant',$4,'daily-bonus') ON CONFLICT (idempotency_key) DO NOTHING`,
      [walletId, DAILY_AMOUNT.toString(), newBal.toString(), idempKey],
    );

    // Проверяем была ли вставка (on conflict do nothing)
    const check = await client.query<{ balance_after: string }>(
      `SELECT balance_after FROM ledger_entries WHERE idempotency_key = $1`,
      [idempKey],
    );
    const finalBal = check.rows[0] ? BigInt(check.rows[0].balance_after) : newBal;

    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, event_type, subject_type, subject_id, payload) VALUES ('player',$1,'bonus.daily','wallet',$2,$3)`,
      [playerId, walletId, JSON.stringify({ amount: DAILY_AMOUNT.toString() })],
    );

    return { claimed: true, amount: DAILY_AMOUNT, balance: finalBal, nextClaimAt: new Date(dayStart.getTime() + DAY_MS).toISOString() };
  });
}
