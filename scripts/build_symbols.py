#!/usr/bin/env python3
"""
Сборка игровых текстур символов из исходных рендеров (T-193).

Исходники (`client/art/src/*.jpg`) — рендеры на чёрном фоне. Скрипт
переводит фон в альфу по яркости, обрезает по содержимому, центрирует в
квадрате и масштабирует до игрового размера в `client/public/symbols/`.

Порог сделан мягким (LOW…HIGH), иначе по краям объекта остаётся чёрная
кайма: у полупрозрачных пикселей цвет подмешан с фоном, и его приходится
осветлять обратно.

Запуск:
    python3 scripts/build_symbols.py            # 256px
    python3 scripts/build_symbols.py --size 512
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "client" / "art" / "src"
DST = ROOT / "client" / "public" / "symbols"

LOW, HIGH = 12, 60      # границы перевода яркости фона в альфу
PADDING = 1.06          # запас вокруг объекта, чтобы символы были одного масштаба


def build(name: str, size: int) -> None:
    source = SRC / f"{name}.jpg"
    if not source.exists():
        print(f"пропуск {name}: нет {source}")
        return

    im = Image.open(source).convert("RGB")
    px = im.load()
    w, h = im.size
    out = Image.new("RGBA", (w, h))
    op = out.load()

    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            lum = max(r, g, b)
            if lum <= LOW:
                op[x, y] = (0, 0, 0, 0)
            elif lum >= HIGH:
                op[x, y] = (r, g, b, 255)
            else:
                alpha = int((lum - LOW) / (HIGH - LOW) * 255)
                k = 255 / max(lum, 1)
                op[x, y] = (
                    min(255, int(r * k * 0.7 + r * 0.3)),
                    min(255, int(g * k * 0.7 + g * 0.3)),
                    min(255, int(b * k * 0.7 + b * 0.3)),
                    alpha,
                )

    box = out.getbbox()
    if box is None:
        print(f"пропуск {name}: пустое изображение")
        return
    out = out.crop(box)

    side = int(max(out.size) * PADDING)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(out, ((side - out.width) // 2, (side - out.height) // 2))
    canvas = canvas.resize((size, size), Image.LANCZOS)

    DST.mkdir(parents=True, exist_ok=True)
    target = DST / f"{name}.png"
    canvas.save(target, optimize=True)
    print(f"{name}: {im.size} -> {size}px, {target.stat().st_size // 1024} КБ")


def main() -> None:
    ap = argparse.ArgumentParser(description="Сборка текстур символов")
    ap.add_argument("--size", type=int, default=256, help="сторона игровой текстуры")
    ap.add_argument("--only", nargs="*", help="собрать только указанные символы")
    args = ap.parse_args()

    names = args.only or sorted(p.stem for p in SRC.glob("*.jpg"))
    for name in names:
        build(name, args.size)


if __name__ == "__main__":
    main()
