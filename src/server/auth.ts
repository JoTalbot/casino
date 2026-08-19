/**
 * Сервис гостевой аутентификации для соц-казино.
 * Создаёт игрока, кошелёк CHIP и первую пару сидов в одной транзакции.
 * Никаких реальных денег: только виртуальные фишки.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "./db.js";
import { generateClientSeed, generateServerSeed, hashServerSeed } from "../engine/rng.js";
import type { LoadedConfig } from "../engine/config.js";

export interface GuestPlayer {
  playerId: string;
  username: string;
  walletBalance: bigint;
  seedPairId: string;
  serverSeedHash: string;
  clientSeed: string;
}

function randomUsername(): string {
  return `guest_${randomBytes(4).toString("hex")}`;
}

/** Гарантирует наличие игры crown-of-fortune и её активной конфигурации в БД. */
export async function ensureGameExists(database: Database, loaded: LoadedConfig): Promise<{ gameId: string; gameConfigId: string }> {
  return database.transaction(async (client) => {
    let gameRes = await client.query<{ id: string }>("SELECT id FROM games WHERE code = 'crown-of-fortune' LIMIT 1");
    let gameId: string;
    if (gameRes.rows[0]) {
      gameId = gameRes.rows[0].id;
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO games (code, title, reels, row_count, lines, is_enabled)
         VALUES ('crown-of-fortune', $1, 5, 3, $2, true) RETURNING id`,
        [loaded.config.name, loaded.config.lines],
      );
      gameId = inserted.rows[0]!.id;
    }

    // Конфигурация с этим хэшем
    const cfgRes = await client.query<{ id: string }>(
      "SELECT id FROM game_configs WHERE config_hash = $1 LIMIT 1",
      [loaded.hash],
    );
    let gameConfigId: string;
    if (cfgRes.rows[0]) {
      gameConfigId = cfgRes.rows[0].id;
      await client.query(
        "UPDATE game_configs SET is_active = true, game_id = $1 WHERE id = $2",
        [gameId, gameConfigId],
      );
    } else {
      // Деактивируем старые активные конфиги этой игры
      await client.query("UPDATE game_configs SET is_active = false WHERE game_id = $1 AND is_active = true", [gameId]);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO game_configs (game_id, version, config_hash, config_json, analytic_rtp, is_active, max_win_x)
         VALUES ($1, $2, $3, $4::jsonb, $5, true, $6) RETURNING id`,
        [
          gameId,
          loaded.config.version,
          loaded.hash,
          JSON.stringify(loaded.raw),
          loaded.config.targetRtp,
          loaded.config.maxWinCap,
        ],
      );
      gameConfigId = inserted.rows[0]!.id;
    }

    return { gameId, gameConfigId };
  });
}

export async function createGuestPlayer(
  database: Database,
  loaded: LoadedConfig,
  initialBalance = 100_000n,
): Promise<GuestPlayer> {
  // Сначала гарантируем игру — вне транзакции создания игрока, чтобы не держать длинную транзакцию
  await ensureGameExists(database, loaded);

  return database.transaction(async (client) => {
    const username = randomUsername();
    const playerRes = await client.query<{ id: string }>(
      "INSERT INTO players (username, locale, status) VALUES ($1, 'ru', 'active') RETURNING id",
      [username],
    );
    const playerId = playerRes.rows[0]!.id;

    const walletRes = await client.query<{ id: string; balance: string }>(
      "INSERT INTO wallets (player_id, currency_code, balance) VALUES ($1, 'CHIP', $2) RETURNING id, balance",
      [playerId, initialBalance.toString()],
    );
    const walletId = walletRes.rows[0]!.id;

    await client.query(
      "INSERT INTO ledger_entries (wallet_id, amount, balance_after, tx_type, idempotency_key, reason) VALUES ($1, $2, $3, 'grant', $4, $5)",
      [walletId, initialBalance.toString(), initialBalance.toString(), `grant:${playerId}:initial`, "initial grant"],
    );

    const serverSeed = generateServerSeed();
    const serverSeedHash = hashServerSeed(serverSeed);
    const clientSeed = generateClientSeed();

    const seedRes = await client.query<{ id: string }>(
      `INSERT INTO seed_pairs (player_id, server_seed, server_seed_hash, client_seed, next_nonce, status)
       VALUES ($1, $2, $3, $4, 0, 'active') RETURNING id`,
      [playerId, serverSeed, serverSeedHash, clientSeed],
    );

    await client.query(
      "INSERT INTO audit_log (actor_type, actor_id, event_type, subject_type, subject_id, payload) VALUES ('player', $1, 'player.created', 'player', $1, $2)",
      [playerId, JSON.stringify({ username })],
    );

    return {
      playerId,
      username,
      walletBalance: initialBalance,
      seedPairId: seedRes.rows[0]!.id,
      serverSeedHash,
      clientSeed,
    };
  });
}
