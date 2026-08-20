/**
 * Web Push (T-079, переписано в T-178).
 *
 * Подписки хранятся в PostgreSQL (`push_subscriptions`), а не в памяти:
 * рестарт API или второй инстанс больше не теряют подписчиков.
 * Если БД недоступна (dev-режим без PG), используется резервное
 * in-memory хранилище — только чтобы не ронять запросы.
 *
 * Сама отправка уведомления пока заглушка: боевой web-push требует
 * VAPID-ключей, которые заводятся на этапе деплоя (см. docs/DEPLOY.md).
 */
import type { Database } from "./db.js";

export interface PushSubscription {
  playerId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
}

/** Резервное хранилище на случай отсутствия БД. */
const memory = new Map<string, PushSubscription[]>();

export async function subscribePush(
  playerId: string,
  sub: Omit<PushSubscription, "playerId" | "createdAt">,
  database?: Database,
): Promise<void> {
  if (database) {
    // Идемпотентно по endpoint: повторная подписка того же браузера
    // не плодит записи, а переносит endpoint на актуального игрока.
    await database.query(
      `INSERT INTO push_subscriptions (player_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE
         SET player_id = EXCLUDED.player_id,
             p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             revoked_at = NULL`,
      [playerId, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
    );
    return;
  }
  const list = memory.get(playerId) ?? [];
  if (!list.some((s) => s.endpoint === sub.endpoint)) {
    list.push({ playerId, ...sub, createdAt: new Date().toISOString() });
    memory.set(playerId, list);
  }
}

export async function unsubscribePush(endpoint: string, database?: Database): Promise<void> {
  if (database) {
    await database.query(`UPDATE push_subscriptions SET revoked_at = now() WHERE endpoint = $1 AND revoked_at IS NULL`, [endpoint]);
    return;
  }
  for (const [playerId, list] of memory) {
    const next = list.filter((s) => s.endpoint !== endpoint);
    if (next.length) memory.set(playerId, next);
    else memory.delete(playerId);
  }
}

export async function getSubscriptions(playerId: string, database?: Database): Promise<PushSubscription[]> {
  if (database) {
    const res = await database.query<{ endpoint: string; p256dh: string; auth: string; created_at: string }>(
      `SELECT endpoint, p256dh, auth, created_at FROM push_subscriptions
       WHERE player_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [playerId],
    );
    return res.rows.map((r) => ({
      playerId,
      endpoint: r.endpoint,
      keys: { p256dh: r.p256dh, auth: r.auth },
      createdAt: r.created_at,
    }));
  }
  return memory.get(playerId) ?? [];
}

export async function sendPushToPlayer(
  playerId: string,
  payload: { title: string; body: string },
  database?: Database,
): Promise<number> {
  const subs = await getSubscriptions(playerId, database);
  // Заглушка доставки: в проде здесь web-push.sendNotification(sub, payload).
  if (process.env.NODE_ENV !== "test") {
    console.log(`[push] ${playerId}: ${payload.title} — ${payload.body} (подписок: ${subs.length})`);
  }
  return subs.length;
}

/** Сброс резервного хранилища — только для тестов. */
export function resetPushMemory(): void {
  memory.clear();
}
