/** Простой чат (T-061) */
import type { Database } from "./db.js";

const MAX_LEN = 500;
const RATE_LIMIT = 5; // сообщений в минуту

const recent = new Map<string, number[]>();

export function canChat(playerId: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const arr = recent.get(playerId) ?? [];
  const recentFiltered = arr.filter((t) => t > now - 60_000);
  if (recentFiltered.length >= RATE_LIMIT) {
    const oldest = recentFiltered[0];
    return { allowed: false, retryAfterMs: 60_000 - (now - oldest) };
  }
  recentFiltered.push(now);
  recent.set(playerId, recentFiltered);
  return { allowed: true };
}

export async function postMessage(database: Database, playerId: string, username: string, message: string) {
  if (!message || message.length > MAX_LEN) throw new Error("Сообщение 1…500 символов");
  const trimmed = message.trim();
  if (!trimmed) throw new Error("Пустое сообщение");
  const res = await database.query<{ id: string; created_at: string }>(
    `INSERT INTO chat_messages (player_id, username, message) VALUES ($1,$2,$3) RETURNING id, created_at`,
    [playerId, username, trimmed],
  );
  return res.rows[0];
}

export async function listMessages(database: Database, limit = 50) {
  const lim = Math.min(Math.max(limit, 1), 100);
  const res = await database.query<{
    id: string;
    player_id: string;
    username: string;
    message: string;
    created_at: string;
  }>(`SELECT id, player_id, username, message, created_at FROM chat_messages ORDER BY created_at DESC LIMIT $1`, [lim]);
  return res.rows.reverse(); // от старых к новым
}
