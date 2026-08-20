/** Ачивки (T-060) */
import type { Database } from "./db.js";

/** Куда писать проглоченные ошибки. По умолчанию — в консоль сервера. */
export interface AchievementLogger {
  error(payload: unknown, message: string): void;
}

export async function checkAndUnlockAchievements(
  database: Database,
  playerId: string,
  event: { type: "win" | "spin" | "referral" | "tournament"; totalWin?: number; totalBet?: number; multiple?: number },
  logger?: AchievementLogger,
): Promise<string[]> {
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
      const achievementId = ach.rows[0].id;
      const reward = BigInt(ach.rows[0].reward);

      // T-179: открытие ачивки и начисление награды — одна транзакция.
      // Раньше это были два независимых запроса вне транзакции: при падении
      // между ними ачивка открывалась без награды (или награда шла дважды).
      // Кошелёк берётся FOR UPDATE внутри той же транзакции, иначе блокировка
      // снималась сразу и не защищала параллельный апдейт баланса.
      const granted = await database.transaction(async (client) => {
        const ins = await client.query(
          `INSERT INTO player_achievements (player_id, achievement_id) VALUES ($1,$2)
           ON CONFLICT DO NOTHING RETURNING player_id`,
          [playerId, achievementId],
        );
        // Ачивка уже была открыта параллельным запросом — награду не дублируем.
        if (ins.rowCount === 0) return false;
        if (reward <= 0n) return true;

        const wallet = await client.query<{ id: string; balance: string }>(
          `SELECT id, balance FROM wallets WHERE player_id = $1 AND currency_code = 'CHIP' FOR UPDATE`,
          [playerId],
        );
        const row = wallet.rows[0];
        if (!row) return true;
        const balanceAfter = BigInt(row.balance) + reward;
        await client.query(
          `INSERT INTO ledger_entries (wallet_id, amount, balance_after, tx_type, idempotency_key, reason)
           VALUES ($1, $2, $3, 'grant', $4, $5)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [row.id, reward.toString(), balanceAfter.toString(), `ach:${playerId}:${code}`, `achievement:${code}`],
        );
        return true;
      });

      if (granted) unlocked.push(code);
    }
  } catch (error) {
    // Ачивки не должны ронять раунд: игрок уже получил выигрыш, и падение
    // на выдаче медальки откатило бы всю транзакцию. Но и молчать нельзя —
    // раньше здесь стоял пустой catch, и ошибки выдачи наград не попадали
    // никуда вообще (T-205).
    const report = logger ?? console;
    report.error({ err: error, playerId, event }, "не удалось выдать ачивку");
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
