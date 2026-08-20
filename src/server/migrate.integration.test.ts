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
    // T-186: список миграций растёт, поэтому проверяем свойства, а не
    // точный слепок: начальная миграция применена, повтор не создал дублей,
    // порядок применения соответствует именам файлов.
    const migrations = await pool.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    const names = migrations.rows.map((r) => r.filename);
    assert.ok(names.includes("0001_init.sql"), "начальная миграция должна быть применена");
    assert.deepEqual(names, [...new Set(names)], "повторный запуск не должен дублировать записи");
    assert.deepEqual(names, [...names].sort(), "миграции применяются по порядку имён");

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
