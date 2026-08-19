import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("начальная миграция разворачивается повторяемо", { skip: !databaseUrl }, async () => {
  // CI создаёт чистую временную БД. Повторный запуск обязан быть no-op.
  await runMigrations(databaseUrl!);
  await runMigrations(databaseUrl!);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const migrations = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
    assert.deepEqual(migrations.rows, [{ filename: "0001_init.sql" }]);

    const currency = await pool.query<{ code: string; kind: string; exponent: number }>(
      "SELECT code, kind, exponent FROM currencies WHERE code = 'CHIP'",
    );
    assert.deepEqual(currency.rows, [{ code: "CHIP", kind: "virtual", exponent: 0 }]);

    const tables = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.ledger_entries') IS NOT NULL AS exists",
    );
    assert.equal(tables.rows[0]?.exists, true);
  } finally {
    await pool.end();
  }
});
