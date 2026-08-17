/**
 * Минимальное окружение браузера для headless-тестов.
 *
 * PixiJS v8 при импорте модуля определяет Safari по `navigator.userAgent`
 * (глубоко в загрузчике видео-текстур), поэтому даже полностью headless
 * харнесс `pixi-reels/testing` не импортируется в голом Node.
 *
 * Полноценный jsdom для этого не нужен и стоил бы секунд на прогон:
 * тесты не рендерят и не трогают DOM, им хватает пары полей. Если Pixi
 * когда-нибудь потребует большего, тест упадёт с внятным
 * `ReferenceError`, и заглушку будет видно где расширять.
 */

const g = globalThis as Record<string, unknown>;

if (typeof g.navigator === "undefined") {
  g.navigator = { userAgent: "node", platform: "node", maxTouchPoints: 0 };
}

if (typeof g.self === "undefined") {
  g.self = g;
}
