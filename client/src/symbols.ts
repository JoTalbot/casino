/**
 * Символы барабанов, нарисованные кодом.
 *
 * Прототипу нужны узнаваемые различимые символы, а не арт. Рисование
 * через Graphics убирает из T-014 всю возню с ассетами: нет загрузки
 * атласов, нет ожидания сети, нет лицензионных вопросов с чужими
 * спрайтами. Настоящая графика заменит этот файл, не трогая логику, —
 * `ReelSymbol` для движка выглядит одинаково независимо от того, что
 * внутри.
 */

import { Container, Graphics, Text, TextStyle } from "pixi.js";
import { ReelSymbol } from "pixi-reels";

export interface SymbolTheme {
  /** Цвет плашки. */
  fill: number;
  /** Цвет рамки и подписи. */
  accent: number;
  /** Короткая подпись на плашке. */
  glyph: string;
}

/** Оформление каждого символа из config/game.json. */
export const SYMBOL_THEMES: Record<string, SymbolTheme> = {
  TEN: { fill: 0x1c2333, accent: 0x8fa3c8, glyph: "10" },
  J: { fill: 0x1c2333, accent: 0x8fa3c8, glyph: "J" },
  Q: { fill: 0x1c2333, accent: 0x9fb4d8, glyph: "Q" },
  K: { fill: 0x1f2740, accent: 0xb0c4e8, glyph: "K" },
  A: { fill: 0x1f2740, accent: 0xc6d6f5, glyph: "A" },
  SWORD: { fill: 0x27303f, accent: 0x7fd4e8, glyph: "МЕЧ" },
  CHALICE: { fill: 0x2b2a3d, accent: 0x9d8cf0, glyph: "КУБОК" },
  RING: { fill: 0x33304a, accent: 0xf0b45a, glyph: "КОЛЬЦО" },
  CROWN: { fill: 0x3a2f22, accent: 0xffd257, glyph: "КОРОНА" },
  WILD: { fill: 0x3d1f4d, accent: 0xff5fd2, glyph: "WILD" },
  CHEST: { fill: 0x33230f, accent: 0xffc978, glyph: "СУНДУК" },
};

const FALLBACK: SymbolTheme = { fill: 0x222222, accent: 0x888888, glyph: "?" };

/**
 * Символ, отрисованный примитивами.
 *
 * Движок агрессивно переиспользует экземпляры из пула: один и тот же
 * объект по очереди играет разные символы. Поэтому вся отрисовка
 * происходит в `onActivate`, а не в конструкторе, и `resize` обязан
 * перерисовывать — иначе символы «разъезжаются» при смене размера ячейки.
 */
export class ShapeSymbol extends ReelSymbol {
  /**
   * Вся графика лежит в отдельном контейнере, а не прямо во `view`.
   *
   * Начало координат ячейки — её ЛЕВЫЙ ВЕРХНИЙ угол: штатный
   * `SpriteSymbol` библиотеки имеет `anchor = {x:0, y:0}` и в `resize`
   * растягивает спрайт от (0,0) до (w,h). Рисовать от центра прямо во
   * `view` нельзя — символы уезжают на полклетки вверх-влево, наезжают
   * друг на друга и открывают буферный ряд.
   *
   * Внутри `art` удобнее рисовать от центра, поэтому `art` ставится в
   * середину ячейки, а фигуры внутри строятся вокруг нуля. Заодно
   * масштаб выигрышной анимации применяется к `art`, а не к `view`:
   * двигать `view` запрещено, реел читает его позицию, чтобы понять,
   * в каком слоте находится символ.
   */
  private readonly art = new Container();
  private readonly gfx = new Graphics();
  private readonly label: Text;
  private width_ = 128;
  private height_ = 128;
  private theme: SymbolTheme = FALLBACK;

  constructor() {
    super();
    this.label = new Text({
      text: "",
      style: new TextStyle({
        fontFamily: "Georgia, serif",
        fontSize: 22,
        fontWeight: "700",
        fill: 0xffffff,
        align: "center",
      }),
    });
    this.label.anchor.set(0.5);

    this.art.addChild(this.gfx);
    this.art.addChild(this.label);
    (this.view as Container).addChild(this.art);
  }

  protected onActivate(symbolId: string): void {
    this.theme = SYMBOL_THEMES[symbolId] ?? FALLBACK;
    this.redraw();
  }

  protected onDeactivate(): void {
    // Экземпляры переиспользуются пулом: масштаб от прошлой выигрышной
    // анимации обязан быть сброшен, иначе он протечёт на следующий символ.
    this.gsap.killTweensOf(this.art.scale);
    this.art.scale.set(1);
    this.gfx.clear();
  }

  /**
   * Одноразовая анимация выигрыша: пульс подсветки.
   * Промис обязан резолвиться, иначе spotlight зависнет на этой ячейке.
   */
  async playWin(): Promise<void> {
    const art = this.art;
    await new Promise<void>((resolve) => {
      this.gsap.fromTo(
        art.scale,
        { x: 1, y: 1 },
        {
          x: 1.14,
          y: 1.14,
          duration: 0.28,
          yoyo: true,
          repeat: 1,
          ease: "sine.inOut",
          onComplete: () => resolve(),
        },
      );
    });
  }

  stopAnimation(): void {
    this.gsap.killTweensOf(this.art.scale);
    this.art.scale.set(1);
  }

  resize(width: number, height: number): void {
    this.width_ = width;
    this.height_ = height;
    // Центр ячейки в системе координат, начинающейся в её левом верхнем углу.
    this.art.position.set(width / 2, height / 2);
    this.redraw();
  }

  private redraw(): void {
    const w = this.width_;
    const h = this.height_;
    const pad = Math.max(3, Math.round(Math.min(w, h) * 0.05));
    const radius = Math.round(Math.min(w, h) * 0.14);

    this.gfx.clear();
    this.gfx
      .roundRect(-w / 2 + pad, -h / 2 + pad, w - pad * 2, h - pad * 2, radius)
      .fill({ color: this.theme.fill })
      .stroke({ width: 2, color: this.theme.accent, alignment: 1 });

    // Диагональный блик — дешёвый способ отличить «дорогой» символ от фона.
    this.gfx
      .roundRect(-w / 2 + pad * 2, -h / 2 + pad * 2, w - pad * 4, (h - pad * 4) * 0.34, radius * 0.6)
      .fill({ color: this.theme.accent, alpha: 0.09 });

    this.label.text = this.theme.glyph;
    this.label.style.fill = this.theme.accent;
    this.label.style.fontSize = Math.max(12, Math.round(Math.min(w, h) * 0.19));
    this.label.position.set(0, 0);
  }
}
