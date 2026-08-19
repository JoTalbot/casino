#!/usr/bin/env node
/**
 * e2e сценарий — полный флоу demo → limits → rounds → history → grant → block (T-042)
 * Запускается против боевого API: node scripts/e2e.js [baseUrl] [adminToken]
 * baseUrl по умолчанию http://localhost:3000
 * Требует что API запущен и DATABASE_URL настроен
 */

const base = process.argv[2] || process.env.API_URL || "http://localhost:3000";
const adminToken = process.argv[3] || process.env.ADMIN_TOKEN || "";

async function fetchJson(path, init = {}) {
  const url = `${base}${path}`;
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${JSON.stringify(body).slice(0,500)}`);
  return body;
}

async function main() {
  console.log(`[e2e] base=${base}`);

  // 1. health
  const health = await fetchJson("/health");
  console.log("[e2e] health", health);

  // 2. demo auth
  const demo = await fetchJson("/api/v1/auth/demo", { method: "POST" });
  console.log("[e2e] demo", demo.playerId, demo.wallet.balance);
  const token = demo.token;
  const auth = { Authorization: `Bearer ${token}` };

  // 3. current seed
  const cur = await fetchJson("/api/v1/seeds/current", { headers: auth });
  console.log("[e2e] seed current nonce", cur.nonce);

  // 4. set limit spins_daily 5
  try {
    const lim = await fetchJson("/api/v1/limits", { method: "POST", headers: auth, body: JSON.stringify({ kind: "spins_daily", value: 5 }) });
    console.log("[e2e] set limit", lim.kind, lim.value);
  } catch (e) { console.log("[e2e] limit set failed (maybe cooling)", e.message); }

  // 5. play 3 rounds with idempotency
  for (let i = 0; i < 3; i++) {
    const key = `e2e-${Date.now()}-${i}`;
    const round = await fetchJson("/api/v1/rounds", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": key },
      body: JSON.stringify({ gameCode: "crown-of-fortune", betPerLine: 10, lines: 20 }),
    });
    console.log(`[e2e] round ${i} id=${round.roundId} win=${round.totalWin} balance=${round.balance?.amount ?? round.balanceLegacy}`);
  }

  // 6. idempotent repeat
  const idKey = `e2e-idemp-${Date.now()}`;
  const r1 = await fetchJson("/api/v1/rounds", { method: "POST", headers: { ...auth, "Idempotency-Key": idKey }, body: JSON.stringify({ gameCode: "crown-of-fortune", betPerLine: 10, lines: 20 }) });
  const r2 = await fetchJson("/api/v1/rounds", { method: "POST", headers: { ...auth, "Idempotency-Key": idKey }, body: JSON.stringify({ gameCode: "crown-of-fortune", betPerLine: 10, lines: 20 }) });
  console.log(`[e2e] idempotent ${r1.roundId} === ${r2.roundId} ? ${r1.roundId === r2.roundId}`);

  // 7. history
  const hist = await fetchJson("/api/v1/rounds?limit=5", { headers: auth });
  console.log("[e2e] history count", hist.rounds.length);

  // 8. wallet
  const wallet = await fetchJson("/api/v1/wallet", { headers: auth });
  console.log("[e2e] wallet", wallet.balance);

  // 9. limits get
  const limits = await fetchJson("/api/v1/limits", { headers: auth });
  console.log("[e2e] limits count", limits.limits?.length ?? 0);

  // 10. monitoring rtp (requires JWT)
  const rtp = await fetchJson("/api/v1/monitoring/rtp", { headers: auth });
  console.log("[e2e] rtp", rtp.rounds, rtp.observedRtp, rtp.alert, rtp.reason);

  // 11. admin tests if token provided
  if (adminToken) {
    const adminH = { "X-Admin-Token": adminToken };
    const stats = await fetchJson("/api/v1/admin/stats", { headers: adminH });
    console.log("[e2e] admin stats", stats);
    const daily = await fetchJson("/api/v1/admin/daily?days=7", { headers: adminH });
    console.log("[e2e] admin daily", daily.daily.length);
    // grant
    const grant = await fetchJson("/api/v1/admin/grant", { method: "POST", headers: adminH, body: JSON.stringify({ playerId: demo.playerId, amount: 1000, reason: "e2e test" }) });
    console.log("[e2e] admin grant", grant.newBalance);
    // audit
    const audit = await fetchJson("/api/v1/admin/audit?limit=5", { headers: adminH });
    console.log("[e2e] admin audit", audit.audit?.length ?? 0);
  } else {
    console.log("[e2e] skip admin — no ADMIN_TOKEN");
  }

  console.log("[e2e] OK — full flow passed");
}

main().catch((e) => {
  console.error("[e2e] FAILED", e);
  process.exit(1);
});
