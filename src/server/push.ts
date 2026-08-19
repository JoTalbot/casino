/** Web Push (T-079) — in-memory подписки, для демо */
export interface PushSubscription {
  playerId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
}

const subs = new Map<string, PushSubscription[]>();

export async function subscribePush(playerId: string, sub: Omit<PushSubscription, 'playerId' | 'createdAt'>): Promise<void> {
  const list = subs.get(playerId) ?? [];
  // дедупликация по endpoint
  if (!list.some(s => s.endpoint === sub.endpoint)) {
    list.push({ playerId, ...sub, createdAt: new Date().toISOString() });
    subs.set(playerId, list);
  }
}

export async function getSubscriptions(playerId: string): Promise<PushSubscription[]> {
  return subs.get(playerId) ?? [];
}

export async function sendPushToPlayer(playerId: string, payload: { title: string; body: string }): Promise<number> {
  // Заглушка — в проде здесь web-push sendNotification
  console.log(`[push] to ${playerId}: ${payload.title} - ${payload.body} (subs: ${(subs.get(playerId)?.length ?? 0)})`);
  return subs.get(playerId)?.length ?? 0;
}
