/** Применяет SQL-миграции строго по порядку и запоминает их в PostgreSQL. */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

export async function runMigrations(databaseUrl: string, migrationsDir = "db/migrations"): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, application_name: "casino-migrate" });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(migrationsDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    for (const filename of files) {
      const sql = await readFile(join(migrationsDir, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE filename = $1", [filename]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Миграция ${filename} была изменена после применения.`);
        continue;
      }
      // Начальная схема уже содержит BEGIN/COMMIT; будущие миграции обязаны быть самодостаточными.
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [filename, checksum]);
      console.log(`Применена миграция ${filename}`);
    }
  } finally { client.release(); await pool.end(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Нужна переменная окружения DATABASE_URL.");
  await runMigrations(databaseUrl);
}
