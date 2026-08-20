/**
 * Аутентификация Telegram Mini App (T-197).
 *
 * Telegram передаёт в WebApp строку `initData` — те же query-параметры,
 * что видит клиент, плюс `hash`. Доверять содержимому можно ТОЛЬКО после
 * проверки подписи: иначе кто угодно откроет наш URL в браузере и
 * представится любым telegram_id.
 *
 * Алгоритм (документация Telegram, «Validating data received via the Mini App»):
 *   secret = HMAC_SHA256(key = "WebAppData", data = <токен бота>)
 *   hash   = HMAC_SHA256(key = secret, data = <отсортированные пары k=v через \n>)
 * Пара `hash` из проверки исключается.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Database } from "./db.js";

export interface TelegramUser {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
  isPremium?: boolean;
}

export class TelegramAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TelegramAuthError";
  }
}

/** Максимальный возраст initData. Защита от переигрывания старой строки. */
const MAX_AGE_SECONDS = 24 * 60 * 60;

export function verifyInitData(initData: string, botToken: string, now = Date.now()): TelegramUser {
  if (!initData) throw new TelegramAuthError("INIT_DATA_EMPTY", "initData пуст.");

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new TelegramAuthError("INIT_DATA_NO_HASH", "В initData нет подписи.");

  params.delete("hash");
  // Telegram подписывает пары, отсортированные по имени ключа.
  const checkString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = createHmac("sha256", secret).update(checkString).digest("hex");

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  // Сравнение постоянного времени: обычное сравнение строк утекает информацию
  // о совпавшем префиксе и позволяет подбирать подпись побайтно.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new TelegramAuthError("INIT_DATA_BAD_SIGNATURE", "Подпись initData не сходится.");
  }

  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || now / 1000 - authDate > MAX_AGE_SECONDS) {
    throw new TelegramAuthError("INIT_DATA_EXPIRED", "initData просрочен.");
  }

  const rawUser = params.get("user");
  if (!rawUser) throw new TelegramAuthError("INIT_DATA_NO_USER", "В initData нет пользователя.");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawUser) as Record<string, unknown>;
  } catch {
    throw new TelegramAuthError("INIT_DATA_BAD_USER", "Пользователь в initData не разбирается.");
  }

  const id = Number(parsed.id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new TelegramAuthError("INIT_DATA_BAD_USER", "Некорректный id пользователя.");
  }

  return {
    id,
    username: typeof parsed.username === "string" ? parsed.username : undefined,
    firstName: typeof parsed.first_name === "string" ? parsed.first_name : undefined,
    lastName: typeof parsed.last_name === "string" ? parsed.last_name : undefined,
    languageCode: typeof parsed.language_code === "string" ? parsed.language_code : undefined,
    isPremium: parsed.is_premium === true,
  };
}

/** Имя игрока: узнаваемое, но без коллизий с чужими никами. */
export function playerNameFor(user: TelegramUser): string {
  const base = (user.username ?? user.firstName ?? "player")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20);
  return `tg_${base || "player"}_${user.id.toString(36)}`;
}

export interface LinkedPlayer {
  playerId: string;
  username: string;
  created: boolean;
}

/**
 * Находит игрока по telegram_id или создаёт нового вместе с кошельком
 * и стартовым грантом. Всё в одной транзакции: игрок без кошелька —
 * это раунд, падающий на первом же спине.
 */
export async function linkTelegramPlayer(
  database: Database,
  user: TelegramUser,
  initialBalance = 100_000n,
): Promise<LinkedPlayer> {
  return database.transaction(async (client) => {
    const existing = await client.query<{ id: string; username: string }>(
      "SELECT id, username FROM players WHERE telegram_id = $1 AND deleted_at IS NULL",
      [user.id],
    );
    if (existing.rows[0]) {
      await client.query("UPDATE players SET last_seen_at = now() WHERE id = $1", [existing.rows[0].id]);
      return { playerId: existing.rows[0].id, username: existing.rows[0].username, created: false };
    }

    const username = playerNameFor(user);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO players (username, locale, status, telegram_id, last_seen_at)
       VALUES ($1, $2, 'active', $3, now()) RETURNING id`,
      [username, user.languageCode ?? "ru", user.id],
    );
    const playerId = inserted.rows[0]!.id;

    // Кошелёк создаётся с нулём: баланс — производная от журнала проводок,
    // его поднимает триггер (см. T-184).
    const wallet = await client.query<{ id: string }>(
      "INSERT INTO wallets (player_id, currency_code, balance) VALUES ($1, 'CHIP', 0) RETURNING id",
      [playerId],
    );
    await client.query(
      `INSERT INTO ledger_entries (wallet_id, amount, balance_after, tx_type, idempotency_key, reason)
       VALUES ($1, $2, $2, 'grant', $3, 'telegram-welcome')`,
      [wallet.rows[0]!.id, initialBalance.toString(), `grant:${playerId}:initial`],
    );
    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, event_type, subject_type, subject_id, payload)
       VALUES ('player', $1, 'player.created', 'player', $1, $2)`,
      [playerId, JSON.stringify({ username, source: "telegram", telegramId: user.id })],
    );

    return { playerId, username, created: true };
  });
}


// --- Бот: обработка обновлений -------------------------------------------

/** Минимальный кусок update, который нам интересен. */
export interface TelegramUpdate {
  message?: {
    chat?: { id: number };
    text?: string;
    from?: { first_name?: string };
  };
}

export interface BotReply {
  chatId: number;
  text: string;
  webAppUrl?: string;
}

/**
 * Что бот отвечает на сообщение. Вынесено отдельно от отправки, чтобы
 * логику можно было проверить тестом без сети.
 */
export function replyForUpdate(update: TelegramUpdate, webAppUrl: string): BotReply | null {
  const chatId = update.message?.chat?.id;
  if (!chatId) return null;

  const text = (update.message?.text ?? "").trim().toLowerCase();
  const name = update.message?.from?.first_name;
  const greeting = name ? `${name}, добро пожаловать в Crown of Fortune!` : "Добро пожаловать в Crown of Fortune!";

  if (text.startsWith("/start") || text.startsWith("/play") || text.startsWith("/игра")) {
    return {
      chatId,
      text:
        `${greeting}\n\n` +
        "Слот на виртуальных фишках: реальных денег нет, купить или вывести ничего нельзя. " +
        "Каждый раунд считается на сервере и проверяется офлайн — честность доказуема.\n\n" +
        "Жми кнопку ниже, стартовый баланс 100 000 фишек уже начислен.",
      webAppUrl,
    };
  }

  if (text.startsWith("/help") || text.startsWith("/помощь")) {
    return {
      chatId,
      text:
        "Команды:\n" +
        "/start — открыть игру\n" +
        "/help — эта справка\n\n" +
        "18+. Игра на виртуальных фишках, без ставок на деньги.",
      webAppUrl,
    };
  }

  return {
    chatId,
    text: "Не понял команду. /start — открыть игру, /help — справка.",
    webAppUrl,
  };
}

/** Отправляет ответ через Bot API. Ошибки не роняют обработку update. */
export async function sendBotReply(botToken: string, reply: BotReply): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: reply.chatId,
    text: reply.text,
    parse_mode: "HTML",
  };
  if (reply.webAppUrl) {
    body.reply_markup = {
      inline_keyboard: [[{ text: "🎰 Играть", web_app: { url: reply.webAppUrl } }]],
    };
  }
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
