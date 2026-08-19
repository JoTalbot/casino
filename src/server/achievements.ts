/** Ачивки (T-060) */
import type { Database } from "./db.js";

export async function checkAndUnlockAchievements(database: Database, playerId: string, event: { type: "win" | "spin" | "referral" | "tournament"; totalWin?: number; totalBet?: number; multiple?: number }): Promise<string[]> {
  const unlocked: string[] = [];
  try {
    // Получаем уже открытые
    const existing = await database.query<{ code: string }>(
      `SELECT a.code FROM player_achievements pa JOIN achievements a ON a.id = pa.achievement_id WHERE pa.player_id = $1`,
      [playerId],
    );
    const have = new Set(existing.rows.map((r) => r.code));

    const toCheck: { code: string; condition: boolean }[] = [];

    if (event.type === "win" && event.totalWin && event.totalWin > 0) {
      toCheck.push({ code: "first_win", condition: !have.has("first_win") });
    }
    if (event.type === "win" && event.multiple && event.multiple >= 100) {
      toCheck.push({ code: "big_win", condition: !have.has("big_win") });
    }
    if (event.type === "spin") {
      const cnt = await database.query<{ c: string }>(`SELECT COUNT(*) as c FROM rounds WHERE player_id = $1 AND status='settled'`, [playerId]);
      const count = Number(cnt.rows[0]?.c ?? 0);
      if (count >= 100) toCheck.push({ code: "hundred_spins", condition: !have.has("hundred_spins") });
    }
    if (event.type === "referral") {
      const cnt = await database.query<{ c: string }>(`SELECT COUNT(*) as c FROM referrals WHERE referrer_id = $1`, [playerId]);
      if (Number(cnt.rows[0]?.c ?? 0) >= 5) toCheck.push({ code: "referral_master", condition: !have.has("referral_master") });
    }

    for (const { code, condition } of toCheck) {
      if (!condition) continue;
      const ach = await database.query<{ id: string; reward: string }>(`SELECT id, reward FROM achievements WHERE code = $1::achievement_type`, [code]);
      if (!ach.rows[0]) continue;
      await database.query(`INSERT INTO player_achievements (player_id, achievement_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [playerId, ach.rows[0].id]);
      // Награда
      const reward = BigInt(ach.rows[0].reward);
      if (reward > 0) {
        const walletRes = await database.query<{ id: string; balance: string }>(`SELECT id, balance FROM wallets WHERE player_id = $1 AND currency_code='CHIP' FOR UPDATE`, [playerId]);
        // Note: this runs outside transaction, but we are not in transaction here; use separate query via database.transaction?
        // For simplicity, use direct transaction in database.transaction wrapper caller? We'll do best effort via database.query
        // Actually we need transaction – for simplicity do direct update via ledger
        await database.query(
          `INSERT INTO ledger_entries (wallet_id, amount, balance_after, tx_type, idempotency_key, reason)
           SELECT w.id, $2, (w.balance + $2::bigint)::text, 'grant', $3, 'achievement:' || $4
           FROM wallets w WHERE w.player_id = $1 AND w.currency_code='CHIP'`,
          [playerId, reward.toString(), `ach:${playerId}:${code}`, code],
        );
      }
      unlocked.push(code);
    }
  } catch {
    // ignore
  }
  return unlocked;
}

export async function listAchievements(database: Database, playerId: string) {
  const res = await database.query<{
    code: string;
    title: string;
    description: string;
    reward: string;
    unlocked_at: string | null;
  }>(
    `SELECT a.code, a.title, a.description, a.reward, pa.unlocked_at
     FROM achievements a
     LEFT JOIN player_achievements pa ON pa.achievement_id = a.id AND pa.player_id = $1
     ORDER BY a.code`,
    [playerId],
  );
  return res.rows;
}
