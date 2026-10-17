#!/usr/bin/env python3
"""Draws the pictures the GitHub page uses, from the portrait (fork/brand/hermoso/source.png):

  docs/hermoso/banner.png          1600 x 800, the top of the README
  docs/hermoso/social-preview.png  1280 x 640, for Settings > Social preview of the repository

Run it from anywhere:  python apps/desktop/fork/brand/banner.py

It needs Pillow and the Segoe UI fonts that come with Windows. The pictures are not derived files in the sense of the
`brand:` commit (they are drawn by hand, once, and committed like any other document), so nothing regenerates them.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
PORTRAIT = HERE / "hermoso" / "source.png"
OUT = REPO / "docs" / "hermoso"
FONTS = Path(r"C:\Windows\Fonts")

W, H = 1600, 800
SCALE = 2  # drawn twice as large and shrunk at the end, so every edge is smooth

INK = (17, 17, 17)
GREY = (96, 96, 96)
LIGHT = (140, 140, 140)

TAGLINE = "The brother who protects."
SUB_LINES = ["A bodyguard for the AI agent", "that works on your computer."]
CHIPS = ["Shield", "Guardian", "Time Machine", "Ghost", "Teleport", "Aura"]
FOOT = "Built on Hermes Desktop  \u00b7  Windows  \u00b7  MIT"


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    path = FONTS / name

    if not path.exists():
        sys.exit(f"missing font {path}: this script needs the Segoe UI fonts of Windows")

    return ImageFont.truetype(str(path), size * SCALE)


def s(value: float) -> int:
    return int(round(value * SCALE))


def main() -> None:
    canvas = Image.new("RGB", (W * SCALE, H * SCALE), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)

    # ── the tile: the portrait inside a black rounded border, like the app's icon ──
    tile = 640
    tx, ty = 90, (H - tile) // 2
    border = 26

    draw.rounded_rectangle([s(tx), s(ty), s(tx + tile), s(ty + tile)], radius=s(150), fill=INK)
    draw.rounded_rectangle(
        [s(tx + border), s(ty + border), s(tx + tile - border), s(ty + tile - border)], radius=s(150 - border), fill=(255, 255, 255)
    )

    inner = tile - 2 * border
    portrait = Image.open(PORTRAIT).convert("RGBA").resize((s(inner), s(inner)), Image.LANCZOS)
    mask = Image.new("L", (s(inner), s(inner)), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s(inner) - 1, s(inner) - 1], radius=s(150 - border), fill=255)
    layer = Image.new("RGBA", portrait.size, (255, 255, 255, 0))
    layer.paste(portrait, (0, int(portrait.size[1] * 0.027)), portrait)
    layer.putalpha(Image.composite(layer.getchannel("A"), Image.new("L", layer.size, 0), mask))
    canvas.paste(layer, (s(tx + border), s(ty + border)), layer)

    # ── the words ──
    left = tx + tile + 90
    room = W - left - 80

    # the name, as large as the room allows
    size = 150

    while True:
        name = font("seguibl.ttf", size)

        if draw.textlength("HERMOSO", font=name) <= room * SCALE or size <= 60:
            break

        size -= 2

    top = 128
    draw.text((s(left), s(top)), "HERMOSO", font=name, fill=INK)
    y = top + size + 34

    draw.text((s(left), s(y)), TAGLINE, font=font("segoeuib.ttf", 46), fill=INK)
    y += 78

    # the line under it
    body = font("segoeui.ttf", 31)

    for text in SUB_LINES:
        draw.text((s(left), s(y)), text, font=body, fill=GREY)
        y += 44

    y += 26

    # the six protections, as chips
    chip_font = font("segoeuib.ttf", 25)
    pad_x, pad_y, gap = 22, 11, 14
    x = left
    row_h = 25 + 2 * pad_y + 10

    for label in CHIPS:
        width = int(draw.textlength(label, font=chip_font) / SCALE) + 2 * pad_x

        if label == "Ghost":
            x = left
            y += row_h + 4

        draw.rounded_rectangle([s(x), s(y), s(x + width), s(y + row_h)], radius=s(row_h / 2), outline=INK, width=s(3))
        draw.text((s(x + pad_x), s(y + pad_y - 1)), label, font=chip_font, fill=INK)
        x += width + gap

    y += row_h + 38
    draw.text((s(left), s(y)), FOOT, font=font("segoeui.ttf", 21), fill=LIGHT)

    OUT.mkdir(parents=True, exist_ok=True)

    banner = canvas.resize((W, H), Image.LANCZOS)
    banner.save(OUT / "banner.png", optimize=True)
    banner.resize((1280, 640), Image.LANCZOS).save(OUT / "social-preview.png", optimize=True)
    print("wrote", OUT / "banner.png", "and", OUT / "social-preview.png")


if __name__ == "__main__":
    main()
