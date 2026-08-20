/**
 * Проверка равенства матожиданий тиров бонус-игры (T-195).
 *
 * Бонус «Сундуки короны» не добавляет денег в игру: он меняет форму серии
 * фриспинов — меньше спинов, но каждый дороже. Значит RTP всех тиров обязан
 * совпадать в пределах статистического шума. Скрипт считает раунды парами
 * (один и тот же nonce во всех тирах), поэтому базовый спин у них одинаковый
 * и сравнение честное.
 *
 * Запуск (сначала `npm run build`):
 *     node scripts/bonus_ev.mjs 2000000
 *
 * Ориентир на 6 млн раундов: расхождение тира ×5 — сотые доли п.п.,
 * тира ×25 — до 0.15 п.п. (у него один спин на всю серию, дисперсия огромна).
 */
import { loadConfig } from "./build/engine/config.js";
import { playRound } from "./build/engine/round.js";
const cfg = loadConfig().config;
const N = Number(process.argv[2] ?? 2000000);
const seed = "e".repeat(64);
const tiers = [1, 5, 25];
const sum = { 1: 0, 5: 0, 25: 0 };
const capped = { 1: 0, 5: 0, 25: 0 };
const maxed = { 1: 0, 5: 0, 25: 0 };
let triggers = 0, bet = 0;
for (let nonce = 0; nonce < N; nonce++) {
  const base = playRound(cfg, seed, "ev-check", nonce, { betPerLine: 1, bonusTier: 1 });
  bet += base.totalBet;
  if (!base.spins.some(s => s.free)) { for (const t of tiers) sum[t] += base.totalWin; continue; }
  triggers++;
  for (const t of tiers) {
    const r = t === 1 ? base : playRound(cfg, seed, "ev-check", nonce, { betPerLine: 1, bonusTier: t });
    sum[t] += r.totalWin;
    if (r.capped) capped[t]++;
    if (r.spins.filter(s => s.free).length >= 200) maxed[t]++;
  }
}
console.log(`раундов ${N}, триггеров ${triggers}`);
for (const t of tiers) {
  console.log(`тир ${String(t).padStart(2)}: RTP ${(sum[t] / bet * 100).toFixed(3)}% · упёрлось в потолок ${capped[t]} · длинных серий ${maxed[t]}`);
}
const d5 = (sum[5] - sum[1]) / bet * 100, d25 = (sum[25] - sum[1]) / bet * 100;
console.log(`отклонение от тира 1: ×5 ${d5 >= 0 ? "+" : ""}${d5.toFixed(3)} п.п. · ×25 ${d25 >= 0 ? "+" : ""}${d25.toFixed(3)} п.п.`);
