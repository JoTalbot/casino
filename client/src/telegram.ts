/**
 * Интеграция с Telegram Mini App (T-197).
 *
 * Всё здесь опционально: клиент обязан работать и в обычном браузере, где
 * `window.Telegram` не существует. Поэтому наружу торчит один объект с
 * безопасными заглушками, а не проверки `if (window.Telegram)` по всему коду.
 */

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { user?: { id: number; first_name?: string; username?: string } };
  colorScheme?: string;
  themeParams?: Record<string, string>;
  ready(): void;
  expand(): void;
  close(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  disableVerticalSwipes?(): void;
  enableClosingConfirmation?(): void;
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
  MainButton?: {
    text: string;
    show(): void;
    hide(): void;
    enable(): void;
    disable(): void;
    setText(text: string): void;
    onClick(cb: () => void): void;
    setParams(params: { text?: string; color?: string; text_color?: string; is_active?: boolean }): void;
  };
  version?: string;
  platform?: string;
}

function api(): TelegramWebApp | undefined {
  return (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
}

/** Открыт ли клиент внутри Telegram. */
export function inTelegram(): boolean {
  const app = api();
  return Boolean(app && typeof app.initData === "string" && app.initData.length > 0);
}

/** Подписанная строка входа. Пустая строка — значит мы не в Telegram. */
export function initData(): string {
  return api()?.initData ?? "";
}

export function platform(): string {
  return api()?.platform ?? "web";
}

/**
 * Разворачивает окно, красит хром под нашу палитру и запрещает
 * «свайп вниз» — иначе быстрый скролл барабанов закрывает приложение.
 */
export function setupViewport(): void {
  const app = api();
  if (!app) return;
  app.ready();
  app.expand();
  app.setHeaderColor?.("#070910");
  app.setBackgroundColor?.("#070910");
  app.disableVerticalSwipes?.();
  document.body.classList.add("in-telegram");
}

/** Тактильный отклик. В браузере — тишина, без исключений. */
export const haptic = {
  tap(): void {
    api()?.HapticFeedback?.impactOccurred("light");
  },
  spin(): void {
    api()?.HapticFeedback?.impactOccurred("medium");
  },
  win(): void {
    api()?.HapticFeedback?.notificationOccurred("success");
  },
  bigWin(): void {
    api()?.HapticFeedback?.impactOccurred("heavy");
    setTimeout(() => api()?.HapticFeedback?.notificationOccurred("success"), 160);
  },
  select(): void {
    api()?.HapticFeedback?.selectionChanged();
  },
};

/**
 * Главная кнопка Telegram как кнопка спина: на телефоне она крупная,
 * всегда внизу и не уезжает при скролле.
 */
export function setupMainButton(onSpin: () => void): { setBusy(busy: boolean): void } | undefined {
  const button = api()?.MainButton;
  if (!button) return undefined;
  button.setParams({ text: "КРУТИТЬ", color: "#ffd257", text_color: "#2a1f03", is_active: true });
  button.onClick(onSpin);
  button.show();
  return {
    setBusy(busy: boolean): void {
      button.setText(busy ? "КРУТИТСЯ…" : "КРУТИТЬ");
      if (busy) button.disable();
      else button.enable();
    },
  };
}
