/**
 * Корпус игрового автомата (T-190).
 *
 * Раньше «корпусом» был один серый прямоугольник вокруг барабанов. Здесь
 * собран настоящий кабинет: подсвеченный задник, стеклянное окно барабанов,
 * золотая рама с орнаментом и заклёпками, вывеска с названием игры и
 * праздничный слой для выигрышей.
 *
 * Всё рисуется примитивами PixiJS — ни одного внешнего файла. Это принципиально:
 * клиент должен подниматься в офлайне и в песочнице предпросмотра, где внешние
 * ресурсы не загружаются.
 *
 * Слои складываются строго в этом порядке:
 *   задник → окно барабанов → [барабаны] → рама → вывеска → эффекты
 * Барабаны добавляет вызывающий код между `background` и `frame`.
 */

import { Assets, Container, FillGradient, Graphics, Rectangle, Sprite, Text, TextStyle, Texture } from "pixi.js";
import type { Renderer, Ticker } from "pixi.js";

/**
 * Запекает статичный слой в один спрайт.
 *
 * Задник, окно и рама не меняются между кадрами, но как Graphics они каждый
 * кадр отправляют в рендер десятки перекрывающихся полупрозрачных полигонов.
 * На стенде это стоило 44 FPS из 60 (T-191). Одна текстура — один quad.
 */
function bake(renderer: Renderer, source: Container): Container {
  const texture = renderer.generateTexture({ target: source, resolution: 1 });
  const sprite = new Sprite(texture);
  // generateTexture обрезает по границам содержимого — возвращаем на место.
  const bounds = source.getLocalBounds();
  sprite.position.set(bounds.x, bounds.y);
  source.destroy({ children: true });
  const holder = new Container();
  holder.addChild(sprite);
  return holder;
}

export interface CabinetLayout {
  /** Полный размер холста. */
  width: number;
  height: number;
  /** Прямоугольник окна барабанов. */
  boardX: number;
  boardY: number;
  boardWidth: number;
  boardHeight: number;
  /** Число барабанов — по нему рисуются разделители колонок. */
  reels: number;
  gap: number;
}

/** Префикс приложения — тот же, что у остальных ассетов (T-210). */
const ASSET_BASE = import.meta.env?.BASE_URL ?? "/";

const GOLD_LIGHT = "#ffe9a8";
const GOLD = "#ffd257";
const GOLD_DEEP = "#a8741a";
const GOLD_SHADOW = "#5b3d08";

/** Задник: глубокий градиент, лучи из-за автомата, виньетка. */
export function buildBackdrop(renderer: Renderer, layout: CabinetLayout): Container {
  const { width: w, height: h } = layout;
  const root = new Container();

  const sky = new Graphics();
  sky.rect(0, 0, w, h).fill(
    new FillGradient({
      type: "radial",
      center: { x: 0.5, y: 0.34 },
      innerRadius: 0,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.78,
      colorStops: [
        { offset: 0, color: "#1b2f5e" },
        { offset: 0.45, color: "#101a35" },
        { offset: 1, color: "#05070f" },
      ],
      textureSpace: "local",
    }),
  );
  root.addChild(sky);

  // Лучи: расходятся из-за вывески, дают ощущение сцены.
  const rays = new Graphics();
  const cx = w / 2;
  const cy = h * 0.18;
  const reach = Math.hypot(w, h);
  for (let i = 0; i < 16; i += 1) {
    const a = (Math.PI * 2 * i) / 16 + 0.2;
    const spread = 0.055;
    rays
      .moveTo(cx, cy)
      .lineTo(cx + Math.cos(a - spread) * reach, cy + Math.sin(a - spread) * reach)
      .lineTo(cx + Math.cos(a + spread) * reach, cy + Math.sin(a + spread) * reach)
      .closePath()
      .fill({ color: 0x6ea8ff, alpha: i % 2 === 0 ? 0.05 : 0.028 });
  }
  root.addChild(rays);

  // Виньетка — четыре градиентные полосы дешевле фильтра размытия.
  const vignette = new Graphics();
  const band = Math.round(Math.min(w, h) * 0.16);
  vignette.rect(0, 0, w, band).fill(fadeVertical(0.55, 0));
  vignette.rect(0, h - band, w, band).fill(fadeVertical(0, 0.6));
  vignette.rect(0, 0, band, h).fill(fadeHorizontal(0.5, 0));
  vignette.rect(w - band, 0, band, h).fill(fadeHorizontal(0, 0.5));
  root.addChild(vignette);

  return bake(renderer, root);
}

function fadeVertical(from: number, to: number): FillGradient {
  return new FillGradient({
    type: "linear",
    start: { x: 0.5, y: 0 },
    end: { x: 0.5, y: 1 },
    colorStops: [
      { offset: 0, color: `rgba(0,0,0,${from})` },
      { offset: 1, color: `rgba(0,0,0,${to})` },
    ],
    textureSpace: "local",
  });
}

function fadeHorizontal(from: number, to: number): FillGradient {
  return new FillGradient({
    type: "linear",
    start: { x: 0, y: 0.5 },
    end: { x: 1, y: 0.5 },
    colorStops: [
      { offset: 0, color: `rgba(0,0,0,${from})` },
      { offset: 1, color: `rgba(0,0,0,${to})` },
    ],
    textureSpace: "local",
  });
}

/** Окно барабанов: тёмное стекло, подсветка колонок, внутренняя тень. */
export function buildReelWindow(renderer: Renderer, layout: CabinetLayout): Container {
  const { boardX: x, boardY: y, boardWidth: bw, boardHeight: bh, reels, gap } = layout;
  const root = new Container();
  const radius = Math.round(Math.min(bw, bh) * 0.045);

  const glass = new Graphics();
  glass.roundRect(x, y, bw, bh, radius).fill(
    new FillGradient({
      type: "linear",
      start: { x: 0.5, y: 0 },
      end: { x: 0.5, y: 1 },
      colorStops: [
        { offset: 0, color: "#050810" },
        { offset: 0.5, color: "#0b1120" },
        { offset: 1, color: "#050810" },
      ],
      textureSpace: "local",
    }),
  );
  root.addChild(glass);

  // Подсветка каждой колонки — «лампы» за барабанами.
  const columns = new Graphics();
  const colWidth = (bw - gap * (reels - 1)) / reels;
  for (let i = 0; i < reels; i += 1) {
    const cx = x + i * (colWidth + gap);
    columns.roundRect(cx, y, colWidth, bh, radius * 0.6).fill(
      new FillGradient({
        type: "linear",
        start: { x: 0.5, y: 0 },
        end: { x: 0.5, y: 1 },
        colorStops: [
          { offset: 0, color: "rgba(120,170,255,0.10)" },
          { offset: 0.5, color: "rgba(120,170,255,0.02)" },
          { offset: 1, color: "rgba(120,170,255,0.10)" },
        ],
        textureSpace: "local",
      }),
    );
    if (i > 0) {
      // Разделитель: тёмная щель со световой нитью.
      columns.rect(cx - gap, y + bh * 0.02, gap, bh * 0.96).fill({ color: 0x03050b, alpha: 0.9 });
      columns
        .rect(cx - gap / 2 - 0.5, y + bh * 0.06, 1, bh * 0.88)
        .fill({ color: 0x7fb0ff, alpha: 0.18 });
    }
  }
  root.addChild(columns);

  return bake(renderer, root);
}

/**
 * Объём барабанов (T-193).
 *
 * Настоящий барабан — цилиндр: верх и низ уходят от зрителя в тень, по
 * середине идёт блик. Слой кладётся ПОВЕРХ символов, поэтому дальние ряды
 * притемняются, а центральный ряд подсвечивается — плоская сетка начинает
 * читаться как вращающийся вал.
 */
export function buildDrumShading(renderer: Renderer, layout: CabinetLayout): Container {
  const { boardX: x, boardY: y, boardWidth: bw, boardHeight: bh } = layout;
  const root = new Container();
  const radius = Math.min(bw, bh) * 0.045;

  const shade = new Graphics();
  shade.roundRect(x, y, bw, bh, radius).fill(
    new FillGradient({
      type: "linear",
      start: { x: 0.5, y: 0 },
      end: { x: 0.5, y: 1 },
      colorStops: [
        { offset: 0, color: "rgba(0,0,0,0.42)" },
        { offset: 0.18, color: "rgba(0,0,0,0.12)" },
        { offset: 0.36, color: "rgba(0,0,0,0)" },
        { offset: 0.5, color: "rgba(255,238,200,0.08)" },
        { offset: 0.64, color: "rgba(0,0,0,0)" },
        { offset: 0.82, color: "rgba(0,0,0,0.12)" },
        { offset: 1, color: "rgba(0,0,0,0.42)" },
      ],
      textureSpace: "local",
    }),
  );
  root.addChild(shade);

  // Стеклянный блик по диагонали — «за стеклом», поверх всего.
  const glass = new Graphics();
  glass
    .moveTo(x, y + bh * 0.72)
    .lineTo(x + bw * 0.38, y)
    .lineTo(x + bw * 0.56, y)
    .lineTo(x + bw * 0.12, y + bh)
    .lineTo(x, y + bh)
    .closePath()
    .fill({ color: 0xffffff, alpha: 0.035 });
  root.addChild(glass);

  return bake(renderer, root);
}

/** Золотая рама с фаской, орнаментом углов и заклёпками. */
export function buildFrame(renderer: Renderer, layout: CabinetLayout): Container {
  const { boardX: x, boardY: y, boardWidth: bw, boardHeight: bh } = layout;
  const root = new Container();
  const t = Math.max(10, Math.round(Math.min(bw, bh) * 0.035));
  const radius = Math.round(Math.min(bw, bh) * 0.05);

  const goldFill = new FillGradient({
    type: "linear",
    start: { x: 0, y: 0 },
    end: { x: 0, y: 1 },
    colorStops: [
      { offset: 0, color: GOLD_LIGHT },
      { offset: 0.28, color: GOLD },
      { offset: 0.55, color: GOLD_DEEP },
      { offset: 0.78, color: GOLD },
      { offset: 1, color: GOLD_SHADOW },
    ],
    textureSpace: "local",
  });

  const frame = new Graphics();
  // Тень под рамой
  frame
    .roundRect(x - t - 3, y - t - 3, bw + (t + 3) * 2, bh + (t + 3) * 2, radius + t)
    .fill({ color: 0x000000, alpha: 0.55 });
  // Тело рамы: широкий штрих по контуру окна
  frame
    .roundRect(x - t / 2, y - t / 2, bw + t, bh + t, radius + t / 2)
    .stroke({ width: t, color: 0xffffff, alignment: 0.5, fill: goldFill });
  // Внутренний и внешний кант
  frame
    .roundRect(x - 1, y - 1, bw + 2, bh + 2, radius)
    .stroke({ width: 2, color: 0x2a1a02, alpha: 0.85 });
  frame
    .roundRect(x - t, y - t, bw + t * 2, bh + t * 2, radius + t)
    .stroke({ width: 2, color: 0xffeeb0, alpha: 0.5 });
  root.addChild(frame);

  // Заклёпки по периметру
  const rivets = new Graphics();
  const step = Math.round(bw / 9);
  for (let px = x + step / 2; px < x + bw; px += step) {
    rivet(rivets, px, y - t / 2, t * 0.16);
    rivet(rivets, px, y + bh + t / 2, t * 0.16);
  }
  const vstep = Math.round(bh / 4);
  for (let py = y + vstep / 2; py < y + bh; py += vstep) {
    rivet(rivets, x - t / 2, py, t * 0.16);
    rivet(rivets, x + bw + t / 2, py, t * 0.16);
  }
  root.addChild(rivets);

  // Угловые ромбы-орнаменты
  const corners = new Graphics();
  const cs = t * 0.95;
  for (const [cx, cy] of [
    [x - t / 2, y - t / 2],
    [x + bw + t / 2, y - t / 2],
    [x - t / 2, y + bh + t / 2],
    [x + bw + t / 2, y + bh + t / 2],
  ]) {
    corners
      .poly([cx, cy - cs, cx + cs, cy, cx, cy + cs, cx - cs, cy])
      .fill(goldFill)
      .stroke({ width: 1.5, color: 0x4a3208, alpha: 0.8 });
    corners.circle(cx, cy, cs * 0.28).fill({ color: 0xff5f7a });
    corners.circle(cx - cs * 0.08, cy - cs * 0.08, cs * 0.1).fill({ color: 0xffffff, alpha: 0.8 });
  }
  root.addChild(corners);

  // Рама занимает только кромки, но как один спрайт это прозрачный quad
  // во весь экран — софтверный рендер честно блендит и пустую середину.
  // Режем текстуру на четыре полосы: центр не рисуется вовсе (T-191).
  return bakeAsBorder(renderer, root);
}

/** Запекает слой и раскладывает его четырьмя полосами по кромкам. */
function bakeAsBorder(renderer: Renderer, source: Container): Container {
  const bounds = source.getLocalBounds();
  const texture = renderer.generateTexture({ target: source, resolution: 1 });
  source.destroy({ children: true });

  const holder = new Container();
  const tw = texture.width;
  const th = texture.height;
  // Толщина кромки с запасом: внутрь полос попадают заклёпки и орнаменты.
  const band = Math.ceil(Math.min(tw, th) * 0.14);

  const strips: Array<[number, number, number, number]> = [
    [0, 0, tw, band],
    [0, th - band, tw, band],
    [0, band, band, th - band * 2],
    [tw - band, band, band, th - band * 2],
  ];
  for (const [sx, sy, sw, sh] of strips) {
    const part = new Texture({ source: texture.source, frame: new Rectangle(sx, sy, sw, sh) });
    const sprite = new Sprite(part);
    sprite.position.set(bounds.x + sx, bounds.y + sy);
    holder.addChild(sprite);
  }
  return holder;
}

function rivet(g: Graphics, cx: number, cy: number, r: number): void {
  g.circle(cx, cy, r).fill({ color: 0x4a3208 });
  g.circle(cx, cy, r * 0.72).fill({ color: 0xffdf8a });
  g.circle(cx - r * 0.22, cy - r * 0.22, r * 0.28).fill({ color: 0xffffff, alpha: 0.85 });
}

/** Вывеска над барабанами: название игры золотом, короны по бокам. */
export function buildMarquee(layout: CabinetLayout, title: string): Container {
  const { width: w, boardY } = layout;
  const root = new Container();
  const plateW = Math.min(w * 0.62, 520);
  const plateH = Math.max(46, Math.round(boardY * 0.52));
  const px = (w - plateW) / 2;
  const py = Math.max(6, boardY * 0.5 - plateH * 0.62);

  const plate = new Graphics();
  plate.roundRect(px, py, plateW, plateH, plateH * 0.42).fill(
    new FillGradient({
      type: "linear",
      start: { x: 0.5, y: 0 },
      end: { x: 0.5, y: 1 },
      colorStops: [
        { offset: 0, color: "#241a3d" },
        { offset: 0.5, color: "#120c22" },
        { offset: 1, color: "#241a3d" },
      ],
      textureSpace: "local",
    }),
  );
  plate
    .roundRect(px, py, plateW, plateH, plateH * 0.42)
    .stroke({ width: 2.5, color: 0xffd257, alpha: 0.85 });
  plate
    .roundRect(px + 5, py + 4, plateW - 10, plateH * 0.42, plateH * 0.3)
    .fill({ color: 0xffffff, alpha: 0.05 });
  root.addChild(plate);

  const label = new Text({
    text: title.toUpperCase(),
    style: new TextStyle({
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontSize: Math.round(plateH * 0.46),
      fontWeight: "700",
      letterSpacing: Math.round(plateH * 0.08),
      align: "center",
      fill: new FillGradient({
        type: "linear",
        start: { x: 0.5, y: 0 },
        end: { x: 0.5, y: 1 },
        colorStops: [
          { offset: 0, color: "#fff6d0" },
          { offset: 0.45, color: GOLD },
          { offset: 1, color: GOLD_DEEP },
        ],
        textureSpace: "local",
      }),
      stroke: { width: 3, color: 0x3a2503 },
      dropShadow: { color: 0xffb347, alpha: 0.45, blur: 8, distance: 0, angle: 0 },
    }),
  });
  label.anchor.set(0.5);
  label.position.set(w / 2, py + plateH / 2);
  root.addChild(label);

  // Огоньки по краю вывески — мигают в `animateMarquee`.
  const bulbs = new Container();
  const count = 14;
  for (let i = 0; i < count; i += 1) {
    const bulb = new Graphics();
    const bx = px + (plateW / (count - 1)) * i;
    bulb.circle(0, 0, plateH * 0.075).fill({ color: 0xffe9a8 });
    bulb.position.set(bx, py + plateH * 0.5 + (i % 2 === 0 ? -plateH * 0.62 : plateH * 0.62));
    bulb.alpha = i % 2 === 0 ? 0.9 : 0.35;
    bulbs.addChild(bulb);
  }
  root.addChild(bulbs);
  (root as Container & { bulbs?: Container }).bulbs = bulbs;

  return root;
}

/**
 * Блик, пробегающий по золотой раме (T-193).
 *
 * Металл выглядит металлом, только когда по нему ходит свет. Полоса
 * движется по диагонали и обрезается маской рамы — получается отражение,
 * а не белая линия поверх сцены.
 */
export function buildFrameSheen(layout: CabinetLayout, ticker: Ticker): Container {
  const { boardX: x, boardY: y, boardWidth: bw, boardHeight: bh } = layout;
  const t = Math.max(10, Math.round(Math.min(bw, bh) * 0.035));
  const root = new Container();
  root.eventMode = "none";

  const outer = { x: x - t, y: y - t, w: bw + t * 2, h: bh + t * 2 };

  const sheen = new Graphics();
  const width = t * 2.6;
  sheen
    .rect(-width / 2, -outer.h, width, outer.h * 3)
    .fill(
      new FillGradient({
        type: "linear",
        start: { x: 0, y: 0.5 },
        end: { x: 1, y: 0.5 },
        colorStops: [
          { offset: 0, color: "rgba(255,255,255,0)" },
          { offset: 0.5, color: "rgba(255,255,255,0.55)" },
          { offset: 1, color: "rgba(255,255,255,0)" },
        ],
        textureSpace: "local",
      }),
    );
  sheen.rotation = -0.35;
  root.addChild(sheen);

  // Маска — сама рамка: кольцо между внешним и внутренним прямоугольником.
  const mask = new Graphics();
  mask
    .roundRect(outer.x, outer.y, outer.w, outer.h, t * 1.6)
    .fill({ color: 0xffffff })
    .roundRect(x, y, bw, bh, Math.min(bw, bh) * 0.045)
    .cut();
  root.addChild(mask);
  root.mask = mask;

  const travel = outer.w + width * 2;
  let phase = 0;
  ticker.add(() => {
    // Пауза между проходами: непрерывно бегающий блик выглядит дёшево.
    phase = (phase + ticker.deltaMS) % 5200;
    const p = phase / 1400;
    sheen.visible = p <= 1;
    if (sheen.visible) sheen.position.set(outer.x - width + travel * p, outer.y + outer.h / 2);
  });

  return root;
}

/** Бегущие огни вывески: чередование через тикер, без gsap-таймлайнов. */
export function animateMarquee(marquee: Container, ticker: Ticker): () => void {
  const bulbs = (marquee as Container & { bulbs?: Container }).bulbs;
  if (!bulbs) return () => undefined;
  let phase = 0;
  const step = (): void => {
    phase += ticker.deltaMS;
    const idx = Math.floor(phase / 260);
    bulbs.children.forEach((bulb, i) => {
      bulb.alpha = (i + idx) % 2 === 0 ? 0.95 : 0.3;
    });
  };
  ticker.add(step);
  return () => ticker.remove(step);
}

/**
 * Слой праздника: вспышка окна и баннер крупного выигрыша.
 *
 * Держится отдельным контейнером поверх рамы, чтобы эффекты не зависели от
 * внутренностей барабанов и не мешали пулу символов.
 */
export class WinFx {
  readonly view = new Container();
  private readonly flash = new Graphics();
  private readonly sparks = new Container();
  private readonly banner = new Container();
  private bonusLayer?: Container;
  private bonusCounter?: Text;

  constructor(private readonly layout: CabinetLayout) {
    const { boardX: x, boardY: y, boardWidth: bw, boardHeight: bh } = layout;
    this.flash.roundRect(x, y, bw, bh, Math.min(bw, bh) * 0.045).fill({ color: 0xffe9a8 });
    this.flash.alpha = 0;

    // Содержимое баннера создаётся в момент показа, а не здесь.
    // Text, созданный с пустой строкой и наполненный позже, у Pixi v8
    // остаётся вне отрисовки: объект в графе сцены выглядит правильно
    // (alpha 1, границы посчитаны), но пикселей не даёт. Именно так молча
    // пропадал баннер крупного выигрыша (T-191). Крупный выигрыш — событие
    // редкое, пара объектов на показ ничего не стоит.
    this.banner.position.set(x + bw / 2, y + bh / 2);

    this.view.addChild(this.sparks);
    this.view.eventMode = "none";
  }

  /** Короткая вспышка окна барабанов — реакция на любой выигрыш. */
  pulse(gsapInstance: typeof import("gsap").default, strength = 0.18): void {
    gsapInstance.killTweensOf(this.flash);
    this.flash.alpha = 0;
    this.view.addChildAt(this.flash, 0);
    gsapInstance.to(this.flash, {
      alpha: strength,
      duration: 0.12,
      yoyo: true,
      repeat: 1,
      ease: "sine.out",
      onComplete: () => {
        this.flash.removeFromParent();
      },
    });
  }

  /**
   * Баннер крупного выигрыша с разлетающимися искрами.
   * Возвращает промис, чтобы вызывающий код мог дождаться показа.
   */
  async celebrate(
    gsapInstance: typeof import("gsap").default,
    title: string,
    amount: string,
    holdMs = 1500,
  ): Promise<void> {
    const { boardWidth: bw, boardHeight: bh } = this.layout;
    this.banner.removeChildren().forEach((child) => child.destroy());

    // Подложка: поверх барабанов текст иначе спорит с символами.
    const scrim = new Graphics();
    const sw = Math.min(bw * 0.92, bh * 2.1);
    const sh = bh * 0.46;
    scrim
      .roundRect(-sw / 2, -sh / 2, sw, sh, sh * 0.22)
      .fill({ color: 0x07050f, alpha: 0.93 })
      .roundRect(-sw / 2, -sh / 2, sw, sh, sh * 0.22)
      .stroke({ width: 2.5, color: 0xffd257, alpha: 0.75 });
    this.banner.addChild(scrim);

    const titleText = new Text({
      text: title,
      style: new TextStyle({
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: Math.round(bh * 0.1),
        fontWeight: "700",
        letterSpacing: 2,
        align: "center",
        fill: 0xfff3cf,
        stroke: { width: 5, color: 0x2a1600 },
        dropShadow: { color: 0x000000, alpha: 0.7, blur: 6, distance: 3, angle: Math.PI / 2 },
      }),
    });
    titleText.anchor.set(0.5);
    titleText.position.set(0, -bh * 0.1);

    const amountText = new Text({
      text: amount,
      style: new TextStyle({
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: Math.round(bh * 0.17),
        fontWeight: "700",
        align: "center",
        fill: 0xffd257,
        stroke: { width: 6, color: 0x2a1600 },
        dropShadow: { color: 0xff9f3c, alpha: 0.55, blur: 12, distance: 0, angle: 0 },
      }),
    });
    amountText.anchor.set(0.5);
    amountText.position.set(0, bh * 0.08);

    this.banner.addChild(titleText, amountText);
    this.banner.scale.set(0.3);
    this.banner.alpha = 0;
    this.view.addChildAt(this.flash, 0);
    this.view.addChild(this.banner);

    this.spawnSparks(gsapInstance, 28);
    gsapInstance.to(this.banner, { alpha: 1, duration: 0.25, ease: "power2.out" });
    gsapInstance.to(this.banner.scale, { x: 1, y: 1, duration: 0.5, ease: "back.out(2)" });
    gsapInstance.to(this.flash, { alpha: 0.3, duration: 0.16, yoyo: true, repeat: 3, ease: "sine.inOut" });

    await new Promise((resolve) => setTimeout(resolve, holdMs));

    await new Promise<void>((resolve) => {
      gsapInstance.to(this.banner, {
        alpha: 0,
        duration: 0.3,
        ease: "power2.in",
        onComplete: () => {
          this.banner.removeFromParent();
          this.flash.removeFromParent();
          this.flash.alpha = 0;
          resolve();
        },
      });
    });
  }

  /**
   * Фонтан монет и искр (T-193).
   *
   * Объём делают три вещи: монета вращается вокруг вертикальной оси
   * (сжимаем по X — получается вращающийся диск), летит по параболе с
   * гравитацией, а не по прямой, и уменьшается по мере удаления.
   */
  /**
   * Объявление бонуса: сундук открывается, из него бьёт фонтан монет (T-200).
   *
   * Показывается один раз при входе в серию фриспинов, до первого из них.
   * Игрок должен успеть понять, что произошло, поэтому пауза фиксированная,
   * а не «пока не кликнут»: автоспин не должен упираться в модалку.
   */
  async celebrateBonus(
    gsapInstance: typeof import("gsap").default,
    spins: number,
    multiplier: number,
    holdMs = 2200,
  ): Promise<void> {
    const { boardX: x, boardY: y, boardWidth: bw, boardHeight: bh } = this.layout;
    const layer = new Container();

    const scrim = new Graphics();
    scrim.roundRect(x, y, bw, bh, Math.min(bw, bh) * 0.045).fill({ color: 0x05030c, alpha: 0.86 });
    layer.addChild(scrim);

    // Сундук. Если картинка не загрузилась — обойдёмся текстом: объявление
    // бонуса важнее, чем его иллюстрация.
    let chest: Sprite | undefined;
    try {
      const texture = await Assets.load<Texture>(`${ASSET_BASE}bonus/chest_closed.png`);
      chest = new Sprite(texture);
      chest.anchor.set(0.5);
      const size = bh * 0.42;
      chest.scale.set(size / Math.max(texture.width, texture.height));
      chest.position.set(x + bw / 2, y + bh * 0.42);
      chest.alpha = 0;
      layer.addChild(chest);
    } catch {
      /* без картинки */
    }

    const title = new Text({
      text: "БОНУС!",
      style: new TextStyle({
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: Math.round(bh * 0.13),
        fontWeight: "700",
        letterSpacing: 3,
        fill: 0xffd257,
        stroke: { width: 6, color: 0x2a1600 },
        dropShadow: { color: 0xff9f3c, alpha: 0.6, blur: 14, distance: 0, angle: 0 },
      }),
    });
    title.anchor.set(0.5);
    title.position.set(x + bw / 2, y + bh * 0.13);
    title.alpha = 0;
    layer.addChild(title);

    const detail = new Text({
      text: multiplier > 1 ? `${spins} фриспинов · множитель ×${multiplier}` : `${spins} фриспинов`,
      style: new TextStyle({
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: Math.round(bh * 0.075),
        fontWeight: "700",
        fill: 0xfff3cf,
        stroke: { width: 4, color: 0x2a1600 },
      }),
    });
    detail.anchor.set(0.5);
    detail.position.set(x + bw / 2, y + bh * 0.78);
    detail.alpha = 0;
    layer.addChild(detail);

    this.view.addChild(layer);

    gsapInstance.fromTo(title, { alpha: 0, y: title.y - bh * 0.06 }, { alpha: 1, y: title.y, duration: 0.35, ease: "back.out(2)" });
    if (chest) {
      gsapInstance.fromTo(chest.scale, { x: chest.scale.x * 0.5, y: chest.scale.y * 0.5 }, { x: chest.scale.x, y: chest.scale.y, duration: 0.4, ease: "back.out(2.2)" });
      gsapInstance.to(chest, { alpha: 1, duration: 0.25 });
      // Крышка «распахивается»: подменяем текстуру и добавляем встряску.
      setTimeout(() => {
        void Assets.load<Texture>(`${ASSET_BASE}bonus/chest_open.png`)
          .then((open) => {
            if (chest) chest.texture = open;
            this.spawnSparks(gsapInstance, 34);
          })
          .catch(() => this.spawnSparks(gsapInstance, 34));
        gsapInstance.fromTo(chest!, { rotation: -0.06 }, { rotation: 0.06, duration: 0.09, yoyo: true, repeat: 5 });
      }, 520);
    }
    gsapInstance.to(detail, { alpha: 1, duration: 0.3, delay: 0.75 });

    await new Promise((resolve) => setTimeout(resolve, holdMs));

    await new Promise<void>((resolve) => {
      gsapInstance.to(layer, {
        alpha: 0,
        duration: 0.32,
        ease: "power2.in",
        onComplete: () => {
          layer.destroy({ children: true });
          resolve();
        },
      });
    });
  }

  /**
   * Трассер выигрышной линии (T-209).
   *
   * Подсветка символов показывает ЧТО выиграло, но не показывает КАК линия
   * прошла по полю. Трассер рисует путь: светящаяся кривая пробегает через
   * центры выигрышных ячеек и гаснет. Координаты приходят снаружи — сцена
   * не знает про геометрию барабанов и не должна.
   */
  async traceLine(
    gsapInstance: typeof import("gsap").default,
    points: Array<{ x: number; y: number }>,
    color = 0xffd257,
  ): Promise<void> {
    if (points.length < 2) return;

    const line = new Graphics();
    const glow = new Graphics();
    const layer = new Container();
    layer.addChild(glow, line);
    this.view.addChild(layer);

    const draw = (progress: number): void => {
      line.clear();
      glow.clear();
      // Сколько сегментов уже пройдено
      const total = points.length - 1;
      const done = Math.min(total, progress * total);
      const full = Math.floor(done);
      const tail = done - full;

      const path: Array<{ x: number; y: number }> = points.slice(0, full + 1);
      if (full < total) {
        const a = points[full];
        const b = points[full + 1];
        path.push({ x: a.x + (b.x - a.x) * tail, y: a.y + (b.y - a.y) * tail });
      }
      if (path.length < 2) return;

      const trace = (g: Graphics, width: number, alpha: number): void => {
        g.moveTo(path[0].x, path[0].y);
        for (const point of path.slice(1)) g.lineTo(point.x, point.y);
        g.stroke({ width, color, alpha, cap: "round", join: "round" });
      };
      trace(glow, 14, 0.18);
      trace(line, 4, 0.95);

      // Огонёк на острие
      const head = path[path.length - 1];
      line.circle(head.x, head.y, 7).fill({ color: 0xffffff, alpha: 0.9 });
      line.circle(head.x, head.y, 13).fill({ color, alpha: 0.25 });
    };

    const state = { progress: 0 };
    await new Promise<void>((resolve) => {
      gsapInstance.to(state, {
        progress: 1,
        duration: 0.5,
        ease: "power1.inOut",
        onUpdate: () => draw(state.progress),
        onComplete: () => resolve(),
      });
    });

    await new Promise<void>((resolve) => {
      gsapInstance.to(layer, {
        alpha: 0,
        duration: 0.35,
        delay: 0.25,
        onComplete: () => {
          layer.destroy({ children: true });
          resolve();
        },
      });
    });
  }

  /**
   * Режим бонуса (T-212): пока идёт серия фриспинов, окно барабанов
   * подсвечивается тёплым золотом, а сверху висит счётчик «спин N из M».
   * Без этого бонус визуально не отличается от обычной игры — а он
   * должен ощущаться отдельным состоянием.
   */
  setBonusMode(active: boolean, spin = 0, total = 0, multiplier = 1): void {
    const { boardX: x, boardY: y, boardWidth: bw, boardHeight: bh } = this.layout;

    if (!active) {
      this.bonusLayer?.destroy({ children: true });
      this.bonusLayer = undefined;
      this.bonusCounter = undefined;
      return;
    }

    if (!this.bonusLayer) {
      const layer = new Container();
      layer.eventMode = "none";

      const tint = new Graphics();
      tint.roundRect(x, y, bw, bh, Math.min(bw, bh) * 0.045).fill(
        new FillGradient({
          type: "linear",
          start: { x: 0.5, y: 0 },
          end: { x: 0.5, y: 1 },
          colorStops: [
            { offset: 0, color: "rgba(255,190,80,0.16)" },
            { offset: 0.5, color: "rgba(255,150,40,0.05)" },
            { offset: 1, color: "rgba(255,190,80,0.16)" },
          ],
          textureSpace: "local",
        }),
      );
      // Золотая кромка внутри окна: рамка «горит» на время серии.
      tint.roundRect(x + 2, y + 2, bw - 4, bh - 4, Math.min(bw, bh) * 0.045)
        .stroke({ width: 3, color: 0xffd257, alpha: 0.55 });
      layer.addChild(tint);

      this.bonusCounter = new Text({
        text: "",
        style: new TextStyle({
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: Math.round(bh * 0.075),
          fontWeight: "700",
          fill: 0xffd257,
          stroke: { width: 4, color: 0x2a1600 },
          dropShadow: { color: 0x000000, alpha: 0.6, blur: 4, distance: 2, angle: Math.PI / 2 },
        }),
      });
      this.bonusCounter.anchor.set(0.5, 0);
      this.bonusCounter.position.set(x + bw / 2, y + bh * 0.012);
      layer.addChild(this.bonusCounter);

      this.view.addChildAt(layer, 0);
      this.bonusLayer = layer;
    }

    if (this.bonusCounter) {
      const mult = multiplier > 1 ? ` · ×${multiplier}` : "";
      this.bonusCounter.text = `БОНУС · спин ${spin} из ${total}${mult}`;
    }
  }

  private spawnSparks(gsapInstance: typeof import("gsap").default, count: number): void {
    const { boardWidth: bw, boardHeight: bh, boardX: x, boardY: y } = this.layout;
    const cx = x + bw / 2;
    const cy = y + bh / 2;

    for (let i = 0; i < count; i += 1) {
      const isCoin = Math.random() > 0.35;
      const piece = new Graphics();
      const r = isCoin ? 7 + Math.random() * 7 : 2 + Math.random() * 3;

      if (isCoin) {
        piece
          .circle(0, 0, r)
          .fill({ color: 0xffb524 })
          .circle(0, 0, r * 0.78)
          .fill({ color: 0xffe07a })
          .circle(-r * 0.25, -r * 0.25, r * 0.28)
          .fill({ color: 0xfff7d6, alpha: 0.9 });
      } else {
        piece.circle(0, 0, r).fill({ color: 0xfff3c4, alpha: 0.95 });
      }

      piece.position.set(cx, cy);
      this.sparks.addChild(piece);

      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
      const power = bh * (0.3 + Math.random() * 0.5);
      const flight = 0.9 + Math.random() * 0.7;
      const targetX = cx + Math.cos(angle) * power * 1.3;
      const apexY = cy + Math.sin(angle) * power;

      gsapInstance.to(piece, { x: targetX, duration: flight, ease: "none" });
      // Парабола: вверх с замедлением, вниз с ускорением.
      gsapInstance.to(piece, { y: apexY, duration: flight * 0.42, ease: "power2.out" });
      gsapInstance.to(piece, {
        y: cy + bh * 0.75,
        duration: flight * 0.58,
        delay: flight * 0.42,
        ease: "power2.in",
      });
      gsapInstance.to(piece, { alpha: 0, duration: 0.35, delay: flight * 0.65 });
      gsapInstance.to(piece.scale, {
        x: isCoin ? 0.15 : 0.4,
        duration: 0.28,
        repeat: isCoin ? Math.ceil(flight / 0.28) : 0,
        yoyo: true,
        ease: "sine.inOut",
      });
      gsapInstance.to(piece, {
        rotation: (Math.random() - 0.5) * 6,
        duration: flight,
        ease: "none",
        onComplete: () => piece.destroy(),
      });
    }
  }

  /**
   * Тряска «камеры» на мега-выигрыше: двигаем корневой контейнер сцены.
   * Затухающая, короткая — иначе укачивает.
   */
  shake(gsapInstance: typeof import("gsap").default, stage: Container, strength = 10): void {
    const base = { x: stage.x, y: stage.y };
    const steps = 7;
    const timeline: Array<Promise<void>> = [];
    for (let i = 0; i < steps; i += 1) {
      const damp = strength * (1 - i / steps);
      timeline.push(
        new Promise((resolve) => {
          gsapInstance.to(stage, {
            x: base.x + (Math.random() - 0.5) * damp * 2,
            y: base.y + (Math.random() - 0.5) * damp * 2,
            duration: 0.06,
            delay: i * 0.06,
            ease: "none",
            onComplete: () => resolve(),
          });
        }),
      );
    }
    void Promise.all(timeline).then(() => {
      gsapInstance.to(stage, { x: base.x, y: base.y, duration: 0.12, ease: "power2.out" });
    });
  }
}
