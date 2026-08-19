/** Сервис provably-fair сидов: хранение в PostgreSQL, а не в памяти. */
import type { PoolClient } from "pg";
import { generateServerSeed, hashServerSeed } from "../engine/rng.js";
import type { Database } from "./db.js";

export class SeedServiceError extends Error {
  constructor(readonly code: "SEED_NOT_FOUND" | "INVALID_CLIENT_SEED", message: string) {
    super(message);
  }
}

interface SeedRow {
  id: string;
  server_seed: string;
  server_seed_hash: string;
  client_seed: string;
  next_nonce: string;
  status: "active" | "revealed";
  created_at: string;
  revealed_at: string | null;
}

function assertClientSeed(seed: string): void {
  if (!seed || seed.length < 1 || seed.length > 256 || seed.includes(":")) {
    throw new SeedServiceError("INVALID_CLIENT_SEED", "clientSeed: 1..256 символов, двоеточие запрещено");
  }
}

export async function getActiveSeed(database: Database, playerId: string): Promise<SeedRow | null> {
  const res = await database.query<SeedRow>(
    "SELECT id, server_seed, server_seed_hash, client_seed, next_nonce, status, created_at, revealed_at FROM seed_pairs WHERE player_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    [playerId],
  );
  return res.rows[0] ?? null;
}

export async function ensureActiveSeed(database: Database, playerId: string): Promise<SeedRow> {
  const existing = await getActiveSeed(database, playerId);
  if (existing) return existing;
  // Если активной нет — создаём новую
  return database.transaction(async (client) => {
    const serverSeed = generateServerSeed();
    const serverSeedHash = hashServerSeed(serverSeed);
    const clientSeed = "default";
    const res = await client.query<SeedRow>(
      `INSERT INTO seed_pairs (player_id, server_seed, server_seed_hash, client_seed, next_nonce, status)
       VALUES ($1, $2, $3, $4, 0, 'active') RETURNING id, server_seed, server_seed_hash, client_seed, next_nonce, status, created_at, revealed_at`,
      [playerId, serverSeed, serverSeedHash, clientSeed],
    );
    return res.rows[0]!;
  });
}

export async function setClientSeed(database: Database, playerId: string, newClientSeed: string): Promise<SeedRow> {
  assertClientSeed(newClientSeed);
  return database.transaction(async (client) => {
    const active = await client.query<SeedRow>(
      "SELECT id, server_seed, server_seed_hash, client_seed, next_nonce, status, created_at, revealed_at FROM seed_pairs WHERE player_id = $1 AND status = 'active' FOR UPDATE",
      [playerId],
    );
    if (!active.rows[0]) throw new SeedServiceError("SEED_NOT_FOUND", "Активная пара сидов не найдена");
    const updated = await client.query<SeedRow>(
      `UPDATE seed_pairs SET client_seed = $1, next_nonce = 0 WHERE id = $2
       RETURNING id, server_seed, server_seed_hash, client_seed, next_nonce, status, created_at, revealed_at`,
      [newClientSeed, active.rows[0].id],
    );
    await client.query(
      "INSERT INTO audit_log (actor_type, actor_id, event_type, subject_type, subject_id, payload) VALUES ('player', $1, 'seed.client_rotated', 'seed_pair', $2, $3)",
      [playerId, updated.rows[0]!.id, JSON.stringify({ clientSeed: newClientSeed })],
    );
    return updated.rows[0]!;
  });
}

export interface RotateResult {
  revealed: SeedRow;
  current: SeedRow;
}

export async function rotateSeedPair(database: Database, playerId: string): Promise<RotateResult> {
  return database.transaction(async (client) => {
    const active = await client.query<SeedRow>(
      "SELECT id, server_seed, server_seed_hash, client_seed, next_nonce, status, created_at, revealed_at FROM seed_pairs WHERE player_id = $1 AND status = 'active' FOR UPDATE",
      [playerId],
    );
    if (!active.rows[0]) throw new SeedServiceError("SEED_NOT_FOUND", "Активная пара сидов не найдена");
    const old = active.rows[0];

    await client.query("UPDATE seed_pairs SET status = 'revealed', revealed_at = now() WHERE id = $1", [old.id]);

    const serverSeed = generateServerSeed();
    const serverSeedHash = hashServerSeed(serverSeed);
    // Клиентский сид наследуется из старой пары
    const currentRes = await client.query<SeedRow>(
      `INSERT INTO seed_pairs (player_id, server_seed, server_seed_hash, client_seed, next_nonce, status)
       VALUES ($1, $2, $3, $4, 0, 'active') RETURNING id, server_seed, server_seed_hash, client_seed, next_nonce, status, created_at, revealed_at`,
      [playerId, serverSeed, serverSeedHash, old.client_seed],
    );

    await client.query(
      "INSERT INTO audit_log (actor_type, actor_id, event_type, subject_type, subject_id, payload) VALUES ('player', $1, 'seed.rotated', 'seed_pair', $2, $3)",
      [playerId, old.id, JSON.stringify({ revealedSeedId: old.id, newSeedId: currentRes.rows[0]!.id })],
    );

    // Обновляем revealed_at в старом объекте для ответа
    const revealedRes = await client.query<SeedRow>(
      "SELECT id, server_seed, server_seed_hash, client_seed, next_nonce, status, created_at, revealed_at FROM seed_pairs WHERE id = $1",
      [old.id],
    );

    return { revealed: revealedRes.rows[0]!, current: currentRes.rows[0]! };
  });
}

export async function listSeedHistory(
  database: Database,
  playerId: string,
  limit = 20,
): Promise<SeedRow[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const res = await database.query<SeedRow>(
    "SELECT id, server_seed, server_seed_hash, client_seed, next_nonce, status, created_at, revealed_at FROM seed_pairs WHERE player_id = $1 AND status = 'revealed' ORDER BY revealed_at DESC LIMIT $2",
    [playerId, safeLimit],
  );
  return res.rows;
}
