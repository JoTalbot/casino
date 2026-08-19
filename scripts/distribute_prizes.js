#!/usr/bin/env node
/**
 * Раздача призов турниров — тем кто в топ-3 получает prize_pool / 3 (T-066)
 * + email уведомление (T-090)
 * Запуск: DATABASE_URL=... node scripts/distribute_prizes.js weekly-champions
 */
import pg from "pg";
const { Pool } = pg;
const code = process.argv[2] || "weekly-champions";
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error("Need DATABASE_URL"); process.exit(1); }
const pool = new Pool({ connectionString: dbUrl });

async function sendEmail(to, subject, text) {
  try {
    const smtpHost = process.env.SMTP_HOST;
    if (!smtpHost) {
      console.log(`[email mock] to ${to} subject ${subject}`);
      return;
    }
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT || 587),
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    await transporter.sendMail({ from: process.env.SMTP_FROM || "no-reply@casino.local", to, subject, text });
    console.log(`[email] sent to ${to}`);
  } catch (e) { console.error("[email] failed", e.message); }
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tourRes = await client.query(`SELECT id, prize_pool, ends_at, title FROM tournaments WHERE code = $1 FOR UPDATE`, [code]);
    if (!tourRes.rows[0]) { console.log("Tournament not found", code); await client.query("ROLLBACK"); return; }
    const tour = tourRes.rows[0];
    if (new Date(tour.ends_at) > new Date()) { console.log("Tournament still active, ends at", tour.ends_at); await client.query("ROLLBACK"); return; }
    if (tourRes.rows[0].status === 'finished') { console.log("Already finished"); await client.query("ROLLBACK"); return; }
    const top = await client.query(
      `SELECT p.id as player_id, p.username, p.email, ts.total_win FROM tournament_scores ts JOIN players p ON p.id = ts.player_id WHERE ts.tournament_id = $1 ORDER BY ts.total_win DESC LIMIT 3`,
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
      console.log(`Granted ${prizeEach} to ${row.player_id} (${row.username}) for tournament ${code}`);
      if (row.email) {
        await sendEmail(row.email, `Турнир ${tour.title} — ты в топ-3!`, `Поздравляем, ${row.username}! Ты выиграл ${prizeEach} CHIP в турнире ${tour.title}.`);
      }
    }
    await client.query(`UPDATE tournaments SET status = 'finished' WHERE id = $1`, [tour.id]);
    await client.query("COMMIT");
    console.log("Prizes distributed and tournament finished");
  } catch (e) { await client.query("ROLLBACK"); console.error(e); }
  finally { client.release(); await pool.end(); }
}
main();
