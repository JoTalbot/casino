/**
 * Художественные символы барабанов (T-190).
 *
 * Прошлая версия (`symbols.ts`) рисовала текстовые плашки — этого хватало,
 * чтобы отлаживать математику, но выглядело как заглушка. Здесь символы
 * нарисованы по-настоящему: корона, перстень, кубок, меч, самоцвет-скаттер,
 * звезда-вайлд и гравированные роялы.
 *
 * Почему по-прежнему векторно, а не спрайтами:
 *  - ноль сетевых запросов и ноль ожидания атласов — важно для превью
 *    в песочнице, где внешние ресурсы не грузятся;
 *  - нет чужих лицензий на арт;
 *  - символ идеально резкий на любом размере ячейки и на ретине.
 *
 * Композиция каждого символа одинакова: подложка с градиентом и фаской,
 * иконка, блик. За счёт общей подложки барабан читается как единое целое,
 * а «дорогие» символы отличаются теплом подложки и силой свечения.
 */

import { Assets, Container, FillGradient, Graphics, Sprite, Text, TextStyle, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";
import { ReelSymbol } from "pixi-reels";

/** Ранг символа: определяет теплоту подложки и силу свечения. */
export type SymbolRank = "low" | "mid" | "high" | "special";

export interface SymbolTheme {
  /** Основной цвет иконки. */
  accent: number;
  /** Затенённый цвет для объёма. */
  shade: number;
  /** Подпись — используется в таблице выплат и как запасной вариант. */
  glyph: string;
  rank: SymbolRank;
  /** Какую фигуру рисовать. */
  shape: "royal" | "sword" | "chalice" | "ring" | "crown" | "wild" | "scatter";
}

export const SYMBOL_THEMES: Record<string, SymbolTheme> = {
  TEN: { accent: 0xbfe0ff, shade: 0x2e6da8, glyph: "10", rank: "low", shape: "royal" },
  J: { accent: 0x9ff0d8, shade: 0x1f7f68, glyph: "J", rank: "low", shape: "royal" },
  Q: { accent: 0xffc0e0, shade: 0xa03a72, glyph: "Q", rank: "low", shape: "royal" },
  K: { accent: 0xffd9a0, shade: 0xb06a1c, glyph: "K", rank: "low", shape: "royal" },
  A: { accent: 0xff9f9f, shade: 0xa82a2a, glyph: "A", rank: "low", shape: "royal" },
  SWORD: { accent: 0x8fe3f5, shade: 0x2c7f96, glyph: "МЕЧ", rank: "mid", shape: "sword" },
  CHALICE: { accent: 0xb9a6ff, shade: 0x5b46a8, glyph: "КУБОК", rank: "mid", shape: "chalice" },
  RING: { accent: 0xffc978, shade: 0xa96c1c, glyph: "КОЛЬЦО", rank: "high", shape: "ring" },
  CROWN: { accent: 0xffd257, shade: 0xa8741a, glyph: "КОРОНА", rank: "high", shape: "crown" },
  WILD: { accent: 0xff77dd, shade: 0x8e1c74, glyph: "WILD", rank: "special", shape: "wild" },
  CHEST: { accent: 0xffc978, shade: 0x7a4a12, glyph: "СУНДУК", rank: "special", shape: "scatter" },
};

const FALLBACK: SymbolTheme = { accent: 0x8899aa, shade: 0x44515f, glyph: "?", rank: "low", shape: "royal" };

/**
 * 3D-рендеры символов (T-193).
 *
 * Файлы лежат в `public/symbols/` и отдаются с того же origin — внешних
 * запросов нет. Если файл не загрузился (офлайн, урезанная сборка,
 * символ без арта), рисуется векторная фигура: игра не должна ломаться
 * из-за картинки.
 */
const ICON_FILES: Record<string, string> = {
  CROWN: "crown",
  RING: "ring",
  CHALICE: "chalice",
  SWORD: "sword",
  WILD: "wild",
  CHEST: "chest",
  A: "A",
  K: "K",
  Q: "Q",
  J: "J",
};

/** Доля ячейки, которую занимает 3D-объект. */
const ICON_FIT: Record<string, number> = {
  CROWN: 0.78,
  RING: 0.74,
  CHALICE: 0.76,
  SWORD: 0.82,
  WILD: 0.8,
  CHEST: 0.82,
  A: 0.66,
  K: 0.66,
  Q: 0.66,
  J: 0.62,
};

const icons = new Map<string, Texture>();

/** Префикс, под которым отдаётся клиент: «/» или «/parts/casino/». */
const ASSET_BASE = import.meta.env?.BASE_URL ?? "/";

/** Грузит 3D-арты. Ошибки не фатальны: символ откатится на вектор. */
async function loadIcons(): Promise<void> {
  if (icons.size > 0) return;
  await Promise.all(
    Object.entries(ICON_FILES).map(async ([id, file]) => {
      try {
        // Путь обязан быть относительным префикса приложения: под
        // /parts/casino/ абсолютный «/symbols/...» уходил в корень чужого
        // домена, получал 302 от Cloudflare Access и молча откатывал
        // символы на векторную отрисовку — в Telegram не было 3D (T-210).
        const texture = await Assets.load<Texture>(`${ASSET_BASE}symbols/${file}.png`);
        icons.set(id, texture);
      } catch {
        // молча оставляем векторную фигуру
      }
    }),
  );
}

/** Подложки по рангу: чем дороже символ, тем теплее и светлее плашка. */
const PLATE: Record<SymbolRank, { top: string; bottom: string; rim: number }> = {
  low: { top: "#2c3b5c", bottom: "#141d32", rim: 0x53709f },
  mid: { top: "#33436b", bottom: "#17203a", rim: 0x6a8ec4 },
  high: { top: "#5a4318", bottom: "#251802", rim: 0xd6a234 },
  special: { top: "#4a2456", bottom: "#1e0c2b", rim: 0xb45bd0 },
};

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/**
 * Художник символа: рисует один символ в переданный контейнер.
 *
 * Вынесен из класса символа намеренно. Векторная отрисовка нужна ровно один
 * раз — при запекании текстуры; во время игры рисовать нельзя. Замер на
 * стенде: сцена с «живыми» Graphics давала 3.5 FPS в софтверном рендере,
 * та же картинка спрайтами — за 60 (T-191).
 */
class SymbolPainter {
  private readonly plate = new Graphics();
  private readonly icon = new Graphics();
  private readonly gloss = new Graphics();
  private readonly label: Text;
  private readonly sprites: Sprite[] = [];
  private readonly extras: Text[] = [];
  readonly root = new Container();

  constructor(private readonly size: number) {
    this.label = new Text({
      text: "",
      style: new TextStyle({
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: 34,
        fontWeight: "700",
        fill: 0xffffff,
        align: "center",
      }),
    });
    this.label.anchor.set(0.5);
    this.root.addChild(this.plate, this.icon, this.label, this.gloss);
  }

  paint(theme: SymbolTheme, symbolId: string): Container {
    const s = this.size;
    const pad = Math.max(3, Math.round(s * 0.045));
    const radius = Math.round(s * 0.16);
    const plate = PLATE[theme.rank];

    this.plate.clear();
    this.icon.clear();
    this.gloss.clear();
    this.label.text = "";
    for (const sprite of this.sprites.splice(0)) sprite.destroy();
    for (const extra of this.extras.splice(0)) extra.destroy();

    const x = -s / 2 + pad;
    const y = -s / 2 + pad;
    const pw = s - pad * 2;
    const ph = s - pad * 2;

    const body = new FillGradient({
      type: "linear",
      start: { x: 0.5, y: 0 },
      end: { x: 0.5, y: 1 },
      colorStops: [
        { offset: 0, color: plate.top },
        { offset: 0.55, color: plate.bottom },
        { offset: 1, color: plate.bottom },
      ],
      textureSpace: "local",
    });
    this.plate.roundRect(x, y, pw, ph, radius).fill(body);
    this.plate
      .roundRect(x, y, pw, ph, radius)
      .stroke({ width: Math.max(1.5, s * 0.018), color: plate.rim, alignment: 1 });
    this.plate
      .roundRect(x + pw * 0.06, y + ph * 0.05, pw * 0.88, ph * 0.42, radius * 0.8)
      .fill({ color: 0xffffff, alpha: 0.07 });
    const glowAlpha = theme.rank === "special" ? 0.2 : theme.rank === "high" ? 0.16 : 0.09;
    this.plate
      .roundRect(x + pw * 0.08, y + ph * 0.1, pw * 0.84, ph * 0.8, radius * 0.9)
      .stroke({ width: Math.max(2, s * 0.03), color: theme.accent, alpha: glowAlpha, alignment: 0 });

    // Контактная тень под объектом — он должен «стоять» на плашке, а не парить.
    this.icon.ellipse(0, s * 0.34, s * 0.27, s * 0.055).fill({ color: 0x000000, alpha: 0.45 });
    this.icon.ellipse(0, s * 0.34, s * 0.18, s * 0.035).fill({ color: 0x000000, alpha: 0.35 });

    const texture = icons.get(symbolId);
    if (texture) {
      // 3D-рендер: вписываем в ячейку и сажаем чуть выше центра, чтобы
      // осталось место под контактную тень.
      const fit = (ICON_FIT[symbolId] ?? 0.72) * s;
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      const scale = fit / Math.max(texture.width, texture.height);
      sprite.scale.set(scale);
      sprite.position.set(0, -s * 0.02);
      this.root.addChildAt(sprite, this.root.getChildIndex(this.icon) + 1);
      this.sprites.push(sprite);
    } else {
      this.drawIcon(s * 1.22, theme);
    }

    this.gloss
      .moveTo(x + pw * 0.06, y + ph * 0.62)
      .lineTo(x + pw * 0.42, y + ph * 0.05)
      .lineTo(x + pw * 0.66, y + ph * 0.05)
      .lineTo(x + pw * 0.2, y + ph * 0.72)
      .closePath()
      .fill({ color: 0xffffff, alpha: 0.045 });

    return this.root;
  }

  /** Диспетчер фигур: каждая рисуется вокруг нуля в квадрате s×s. */
  private drawIcon(s: number, t: SymbolTheme): void {
    const g = this.icon;
    const light = hex(t.accent);
    const dark = hex(t.shade);
    const metal = new FillGradient({
      type: "linear",
      start: { x: 0.5, y: 0 },
      end: { x: 0.5, y: 1 },
      colorStops: [
        { offset: 0, color: "#ffffff" },
        { offset: 0.22, color: light },
        { offset: 0.62, color: light },
        { offset: 1, color: dark },
      ],
      textureSpace: "local",
    });

    switch (t.shape) {
      case "crown":
        this.drawCrown(g, s, metal, t);
        break;
      case "ring":
        this.drawRing(g, s, metal, t);
        break;
      case "chalice":
        this.drawChalice(g, s, metal, t);
        break;
      case "sword":
        this.drawSword(g, s, metal, t);
        break;
      case "wild":
        this.drawWild(g, s, t);
        break;
      case "scatter":
        this.drawScatter(g, s, t);
        break;
      default:
        this.drawRoyal(s, t, metal);
    }
  }
  /**
   * Роял без 3D-рендера: экструдированная буква (T-193).
   *
   * Объём собирается стопкой копий текста со смещением — «выдавленный»
   * торец, поверх лицевая грань с металлическим градиентом и бликом.
   * Нужен, пока часть роялов ждёт своего рендера, и как запасной вариант,
   * если картинки не загрузились.
   */
  private drawRoyal(s: number, t: SymbolTheme, metal: FillGradient): void {
    const g = this.icon;
    const r = s * 0.3;

    // Подложка-медальон
    g.circle(0, -s * 0.02, r).fill({ color: t.shade, alpha: 0.22 });
    g.circle(0, -s * 0.02, r).stroke({ width: s * 0.014, color: t.accent, alpha: 0.45 });
    for (let i = 0; i < 4; i += 1) {
      const a = (Math.PI / 2) * i + Math.PI / 4;
      g.circle(Math.cos(a) * r * 1.02, -s * 0.02 + Math.sin(a) * r * 1.02, s * 0.022)
        .fill({ color: t.accent, alpha: 0.6 });
    }

    const size = Math.max(14, Math.round(s * (t.glyph.length > 1 ? 0.34 : 0.46)));
    const depth = Math.max(2, Math.round(s * 0.035));

    // Торец: копии со смещением вниз-вправо, от дальней к ближней
    for (let i = depth; i >= 1; i -= 1) {
      const side = new Text({
        text: t.glyph,
        style: new TextStyle({
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: size,
          fontWeight: "700",
          fill: i > depth * 0.5 ? 0x000000 : t.shade,
        }),
      });
      side.anchor.set(0.5);
      side.position.set(i * 0.85, -s * 0.02 + i * 0.85);
      this.root.addChild(side);
      this.extras.push(side);
    }

    // Лицевая грань
    const face = new Text({
      text: t.glyph,
      style: new TextStyle({
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: size,
        fontWeight: "700",
        fill: metal,
        stroke: { width: Math.max(1.5, s * 0.016), color: t.shade },
      }),
    });
    face.anchor.set(0.5);
    face.position.set(0, -s * 0.02);
    this.root.addChild(face);
    this.extras.push(face);

    // Блик по верхней кромке
    const shine = new Text({
      text: t.glyph,
      style: new TextStyle({
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: size,
        fontWeight: "700",
        fill: 0xffffff,
      }),
    });
    shine.anchor.set(0.5);
    shine.position.set(-size * 0.012, -s * 0.02 - size * 0.03);
    shine.alpha = 0.28;
    this.root.addChild(shine);
    this.extras.push(shine);
  }

  /** Корона: три зубца с жемчужинами, обод с самоцветами. */
  private drawCrown(g: Graphics, s: number, metal: FillGradient, t: SymbolTheme): void {
    const w = s * 0.62;
    const h = s * 0.46;
    const top = -h * 0.55;
    const base = h * 0.42;

    g.moveTo(-w / 2, base)
      .lineTo(-w / 2, -h * 0.05)
      .lineTo(-w * 0.3, top + h * 0.26)
      .lineTo(-w * 0.16, -h * 0.1)
      .lineTo(0, top)
      .lineTo(w * 0.16, -h * 0.1)
      .lineTo(w * 0.3, top + h * 0.26)
      .lineTo(w / 2, -h * 0.05)
      .lineTo(w / 2, base)
      .closePath()
      .fill(metal)
      .stroke({ width: s * 0.016, color: t.shade, alignment: 0.5 });

    // Обод: тёплый металл со светлой кромкой сверху
    g.roundRect(-w / 2, base - h * 0.16, w, h * 0.2, h * 0.06)
      .fill(metal)
      .stroke({ width: s * 0.012, color: t.shade, alpha: 0.95 });
    g.roundRect(-w / 2 + s * 0.01, base - h * 0.15, w - s * 0.02, h * 0.06, h * 0.03)
      .fill({ color: 0xffffff, alpha: 0.35 });

    // Жемчужины на зубцах
    for (const px of [-w * 0.3, 0, w * 0.3]) {
      const py = px === 0 ? top - s * 0.03 : top + h * 0.22;
      g.circle(px, py, s * 0.035).fill({ color: 0xfff3c4 });
      g.circle(px - s * 0.01, py - s * 0.012, s * 0.013).fill({ color: 0xffffff, alpha: 0.9 });
    }
    // Самоцветы на ободе
    for (const px of [-w * 0.24, 0, w * 0.24]) {
      g.moveTo(px, base - h * 0.13)
        .lineTo(px + s * 0.028, base - h * 0.06)
        .lineTo(px, base + s * 0.01)
        .lineTo(px - s * 0.028, base - h * 0.06)
        .closePath()
        .fill({ color: px === 0 ? 0xff5f7a : 0x62d2ff });
    }
  }

  /** Перстень: золотой обод с крупным гранёным камнем. */
  private drawRing(g: Graphics, s: number, metal: FillGradient, t: SymbolTheme): void {
    const r = s * 0.22;
    const cy = s * 0.1;

    // Внутренность кольца — тёмное стекло с бликом, а не дыра в плашке
    g.circle(0, cy, r * 0.78).fill({ color: 0x120c04, alpha: 0.55 });
    g.ellipse(-r * 0.25, cy - r * 0.3, r * 0.3, r * 0.16).fill({ color: 0xffffff, alpha: 0.1 });

    // Обод — два круга разной толщины: тень и металл
    g.circle(0, cy, r).stroke({ width: s * 0.075, color: t.shade });
    g.circle(0, cy, r).stroke({ width: s * 0.05, color: t.accent });
    g.circle(0, cy - r * 0.15, r * 0.98).stroke({ width: s * 0.016, color: 0xffffff, alpha: 0.45 });

    // Камень: восьмигранник с бликом
    const gy = cy - r - s * 0.09;
    const gr = s * 0.115;
    const facets: Array<[number, number]> = [];
    for (let i = 0; i < 8; i += 1) {
      const a = (Math.PI / 4) * i - Math.PI / 8;
      facets.push([Math.cos(a) * gr, gy + Math.sin(a) * gr]);
    }
    g.poly(facets.flat()).fill({ color: 0x7ae4ff }).stroke({ width: s * 0.012, color: 0xffffff, alpha: 0.85 });
    g.poly([facets[6][0], facets[6][1], facets[7][0], facets[7][1], 0, gy])
      .fill({ color: 0xffffff, alpha: 0.55 });
    g.poly([facets[2][0], facets[2][1], facets[3][0], facets[3][1], 0, gy])
      .fill({ color: 0x1d7fa8, alpha: 0.5 });

    // Крепление камня
    g.moveTo(-gr * 0.7, gy + gr * 0.75)
      .lineTo(gr * 0.7, gy + gr * 0.75)
      .lineTo(gr * 0.35, cy - r * 0.7)
      .lineTo(-gr * 0.35, cy - r * 0.7)
      .closePath()
      .fill(metal);
  }

  /** Кубок: чаша, ножка, основание, светящееся содержимое. */
  private drawChalice(g: Graphics, s: number, metal: FillGradient, t: SymbolTheme): void {
    const w = s * 0.42;
    const top = -s * 0.24;

    // Чаша
    g.moveTo(-w / 2, top)
      .bezierCurveTo(-w / 2, top + s * 0.24, -w * 0.22, top + s * 0.3, 0, top + s * 0.31)
      .bezierCurveTo(w * 0.22, top + s * 0.3, w / 2, top + s * 0.24, w / 2, top)
      .closePath()
      .fill(metal)
      .stroke({ width: s * 0.014, color: t.shade });

    // Содержимое
    g.ellipse(0, top + s * 0.012, w * 0.42, s * 0.045).fill({ color: 0xffe9a8, alpha: 0.95 });
    g.ellipse(-w * 0.1, top + s * 0.005, w * 0.14, s * 0.018).fill({ color: 0xffffff, alpha: 0.8 });

    // Ножка и основание
    g.roundRect(-s * 0.035, top + s * 0.3, s * 0.07, s * 0.16, s * 0.02).fill(metal);
    g.ellipse(0, top + s * 0.47, w * 0.42, s * 0.05).fill(metal).stroke({ width: s * 0.012, color: t.shade });
    g.circle(0, top + s * 0.36, s * 0.032).fill({ color: t.accent, alpha: 0.9 });

    // Ручки
    g.ellipse(-w * 0.56, top + s * 0.1, s * 0.055, s * 0.085).stroke({ width: s * 0.022, color: t.accent, alpha: 0.85 });
    g.ellipse(w * 0.56, top + s * 0.1, s * 0.055, s * 0.085).stroke({ width: s * 0.022, color: t.accent, alpha: 0.85 });
  }

  /** Меч: клинок с долом, гарда, рукоять, навершие. */
  private drawSword(g: Graphics, s: number, metal: FillGradient, t: SymbolTheme): void {
    const bw = s * 0.11;
    const tip = -s * 0.34;
    const guardY = s * 0.13;

    // Клинок
    g.moveTo(0, tip)
      .lineTo(bw, tip + s * 0.1)
      .lineTo(bw, guardY)
      .lineTo(-bw, guardY)
      .lineTo(-bw, tip + s * 0.1)
      .closePath()
      .fill(metal)
      .stroke({ width: s * 0.012, color: t.shade });
    // Дол — светлая осевая линия
    g.moveTo(0, tip + s * 0.06).lineTo(0, guardY - s * 0.02).stroke({ width: s * 0.018, color: 0xffffff, alpha: 0.35 });

    // Гарда
    g.roundRect(-s * 0.26, guardY, s * 0.52, s * 0.05, s * 0.02)
      .fill({ color: t.shade })
      .stroke({ width: s * 0.01, color: t.accent, alpha: 0.8 });
    g.circle(-s * 0.26, guardY + s * 0.025, s * 0.028).fill({ color: t.accent });
    g.circle(s * 0.26, guardY + s * 0.025, s * 0.028).fill({ color: t.accent });

    // Рукоять и навершие
    g.roundRect(-s * 0.045, guardY + s * 0.05, s * 0.09, s * 0.15, s * 0.02).fill({ color: 0x3a2a1c });
    for (let i = 0; i < 3; i += 1) {
      g.moveTo(-s * 0.045, guardY + s * (0.08 + i * 0.04))
        .lineTo(s * 0.045, guardY + s * (0.065 + i * 0.04))
        .stroke({ width: s * 0.01, color: t.accent, alpha: 0.6 });
    }
    g.circle(0, guardY + s * 0.22, s * 0.045).fill(metal).stroke({ width: s * 0.01, color: t.shade });
  }

  /** Вайлд: звезда-вспышка с лентой. */
  private drawWild(g: Graphics, s: number, t: SymbolTheme): void {
    const outer = s * 0.32;
    const inner = outer * 0.44;
    const pts: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const a = (Math.PI / 10) * i - Math.PI / 2;
      const r = i % 2 === 0 ? outer : inner;
      pts.push(Math.cos(a) * r, Math.sin(a) * r * 0.98 - s * 0.03);
    }
    g.poly(pts).fill({ color: t.shade, alpha: 0.55 });

    const star: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const r = i % 2 === 0 ? outer * 0.86 : inner * 0.9;
      star.push(Math.cos(a) * r, Math.sin(a) * r - s * 0.03);
    }
    g.poly(star)
      .fill({ color: t.accent })
      .stroke({ width: s * 0.014, color: 0xffffff, alpha: 0.75 });
    g.circle(0, -s * 0.03, inner * 0.5).fill({ color: 0xffffff, alpha: 0.35 });

    // Лента с надписью
    g.roundRect(-s * 0.34, s * 0.16, s * 0.68, s * 0.17, s * 0.045)
      .fill({ color: 0x2a0f2f })
      .stroke({ width: s * 0.012, color: t.accent, alpha: 0.9 });

    this.label.text = "WILD";
    this.label.style.fontSize = Math.max(9, Math.round(s * 0.115));
    this.label.style.fill = 0xffffff;
    this.label.style.stroke = { width: 0, color: 0x000000 };
    this.label.style.dropShadow = { color: t.accent, alpha: 0.9, blur: 4, distance: 0, angle: 0 };
    this.label.position.set(0, s * 0.245);
  }

  /** Скаттер: изумруд-октагон с гранями и надписью. */
  private drawScatter(g: Graphics, s: number, t: SymbolTheme): void {
    const r = s * 0.27;
    const cy = -s * 0.04;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 8; i += 1) {
      const a = (Math.PI / 4) * i + Math.PI / 8;
      pts.push([Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    g.poly(pts.flat()).fill({ color: t.shade }).stroke({ width: s * 0.016, color: t.accent });

    // Грани: соединяем центр с вершинами, чередуя светлые и тёмные сектора
    for (let i = 0; i < 8; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % 8];
      g.poly([0, cy, a[0], a[1], b[0], b[1]]).fill({
        color: i % 2 === 0 ? t.accent : 0xffffff,
        alpha: i % 2 === 0 ? 0.55 : 0.14,
      });
    }
    // Стол камня
    const table = pts.map(([px, py]) => [px * 0.45, cy + (py - cy) * 0.45]).flat();
    g.poly(table).fill({ color: 0xd8fff0, alpha: 0.9 }).stroke({ width: s * 0.01, color: 0xffffff, alpha: 0.8 });
    // Искра
    g.circle(-r * 0.28, cy - r * 0.32, s * 0.022).fill({ color: 0xffffff, alpha: 0.95 });

    this.label.text = "СУНДУК";
    this.label.style.fontSize = Math.max(8, Math.round(s * 0.1));
    this.label.style.fill = t.accent;
    this.label.style.stroke = { width: Math.max(1, s * 0.01), color: 0x06231a };
    this.label.style.dropShadow = { color: 0x000000, alpha: 0.6, blur: 2, distance: 1, angle: Math.PI / 2 };
    this.label.position.set(0, s * 0.33);
  }
}

// --- Запекание текстур -------------------------------------------------------

let textures: Map<string, Texture> | null = null;
let haloTexture: Texture | null = null;
let bakedSize = 0;

/**
 * Один раз рисует все символы и превращает их в текстуры.
 *
 * Вызывать до сборки барабанов. Повторный вызов с тем же размером — no-op,
 * со другим размером — перезапекание (например, при смене раскладки).
 */
export async function initSymbolTextures(renderer: Renderer, cellSize: number): Promise<void> {
  if (textures && bakedSize === cellSize) return;
  destroySymbolTextures();
  await loadIcons();

  const size = Math.round(cellSize);
  const painter = new SymbolPainter(size);
  const baked = new Map<string, Texture>();
  // resolution 2 — символы остаются резкими на ретине и при масштабировании
  // канваса по ширине контейнера.
  const resolution = 2;

  for (const [id, theme] of Object.entries(SYMBOL_THEMES)) {
    const art = painter.paint(theme, id);
    const texture = renderer.generateTexture({ target: art, resolution });
    baked.set(id, texture);
  }
  painter.root.destroy({ children: true });

  // Ореол выигрыша — общая текстура, тонируется под символ.
  const halo = new Graphics();
  const pad = size * 0.12;
  halo
    .roundRect(pad * 0.2, pad * 0.2, size - pad * 0.4, size - pad * 0.4, size * 0.2)
    .fill({ color: 0xffffff, alpha: 0.35 })
    .roundRect(pad * 0.6, pad * 0.6, size - pad * 1.2, size - pad * 1.2, size * 0.18)
    .fill({ color: 0xffffff, alpha: 0.5 });
  haloTexture = renderer.generateTexture({ target: halo, resolution: 1 });
  halo.destroy();

  textures = baked;
  bakedSize = size;
}

/** Освобождает запечённые текстуры (смена игры, размонтирование клиента). */
export function destroySymbolTextures(): void {
  textures?.forEach((t) => t.destroy(true));
  textures = null;
  haloTexture?.destroy(true);
  haloTexture = null;
  bakedSize = 0;
}

/**
 * Символ барабана — спрайт с запечённой текстурой.
 *
 * Ни одной операции рисования во время игры: пул символов только меняет
 * текстуру и размер спрайта. Анимации трогают только transform и alpha.
 */
export class ArtSymbol extends ReelSymbol {
  /**
   * Начало координат ячейки — её ЛЕВЫЙ ВЕРХНИЙ угол, так устроен `resize`
   * в библиотеке. Рисовать от центра прямо во `view` нельзя: символы уедут
   * на полклетки и откроют буферный ряд. Поэтому вся графика лежит в `art`,
   * который ставится в середину ячейки. Масштаб выигрышной анимации
   * применяется к `art`: двигать `view` запрещено, реел читает его позицию.
   */
  private readonly art = new Container();
  private readonly halo = new Sprite();
  private readonly sprite = new Sprite();
  private width_ = 128;
  private height_ = 128;

  constructor() {
    super();
    this.halo.anchor.set(0.5);
    this.sprite.anchor.set(0.5);
    this.halo.alpha = 0;
    // Ореол добавляется в сцену только на время выигрышной анимации.
    // Скрывать его через visible нельзя: Pixi v8 не возвращает в отрисовку
    // объект, спрятанный до первого кадра (см. комментарий в cabinet.ts).
    this.art.addChild(this.sprite);
    (this.view as Container).addChild(this.art);
  }

  protected onActivate(symbolId: string): void {
    const theme = SYMBOL_THEMES[symbolId] ?? FALLBACK;
    this.sprite.texture = textures?.get(symbolId) ?? Texture.WHITE;
    if (haloTexture) this.halo.texture = haloTexture;
    this.halo.tint = theme.accent;
    this.layout();
  }

  protected onDeactivate(): void {
    // Экземпляр переиспользуется пулом: следы прошлой анимации обязаны уйти.
    this.gsap.killTweensOf(this.art.scale);
    this.gsap.killTweensOf(this.art);
    this.gsap.killTweensOf(this.halo);
    this.art.scale.set(1);
    this.art.rotation = 0;
    this.halo.alpha = 0;
    this.halo.removeFromParent();
  }

  /**
   * Анимация выигрыша: подскок с раскачкой и вспышка ореола.
   * Промис обязан резолвиться, иначе spotlight зависнет на этой ячейке.
   */
  async playWin(): Promise<void> {
    const { art, halo } = this;
    this.art.addChildAt(halo, 0);
    this.gsap.to(halo, {
      alpha: 0.9,
      duration: 0.18,
      yoyo: true,
      repeat: 3,
      ease: "sine.inOut",
      onComplete: () => {
        halo.removeFromParent();
      },
    });
    this.gsap.fromTo(art, { rotation: -0.05 }, { rotation: 0.05, duration: 0.14, yoyo: true, repeat: 3, ease: "sine.inOut" });
    await new Promise<void>((resolve) => {
      this.gsap.fromTo(
        art.scale,
        { x: 1, y: 1 },
        { x: 1.18, y: 1.18, duration: 0.26, yoyo: true, repeat: 1, ease: "back.out(2.4)", onComplete: () => resolve() },
      );
    });
    this.art.rotation = 0;
  }

  stopAnimation(): void {
    this.gsap.killTweensOf(this.art.scale);
    this.gsap.killTweensOf(this.art);
    this.gsap.killTweensOf(this.halo);
    this.art.scale.set(1);
    this.art.rotation = 0;
    this.halo.alpha = 0;
    this.halo.removeFromParent();
  }

  resize(width: number, height: number): void {
    this.width_ = width;
    this.height_ = height;
    this.layout();
  }

  private layout(): void {
    const w = this.width_;
    const h = this.height_;
    this.art.position.set(w / 2, h / 2);
    this.sprite.width = w;
    this.sprite.height = h;
    this.halo.width = w * 1.18;
    this.halo.height = h * 1.18;
  }
}
