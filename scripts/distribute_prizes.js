#!/usr/bin/env node
/**
 * Раздача призов турниров — тем кто в топ-3 получает prize_pool / 3 (T-066)
 * Запуск: DATABASE_URL=... node scripts/distribute_prizes.js weekly-champions
 */
import pg from "pg";
const { Pool } = pg;
const code = process.argv[2] || "weekly-champions";
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error("Need DATABASE_URL"); process.exit(1); }
const pool = new Pool({ connectionString: dbUrl });
async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tourRes = await client.query(`SELECT id, prize_pool, ends_at FROM tournaments WHERE code = $1 FOR UPDATE`, [code]);
    if (!tourRes.rows[0]) { console.log("Tournament not found", code); await client.query("ROLLBACK"); return; }
    const tour = tourRes.rows[0];
    if (new Date(tour.ends_at) > new Date()) { console.log("Tournament still active, ends at", tour.ends_at); await client.query("ROLLBACK"); return; }
    // топ-3
    const top = await client.query(
      `SELECT player_id, total_win FROM tournament_scores WHERE tournament_id = $1 ORDER BY total_win DESC LIMIT 3`,
      [tour.id]
    );
    if (top.rows.length === 0) { console.log("No scores"); await client.query("ROLLBACK"); return; }
    const prizeEach = BigInt(tour.prize_pool) / BigInt(top.rows.length);
    for (const row of top.rows) {
      const walletRes = await client.query(`SELECT id, balance FROM wallets WHERE player_id = $1 AND currency_code='CHIP' FOR UPDATE`, [row.player_id]);
      if (!walletRes.rows[0]) continue;
      const walletId = walletRes.rows[0].id;
      const newBal = BigInt(walletRes.rows[0].balance) + prizeEach;
      const key = `tournament-prize:${tour.id}:${row.player_id}`;
      await client.query(
        `INSERT INTO ledger_entries (wallet_id, amount, balance_after, tx_type, idempotency_key, reason) VALUES ($1,$2,$3,'grant',$4,'tournament-prize') ON CONFLICT (idempotency_key) DO NOTHING`,
        [walletId, prizeEach.toString(), newBal.toString(), key]
      );
      console.log(`Granted ${prizeEach} to ${row.player_id} for tournament ${code}`);
    }
    await client.query(`UPDATE tournaments SET status = 'finished' WHERE id = $1`, [tour.id]);
    await client.query("COMMIT");
    console.log("Prizes distributed");
  } catch (e) { await client.query("ROLLBACK"); console.error(e); }
  finally { client.release(); await pool.end(); }
}
main();
