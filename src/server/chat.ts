/** Простой чат (T-061, T-071) */
import type { Database } from "./db.js";

const MAX_LEN = 500;
const RATE_LIMIT = 5; // сообщений в минуту

const recent = new Map<string, number[]>();

/**
 * Фильтр мата и спама (T-206).
 *
 * Прошлая версия искала четыре слова подстрокой в сыром тексте. Она
 * одновременно пропускала «х у й» и «s.c.a.m» и блокировала невинное
 * «всем удачи» — из-за подстроки «муда». Поэтому здесь два правила:
 * сравнение идёт по словам и по началу слова (чтобы ловить склонения),
 * а склейка всего текста проверяется отдельно — только когда видно
 * характерное растаскивание по буквам.
 */

/** Начала слов. Ловят склонения: «блядь», «блядский», «ебанутый». */
const BAD_STEMS = ["хуй", "хуя", "хуе", "пизд", "бляд", "ебан", "ебат", "ебал", "сука", "суки", "мудак", "гандон", "залуп"];

/**
 * Слова, которые ловятся только целиком.
 *
 * «скам» — начало совершенно приличной «скамейки», поэтому сравнивать его
 * по началу слова нельзя: ложное срабатывание раздражает сильнее, чем
 * пропущенный спам.
 */
const BAD_EXACT = ["скам", "скама", "скамом", "спам", "спама", "спамом"];

/** Латинские слова целиком: как отдельные слова, так и в склейке. */
const BAD_LATIN = ["spam", "scam", "casino777", "porn"];

/** Латиница и цифры, которыми маскируют кириллицу. */
const LOOKALIKE: Record<string, string> = {
  a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у", k: "к", m: "м", t: "т", h: "н", b: "в", u: "у",
  "0": "о", "3": "з", "4": "ч", "6": "б", "@": "а",
};

/** Нижний регистр, похожие символы, только буквы, схлопнутые повторы. */
function normalizeWord(word: string): string {
  const mapped = [...word.toLowerCase()].map((ch) => LOOKALIKE[ch] ?? ch).join("");
  return mapped.replace(/[^a-zа-яё]/g, "").replace(/(.)\1{1,}/g, "$1");
}

function splitWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zа-яё0-9@$]+/i)
    .filter(Boolean);
}

/**
 * Слово в двух видах: как написано и с заменой похожих символов.
 *
 * Одной нормализации мало: замена латиницы на кириллицу ломает латинские
 * слова («scam» превращался в «sсам» и переставал ловиться), а без замены
 * не поймать «xyu». Поэтому проверяются оба варианта.
 */
function bothForms(token: string): { raw: string; cyr: string } {
  const raw = token.replace(/[^a-zа-яё0-9]/g, "").replace(/(.)\1{1,}/g, "$1");
  return { raw, cyr: normalizeWord(token) };
}

function hitsStem(token: string): boolean {
  const { raw, cyr } = bothForms(token);
  if (!raw && !cyr) return false;
  if (BAD_LATIN.some((bad) => raw.startsWith(bad))) return true;
  if (BAD_EXACT.includes(cyr)) return true;
  return BAD_STEMS.some((stem) => cyr.startsWith(stem));
}

export function containsBadWord(text: string): boolean {
  const tokens = splitWords(text);
  if (tokens.some(hitsStem)) return true;

  // Растаскивание по буквам: «с к а м», «s.c.a.m». Склеиваем только когда
  // коротких кусков большинство, иначе склейка сама начнёт давать ложные
  // срабатывания на обычном тексте.
  const short = tokens.filter((t) => bothForms(t).raw.length <= 2).length;
  if (short >= 3 && short >= tokens.length / 2) {
    const gluedRaw = tokens.map((t) => bothForms(t).raw).join("");
    const gluedCyr = tokens.map((t) => bothForms(t).cyr).join("");
    if (BAD_LATIN.some((bad) => gluedRaw.includes(bad))) return true;
    if (BAD_STEMS.some((stem) => gluedCyr.includes(stem))) return true;
    if (BAD_EXACT.some((bad) => gluedCyr.includes(bad))) return true;
  }
  return false;
}

/** Экспортируется для тестов: фильтр без нормализации бесполезен. */
export const chatFilter = { normalizeWord, containsBadWord };

export function canChat(playerId: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  // T-176: чистим протухшие записи, иначе Map растёт по числу игроков без границы.
  if (recent.size > 1000) {
    for (const [id, stamps] of recent) {
      if (!stamps.some((t) => t > now - 60_000)) recent.delete(id);
    }
  }
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

/** Сброс счётчиков — только для тестов. */
export function resetChatLimits(): void {
  recent.clear();
}

export async function postMessage(database: Database, playerId: string, username: string, message: string) {
  // T-176: длину проверяем ПОСЛЕ trim, иначе сообщение из 500 символов
  // с пробелами по краям отклонялось, а строка из одних пробелов
  // сначала проходила проверку длины.
  const trimmed = (message ?? "").trim();
  if (!trimmed) throw new Error("Пустое сообщение");
  if (trimmed.length > MAX_LEN) throw new Error(`Сообщение не длиннее ${MAX_LEN} символов`);
  if (containsBadWord(trimmed)) throw new Error("Сообщение содержит запрещённые слова");

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
  return res.rows.reverse();
}

export async function deleteMessage(database: Database, messageId: string) {
  await database.query(`DELETE FROM chat_messages WHERE id = $1`, [messageId]);
}

