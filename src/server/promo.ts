/**
 * Промокоды на виртуальные фишки (T-213).
 *
 * Механика намеренно повторяет то, что понадобится при работе с реальными
 * деньгами: лимит активаций, лимит на игрока, срок действия, идемпотентное
 * начисление через журнал проводок и запись в аудит. Разница будет только
 * в валюте — а её сейчас нет и быть не может: лицензии у проекта нет
 * (AGENTS.md §11), фишки CHIP денежной ценности не имеют.
 */
import type { Database } from "./db.js";

export type PromoFailure =
  | "NOT_FOUND"
  | "INACTIVE"
  | "NOT_STARTED"
  | "EXPIRED"
  | "EXHAUSTED"
  | "ALREADY_USED"
  | "NO_WALLET";

export interface PromoResult {
  ok: boolean;
  reason?: PromoFailure;
  chips?: number;
  balance?: string;
  code?: string;
}

/** Приводит ввод игрока к каноническому виду: регистр и пробелы не важны. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

interface PromoRow {
  id: string;
  code: string;
  chips: string;
  max_activations: number | null;
  per_player: number;
  starts_at: string;
  expires_at: string | null;
  is_active: boolean;
}

/**
 * Активирует промокод.
 *
 * Вся проверка и начисление — в одной транзакции с блокировкой строки
 * промокода. Без блокировки два одновременных запроса на последнюю
 * активацию оба прошли бы проверку «лимит не исчерпан» и выдали фишки
 * дважды: классическая гонка, из-за которой промокоды и утекают.
 */
export async function redeemPromo(
  database: Database,
  playerId: string,
  rawCode: string,
  now: Date = new Date(),
): Promise<PromoResult> {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, reason: "NOT_FOUND" };

  return database.transaction(async (client) => {
    const promoRes = await client.query<PromoRow>(
      `SELECT id, code, chips, max_activations, per_player, starts_at, expires_at, is_active
       FROM promo_codes WHERE code = $1 FOR UPDATE`,
      [code],
    );
    const promo = promoRes.rows[0];
    if (!promo) return { ok: false, reason: "NOT_FOUND" as const };
    if (!promo.is_active) return { ok: false, reason: "INACTIVE" as const };
    if (new Date(promo.starts_at) > now) return { ok: false, reason: "NOT_STARTED" as const };
    if (promo.expires_at && new Date(promo.expires_at) <= now) return { ok: false, reason: "EXPIRED" as const };

    const counts = await client.query<{ total: string; mine: string }>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE player_id = $2) AS mine
       FROM promo_redemptions WHERE promo_id = $1`,
      [promo.id, playerId],
    );
    const total = Number(counts.rows[0]?.total ?? 0);
    const mine = Number(counts.rows[0]?.mine ?? 0);

    if (promo.max_activations !== null && total >= promo.max_activations) {
      return { ok: false, reason: "EXHAUSTED" as const };
    }
    if (mine >= promo.per_player) return { ok: false, reason: "ALREADY_USED" as const };

    const wallet = await client.query<{ id: string; balance: string }>(
      "SELECT id, balance FROM wallets WHERE player_id = $1 AND currency_code = 'CHIP' FOR UPDATE",
      [playerId],
    );
    const walletRow = wallet.rows[0];
    if (!walletRow) return { ok: false, reason: "NO_WALLET" as const };

    const chips = BigInt(promo.chips);
    const balanceAfter = BigInt(walletRow.balance) + chips;

    await client.query(
      "INSERT INTO promo_redemptions (promo_id, player_id, chips) VALUES ($1, $2, $3)",
      [promo.id, playerId, chips.toString()],
    );
    // Ключ идемпотентности включает номер активации: при per_player > 1
    // один игрок может активировать код несколько раз, и ключи не должны
    // совпасть, иначе вторая проводка молча потеряется.
    await client.query(
      `INSERT INTO ledger_entries (wallet_id, amount, balance_after, tx_type, idempotency_key, reason)
       VALUES ($1, $2, $3, 'grant', $4, $5)`,
      [walletRow.id, chips.toString(), balanceAfter.toString(), `promo:${promo.id}:${playerId}:${mine + 1}`, `promo:${promo.code}`],
    );
    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, event_type, subject_type, subject_id, payload)
       VALUES ('player', $1, 'promo.redeemed', 'promo', $2, $3)`,
      [playerId, promo.id, JSON.stringify({ code: promo.code, chips: chips.toString() })],
    );

    return {
      ok: true,
      chips: Number(chips),
      balance: balanceAfter.toString(),
      code: promo.code,
    };
  });
}

export interface CreatePromoInput {
  code: string;
  chips: number;
  maxActivations?: number | null;
  perPlayer?: number;
  expiresAt?: string | null;
  comment?: string;
}

/** Создаёт промокод. Вызывается только из админки. */
export async function createPromo(database: Database, input: CreatePromoInput): Promise<{ id: string; code: string }> {
  const code = normalizeCode(input.code);
  if (code.length < 3 || code.length > 32) throw new Error("Код должен быть длиной 3…32 символа");
  if (!Number.isInteger(input.chips) || input.chips <= 0) throw new Error("Количество фишек — целое положительное");

  const res = await database.query<{ id: string; code: string }>(
    `INSERT INTO promo_codes (code, chips, max_activations, per_player, expires_at, comment)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, code`,
    [
      code,
      input.chips,
      input.maxActivations ?? null,
      input.perPlayer ?? 1,
      input.expiresAt ?? null,
      input.comment ?? null,
    ],
  );
  return res.rows[0]!;
}

/** Список промокодов со счётчиком активаций — для админки. */
export async function listPromos(database: Database, limit = 50) {
  const lim = Math.min(Math.max(limit, 1), 200);
  const res = await database.query<{
    id: string;
    code: string;
    chips: string;
    max_activations: number | null;
    per_player: number;
    expires_at: string | null;
    is_active: boolean;
    used: string;
  }>(
    `SELECT p.id, p.code, p.chips, p.max_activations, p.per_player, p.expires_at, p.is_active,
            (SELECT COUNT(*) FROM promo_redemptions r WHERE r.promo_id = p.id) AS used
     FROM promo_codes p ORDER BY p.created_at DESC LIMIT $1`,
    [lim],
  );
  return res.rows;
}
