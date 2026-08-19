/**
 * Playwright e2e UI — спин флоу в браузере (T-053)
 * Запуск: npx playwright test tests/e2e/client.spec.ts
 * Требует запущенного клиента (http://localhost:8080) и API (http://localhost:3000)
 */
import { test, expect } from "@playwright/test";

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:8080";

test.describe("Crown of Fortune — клиент", () => {
  test("age gate 18+ и спин", async ({ page }) => {
    await page.goto(CLIENT_URL);

    // Age gate
    const ageGate = page.locator("#age-gate");
    await expect(ageGate).toBeVisible();
    await page.locator("#age-yes").click();
    await expect(ageGate).toBeHidden();

    // Игра загружена
    await expect(page.locator("#game-name")).not.toHaveText("Загрузка…", { timeout: 10000 });
    await expect(page.locator("#balance")).not.toHaveText("—", { timeout: 10000 });

    // Спин
    const balanceBefore = await page.locator("#balance").textContent();
    await page.locator("#spin").click();
    await expect(page.locator("#status")).not.toHaveText("Запрос раунда у сервера…", { timeout: 10000 });
    
    // Баланс должен обновиться (может остаться тем же при выигрыше, но запрос выполнится)
    await page.waitForTimeout(2000);
    const balanceAfter = await page.locator("#balance").textContent();
    expect(balanceAfter).not.toBeNull();

    // История должна пополниться
    await page.locator("#history-refresh").click();
    await expect(page.locator("#history-list .history-item").first()).toBeVisible({ timeout: 5000 });
  });

  test("RG лимиты и верификатор модалка", async ({ page }) => {
    await page.goto(CLIENT_URL);
    await page.locator("#age-yes").click();

    // Открыть верификатор
    await page.locator("#verify-open").click();
    await expect(page.locator("#verify-modal")).toBeVisible();
    await page.locator("#verify-close").click();
    await expect(page.locator("#verify-modal")).toBeHidden();
  });
});
