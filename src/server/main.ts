/** Точка входа production-сервера. Не запускается без явных секретов окружения. */
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";

const databaseUrl = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;
if (!databaseUrl || !jwtSecret) {
  throw new Error("Нужны переменные окружения DATABASE_URL и JWT_SECRET.");
}

const app = await buildApp({ jwtSecret, database: createDatabase(databaseUrl) });
const port = Number(process.env.PORT ?? 3000);
await app.listen({ host: "0.0.0.0", port });
