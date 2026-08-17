/// <reference types="vitest/config" />
import { defineConfig } from "vite";

/**
 * Конфигурация dev-сервера клиента.
 *
 * Два момента, без которых прототип не работает за пределами
 * машины разработчика:
 *
 * 1. `proxy` — браузер обращается к API по относительному пути
 *    `/api/v1/...` и попадает на сервер раундов через Vite. Если бы
 *    клиент ходил напрямую на `http://localhost:3001`, страница
 *    работала бы только у того, кто запустил сервер: у всех остальных
 *    `localhost` — это их собственная машина.
 *
 * 2. `allowedHosts` — Vite по умолчанию отклоняет запросы с чужим
 *    заголовком Host, и превью в песочнице получает «Blocked request».
 */
export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
  test: {
    // Заглушка navigator/self: PixiJS трогает их прямо при импорте,
    // см. комментарий в vitest.setup.ts.
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});
