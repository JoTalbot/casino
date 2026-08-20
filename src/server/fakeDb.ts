/**
 * Фейковая in-memory реализация интерфейса Database (T-175).
 *
 * Зачем: интеграционные тесты соц-слоя (чат, ачивки, рефералы, турниры)
 * до этой смены существовали только в виде PG-тестов со `skip`, то есть
 * в CI не выполнялись вообще. Этот стаб позволяет прогонять маршруты
 * Fastify через `app.inject()` без PostgreSQL и ловить регрессии
 * маршрутизации, авторизации и валидации.
 *
 * Важно: это НЕ эмулятор SQL. Он распознаёт ровно те запросы, которые
 * шлёт код приложения, по характерным подстрокам. Денежная логика
 * (ledger, транзакции, RTP) по-прежнему проверяется настоящим PostgreSQL
 * в *.integration.test.ts — стаб её не подменяет.
 */
import type { PoolClient } from "pg";
import type { Database } from "./db.js";

export interface FakeRow {
  [key: string]: unknown;
}

/** Обработчик: получает значения параметров, возвращает строки ответа. */
export type FakeHandler = (values: readonly unknown[]) => FakeRow[];

export interface FakeDbOptions {
  /** Пары «подстрока SQL → строки ответа». Проверяются в порядке добавления. */
  routes?: Array<[string, FakeRow[] | FakeHandler]>;
  /** Что вернуть, если ни один маршрут не совпал. По умолчанию — пустой набор. */
  fallback?: FakeRow[] | ((sql: string, values: readonly unknown[]) => FakeRow[]);
}

export interface FakeDatabase extends Database {
  /** Все выполненные запросы — для проверок в тестах. */
  readonly calls: Array<{ sql: string; values: readonly unknown[] }>;
  /** Добавить маршрут уже после создания. */
  on(fragment: string, rows: FakeRow[] | FakeHandler): void;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

export function createFakeDatabase(options: FakeDbOptions = {}): FakeDatabase {
  const routes: Array<[string, FakeRow[] | FakeHandler]> = [...(options.routes ?? [])];
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];

  function resolve(sql: string, values: readonly unknown[]): FakeRow[] {
    const flat = normalize(sql);
    for (const [fragment, rows] of routes) {
      if (flat.includes(normalize(fragment))) {
        return typeof rows === "function" ? rows(values) : rows;
      }
    }
    if (typeof options.fallback === "function") return options.fallback(sql, values);
    return options.fallback ?? [];
  }

  const database: FakeDatabase = {
    calls,
    on(fragment, rows) {
      routes.push([fragment, rows]);
    },
    async query(text: string, values: readonly unknown[] = []) {
      calls.push({ sql: text, values });
      const rows = resolve(text, values);
      return { rows: rows as never[], rowCount: rows.length };
    },
    async transaction(work) {
      // Транзакции здесь без изоляции: стаб проверяет маршруты, а не ACID.
      const client = {
        query: async (text: string, values?: unknown[]) => {
          calls.push({ sql: text, values: values ?? [] });
          const rows = resolve(text, values ?? []);
          return { rows, rowCount: rows.length };
        },
      } as unknown as PoolClient;
      return work(client);
    },
    async close() {
      /* нечего закрывать */
    },
  };

  return database;
}
