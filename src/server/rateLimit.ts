/** Простой in-memory rate limiter для POST /rounds: 10 req/s на игрока (T-038) */

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly maxPerSecond: number = 10) {}

  /** Возвращает true если разрешено, false если превышен лимит */
  check(playerId: string, now = Date.now()): { allowed: boolean; retryAfterMs?: number } {
    const windowMs = 1000;
    const arr = this.hits.get(playerId) ?? [];
    // убираем старые старше 1 сек
    const cutoff = now - windowMs;
    const recent = arr.filter((t) => t > cutoff);
    if (recent.length >= this.maxPerSecond) {
      const oldest = recent[0];
      const retryAfterMs = windowMs - (now - oldest);
      this.hits.set(playerId, recent);
      return { allowed: false, retryAfterMs };
    }
    recent.push(now);
    this.hits.set(playerId, recent);
    return { allowed: true };
  }

  reset(playerId?: string): void {
    if (playerId) this.hits.delete(playerId);
    else this.hits.clear();
  }
}

export const globalRateLimiter = new RateLimiter(10);
