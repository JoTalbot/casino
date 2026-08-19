/** Реестр игр: доказывает, что движок переиспользуется для второй игры (T-029) */
import { loadConfig, type LoadedConfig } from "../engine/config.js";
import type { Database } from "./db.js";

export interface GameEntry {
  code: string;
  loaded: LoadedConfig;
}

export function loadGames(): Map<string, GameEntry> {
  const map = new Map<string, GameEntry>();
  try {
    const main = loadConfig("config/game.json");
    map.set("crown-of-fortune", { code: "crown-of-fortune", loaded: main });
  } catch {
    // ignore if missing
  }
  try {
    const second = loadConfig("config/second-game.json");
    map.set("crown-of-fortune-ii", { code: "crown-of-fortune-ii", loaded: second });
  } catch {
    // second game optional
  }
  return map;
}

export async function ensureAllGames(database: Database, games: Map<string, GameEntry>): Promise<void> {
  for (const [code, entry] of games) {
    const cfg = entry.loaded;
    // В одной транзакции на игру
    await database.transaction(async (client) => {
      let gameRes = await client.query<{ id: string }>("SELECT id FROM games WHERE code = $1", [code]);
      let gameId: string;
      if (gameRes.rows[0]) {
        gameId = gameRes.rows[0].id;
      } else {
        const ins = await client.query<{ id: string }>(
          `INSERT INTO games (code, title, reels, row_count, lines, is_enabled) VALUES ($1,$2,5,3,$3,true) RETURNING id`,
          [code, cfg.config.name, cfg.config.lines],
        );
        gameId = ins.rows[0]!.id;
      }
      const cfgRes = await client.query<{ id: string }>("SELECT id FROM game_configs WHERE config_hash = $1", [cfg.hash]);
      if (!cfgRes.rows[0]) {
        await client.query("UPDATE game_configs SET is_active = false WHERE game_id = $1 AND is_active = true", [gameId]);
        await client.query(
          `INSERT INTO game_configs (game_id, version, config_hash, config_json, analytic_rtp, is_active, max_win_x)
           VALUES ($1,$2,$3,$4::jsonb,$5,true,$6)`,
          [gameId, cfg.config.version, cfg.hash, JSON.stringify(cfg.raw), cfg.config.targetRtp, cfg.config.maxWinCap],
        );
      } else {
        await client.query("UPDATE game_configs SET is_active = true, game_id = $1 WHERE id = $2", [gameId, cfgRes.rows[0].id]);
      }
    });
  }
}
