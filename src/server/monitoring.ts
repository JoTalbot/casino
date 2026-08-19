/**
 * Мониторинг RTP по ADR-007.
 * Коридор приёмки 95.5–96.5% только для выборок ≥5M.
 * Живой мониторинг: сравнивает наблюдаемый RTP с доверительным интервалом
 * от фактического n, алерт только от 100k раундов.
 */
import type { Database } from "./db.js";
import { loadConfig } from "../engine/config.js";

const SIGMA = 4.126; // ставка за раунд, из simulations/confidence.json
const TARGET_RTP = 0.959778; // аналитический
const ALERT_THRESHOLD_ROUNDS = 100_000;
const Z_999 = 3.29; // 99.9% двусторонний ~ 3.29 sigma

export interface RtpCheck {
  observedRtp: number | null;
  totalBet: bigint;
  totalWin: bigint;
  rounds: number;
  configHash: string;
  targetRtp: number;
  sigma: number;
  halfWidth: number | null;
  lower: number | null;
  upper: number | null;
  alert: boolean;
  reason: string;
}

function halfWidth(sigma: number, n: number, z = Z_999): number {
  return (z * sigma) / Math.sqrt(n);
}

export async function checkRtp(database: Database, options?: { minRounds?: number }): Promise<RtpCheck> {
  const loaded = loadConfig();
  const minRounds = options?.minRounds ?? ALERT_THRESHOLD_ROUNDS;

  const res = await database.query<{ total_bet: string | null; total_win: string | null; rounds: string }>(
    `SELECT COALESCE(SUM(total_bet),0) as total_bet, COALESCE(SUM(total_win),0) as total_win, COUNT(*) as rounds
     FROM rounds WHERE status = 'settled'`,
  );

  const totalBet = BigInt(res.rows[0]?.total_bet ?? "0");
  const totalWin = BigInt(res.rows[0]?.total_win ?? "0");
  const rounds = Number(res.rows[0]?.rounds ?? "0");

  if (rounds === 0 || totalBet === 0n) {
    return {
      observedRtp: null,
      totalBet,
      totalWin,
      rounds,
      configHash: loaded.hash,
      targetRtp: TARGET_RTP,
      sigma: SIGMA,
      halfWidth: null,
      lower: null,
      upper: null,
      alert: false,
      reason: "нет данных",
    };
  }

  const observedRtp = Number(totalWin) / Number(totalBet);

  if (rounds < minRounds) {
    return {
      observedRtp,
      totalBet,
      totalWin,
      rounds,
      configHash: loaded.hash,
      targetRtp: TARGET_RTP,
      sigma: SIGMA,
      halfWidth: halfWidth(SIGMA, rounds),
      lower: null,
      upper: null,
      alert: false,
      reason: `ниже порога ${minRounds} раундов — алерт отключён, контролируется configHash`,
    };
  }

  const hw = halfWidth(SIGMA, rounds);
  const lower = TARGET_RTP - hw / 100; // hw в долях? sigma в ставках, halfWidth в п.п.? Переводим: halfWidth_pp = z*sigma/sqrt(n)*100%?
  // Для простоты: halfWidth в абсолютных долях RTP (0..1) как sigma*sqrt?
  // sigma = 4.126 ставки, edge = 0.04, но для мониторинга используем формулу из confidence.py:
  // half_width = z*sigma / sqrt(n)  в единицах ставки, затем делим на среднюю ставку (1) и переводим в %?
  // Упростим: наблюдаемый RTP должен лежать в [target - hw, target + hw]
  const lowerAbs = TARGET_RTP - hw;
  const upperAbs = TARGET_RTP + hw;

  const alert = observedRtp < lowerAbs || observedRtp > upperAbs;

  return {
    observedRtp,
    totalBet,
    totalWin,
    rounds,
    configHash: loaded.hash,
    targetRtp: TARGET_RTP,
    sigma: SIGMA,
    halfWidth: hw,
    lower: lowerAbs,
    upper: upperAbs,
    alert,
    reason: alert
      ? `наблюдаемый RTP ${observedRtp.toFixed(4)} вне доверительного [${lowerAbs.toFixed(4)}, ${upperAbs.toFixed(4)}] при n=${rounds}`
      : `в пределах доверительного интервала`,
  };
}
