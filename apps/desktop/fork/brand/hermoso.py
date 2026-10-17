#!/usr/bin/env python3
"""Draw the Hermoso art: the brother's portrait on the same tiles the official Hermes uses.

The official logo is a rounded-square tile (a thick outline, a white inside) with the Nous girl
drawn in black ink, in a light and a dark variant, in many sizes (icons, the Windows Store logos,
the in-app brand mark). Hermoso is her brother, so his portrait goes on the very same tiles:

    light   white tile, black outline, black ink on white
    dark    black tile, white outline, white face and a white halo around the figure so the black
            hair does not melt into the black tile (the official dark icon does the same)

The portrait is fork/brand/hermoso/source.png: black ink on transparent, 1254x1254. Every file is
drawn at the size and at the position of the official one, which is read from the PRISTINE official
art (the runtime checkout, or a git ref): so a new official size, a renamed file or a new dark
variant is picked up by itself, and an upstream change to those binaries can never conflict (this
script is run by fork/sync.mjs after every replay; the result is a derived "brand:" commit).

    python hermoso.py                      draw every logo image, reading the official runtime checkout
    python hermoso.py --source DIR         read the originals from another apps/desktop directory
    python hermoso.py --git-ref REF        read the originals from git (REF:apps/desktop/<path>)
    python hermoso.py --list               print what would be drawn (changes nothing)
    python hermoso.py --check              verify every logo image in --dest is Hermoso art (exit 1 if not)
    python hermoso.py --preview FILE.png   write a contact sheet (changes nothing)

Same switches as recolor.py (the Mullvad fork's art script), so fork/sync.mjs drives either one.
Needs Pillow and numpy.
"""

from __future__ import annotations

import argparse
import io
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image, PngImagePlugin

import recolor  # same directory: where the pristine art is, and how to find the logo files in it

HERE = Path(__file__).resolve().parent
DESKTOP = HERE.parent.parent  # .../apps/desktop
SOURCE_ART = HERE / "hermoso" / "source.png"

# What `--check` looks for in every file, so Hermoso art can never be taken for official art that
# happens to be black and white too. It is a PNG text chunk (inside every ICO frame as well).
SIGNATURE = b"hermoso-art/1"

# The geometry of the official tile, measured on assets/icon.png (1024) and on every other size:
CORNER = 0.24  # corner radius, as a share of the tile side
RING = 0.041  # outline thickness
HALO = 0.012  # white halo around the figure on the dark tile
FIT = 0.97  # the portrait's height, as a share of the room inside the outline

INK = (0, 0, 0)
WHITE = (255, 255, 255)

MASTER = 1024  # the portrait is laid out once at this size, then resampled for every other size


# --- shapes ----------------------------------------------------------------------------------


def rounded_square(size: int, inset: float, radius: float) -> np.ndarray:
    """Coverage (0..1, antialiased) of a rounded square inset by `inset` px, corner radius `radius`."""
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
    x = xs + 0.5 - size / 2
    y = ys + 0.5 - size / 2
    half = size / 2 - inset - radius
    qx = np.abs(x) - half
    qy = np.abs(y) - half
    outside = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
    inside = np.minimum(np.maximum(qx, qy), 0)
    sdf = outside + inside - radius  # < 0 inside the shape

    return np.clip(0.5 - sdf, 0.0, 1.0)


def grow(mask: np.ndarray, radius: int) -> np.ndarray:
    """Binary dilation by a square of half-width `radius` (separable sliding max)."""
    out = mask.copy()

    for axis in (0, 1):
        acc = out.copy()
        for shift in range(1, radius + 1):
            acc = np.maximum(acc, np.roll(out, shift, axis=axis))
            acc = np.maximum(acc, np.roll(out, -shift, axis=axis))
        out = acc

    return out


def shrink(mask: np.ndarray, radius: int) -> np.ndarray:
    return ~grow(~mask, radius)


def fill_holes(mask: np.ndarray) -> np.ndarray:
    """Everything the outside cannot reach (a flood from the border, through background only)."""
    h, w = mask.shape
    outside = np.zeros_like(mask)
    stack = [(0, 0), (0, w - 1), (h - 1, 0), (h - 1, w - 1)]

    while stack:
        y, x = stack.pop()
        if y < 0 or y >= h or x < 0 or x >= w or outside[y, x] or mask[y, x]:
            continue
        # sweep a whole row run at once: much faster than pixel by pixel
        x0 = x
        while x0 > 0 and not outside[y, x0 - 1] and not mask[y, x0 - 1]:
            x0 -= 1
        x1 = x
        while x1 < w - 1 and not outside[y, x1 + 1] and not mask[y, x1 + 1]:
            x1 += 1
        outside[y, x0 : x1 + 1] = True
        for yy in (y - 1, y + 1):
            if 0 <= yy < h:
                row = ~outside[yy, x0 : x1 + 1] & ~mask[yy, x0 : x1 + 1]
                starts = np.nonzero(row & ~np.concatenate(([False], row[:-1])))[0]
                for s in starts:
                    stack.append((yy, x0 + int(s)))

    return ~outside


# --- the portrait ------------------------------------------------------------------------------


class Portrait:
    """The brother, laid out inside a MASTER-sized tile: ink coverage and silhouette, as 0..1 floats."""

    def __init__(self, path: Path = SOURCE_ART):
        art = Image.open(path).convert("RGBA")
        alpha = np.asarray(art)[..., 3].astype(np.float32) / 255.0
        ys, xs = np.nonzero(alpha > 0.04)
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        crop = Image.fromarray((alpha[y0:y1, x0:x1] * 255).astype(np.uint8))

        ring = RING * MASTER
        room = MASTER - 2 * ring
        height = FIT * room
        scale = height / crop.size[1]
        width = round(crop.size[0] * scale)
        resized = crop.resize((width, round(height)), Image.Resampling.LANCZOS)

        layer = np.zeros((MASTER, MASTER), dtype=np.float32)
        left = round((MASTER - width) / 2)
        top = round(MASTER - ring - height)  # bottom-anchored: the shoulders bleed into the outline, like the girl's
        layer[top : top + resized.size[1], left : left + width] = np.asarray(resized).astype(np.float32) / 255.0
        self.ink = layer

        # the silhouette: close the small gaps in the linework, fill what the outside cannot reach
        solid = layer > 0.5
        gap = max(2, round(0.008 * MASTER))
        closed = shrink(grow(solid, gap), gap)
        self.silhouette = fill_holes(closed).astype(np.float32)

    def at(self, size: int) -> tuple[np.ndarray, np.ndarray]:
        """(ink, silhouette) resampled to a tile of `size` px."""
        if size == MASTER:
            return self.ink, self.silhouette

        def scaled(layer: np.ndarray) -> np.ndarray:
            image = Image.fromarray((np.clip(layer, 0, 1) * 255).astype(np.uint8))
            return np.asarray(image.resize((size, size), Image.Resampling.LANCZOS)).astype(np.float32) / 255.0

        return scaled(self.ink), scaled(self.silhouette)


# --- the tile ----------------------------------------------------------------------------------


def over(base: np.ndarray, color: tuple[int, int, int], coverage: np.ndarray) -> np.ndarray:
    """`color` painted over `base` (HxWx3 floats) with the given coverage."""
    cov = coverage[..., None]
    return base * (1 - cov) + np.array(color, dtype=np.float32) * cov


def render_tile(portrait: Portrait, size: int, dark: bool) -> Image.Image:
    """One RGBA tile of `size` px."""
    ring = RING * size
    outer = rounded_square(size, 0.0, CORNER * size)
    inner = rounded_square(size, ring, max(1.0, CORNER * size - ring))
    ink, silhouette = portrait.at(size)

    if not dark:
        rgb = np.full((size, size, 3), 255.0, dtype=np.float32)
        rgb = over(rgb, INK, np.clip(outer - inner, 0, 1))  # the outline
        rgb = over(rgb, INK, ink * inner)  # the portrait, kept inside the outline
    else:
        rgb = np.zeros((size, size, 3), dtype=np.float32)  # black tile
        rgb = over(rgb, WHITE, np.clip(outer - inner, 0, 1))  # white outline
        halo_px = max(1, round(HALO * size))
        halo = grow(silhouette > 0.5, halo_px).astype(np.float32)
        rgb = over(rgb, WHITE, halo * inner)  # a white halo, so black hair does not melt into the tile
        rgb = over(rgb, WHITE, silhouette * inner)  # white face
        rgb = over(rgb, INK, ink * inner)  # black ink on top

    alpha = np.clip(outer, 0, 1)
    out = np.dstack([np.clip(np.rint(rgb), 0, 255).astype(np.uint8), np.rint(alpha * 255).astype(np.uint8)])

    return Image.fromarray(out)


def is_dark(rel: str) -> bool:
    return "-dark" in Path(rel).stem.lower()


def tile_box(frame: np.ndarray) -> tuple[int, int, int, int] | None:
    """(left, top, side, side) of the tile inside an official frame, from its alpha channel."""
    if frame.shape[-1] != 4:
        return None
    ys, xs = np.nonzero(frame[..., 3] > 40)
    if len(xs) == 0:
        return None
    left, top = int(xs.min()), int(ys.min())
    width, height = int(xs.max()) - left + 1, int(ys.max()) - top + 1
    if abs(width - height) > max(2, 0.04 * width):
        return None  # not a square tile: not ours to draw
    return left, top, max(width, height), max(width, height)


def draw_frame(portrait: Portrait, official: np.ndarray, dark: bool) -> Image.Image | None:
    """A frame the size of the official one, with the Hermoso tile where the official tile is."""
    box = tile_box(official)
    if box is None:
        return None
    left, top, side, _ = box
    canvas = Image.new("RGBA", (official.shape[1], official.shape[0]), (0, 0, 0, 0))
    canvas.alpha_composite(render_tile(portrait, side, dark), (left, top))
    return canvas


# --- encoding ----------------------------------------------------------------------------------


def encode_png(image: Image.Image) -> bytes:
    info = PngImagePlugin.PngInfo()
    info.add_text("Software", SIGNATURE.decode())
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True, pnginfo=info)
    return buf.getvalue()


def encode_ico(frames: list[Image.Image]) -> bytes:
    """An .ico of PNG-compressed frames (what upstream's file uses for every size), each one signed."""
    blobs = [encode_png(f) for f in frames]
    out = io.BytesIO()
    out.write(struct.pack("<HHH", 0, 1, len(frames)))
    offset = 6 + 16 * len(frames)
    for frame, blob in zip(frames, blobs):
        w, h = frame.size
        out.write(struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(blob), offset))
        offset += len(blob)
    for blob in blobs:
        out.write(blob)
    return out.getvalue()


def draw_bytes(portrait: Portrait, rel: str, kind: str, original: bytes) -> tuple[bytes, str] | None:
    """The Hermoso version of one official file, and a one-line note; None when it is not a tile."""
    dark = is_dark(rel)

    if kind == "ico":
        official = [np.asarray(f) for f in recolor.read_ico_frames(original)]
        frames = [draw_frame(portrait, f, dark) for f in official]
        if any(f is None for f in frames):
            return None
        return encode_ico(frames), f"{len(frames)} frames ({', '.join(str(f.size[0]) for f in frames)})"  # type: ignore[union-attr]

    (arr,) = recolor.frames_of(kind, original)
    frame = draw_frame(portrait, arr if arr.shape[-1] == 4 else np.dstack([arr, np.full(arr.shape[:2], 255, np.uint8)]), dark)
    if frame is None:
        return None
    if kind == "jpeg":
        buf = io.BytesIO()
        frame.convert("RGB").save(buf, format="JPEG", quality=96, subsampling=0, comment=SIGNATURE)
        return buf.getvalue(), f"{frame.size[0]}x{frame.size[1]} RGB"
    return encode_png(frame), f"{frame.size[0]}x{frame.size[1]} RGBA"


# --- commands ----------------------------------------------------------------------------------


def make_source(args: argparse.Namespace, dest: Path) -> recolor.Source:
    return recolor.make_source(args, dest)


def cmd_list(args: argparse.Namespace) -> int:
    source = make_source(args, Path(args.dest).resolve())
    for rel, kind, data in recolor.discover(source):
        print(f"{kind}\t{rel}\t{len(data)}")
    return 0


def cmd_apply(args: argparse.Namespace) -> int:
    dest = Path(args.dest).resolve()
    source = make_source(args, dest)
    print(f"hermoso: the brother on the official tiles   from {source.describe()}   into {dest}")

    art = recolor.discover(source)
    if not art:
        print("  nothing to draw: no logo art found in the source (upstream changed its art?)")
        return 1

    portrait = Portrait()
    skipped = 0

    for rel, kind, original in art:
        try:
            drawn = draw_bytes(portrait, rel, kind, original)
        except Exception as error:  # noqa: BLE001 - one odd file must not stop the rest
            print(f"  FAILED {rel}: {error}")
            return 1

        if drawn is None:
            skipped += 1
            print(f"  skipped {rel}: not a square tile, left as it is (check will say so)")
            continue

        result, note = drawn
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(result)
        print(f"  drew {rel}: {kind}, {note}, {len(original):,} -> {len(result):,} bytes")

    return 1 if skipped else 0


def cmd_check(args: argparse.Namespace) -> int:
    """Fails when official logo art (no Hermoso signature) sits in --dest."""
    dest = Path(args.dest).resolve()
    source = recolor.Source(dest, None, repo=dest)
    found = recolor.discover(source)
    left = [rel for rel, _kind, data in found if SIGNATURE not in data]

    for rel in left:
        print(f"  OFFICIAL  {rel}: this is still the official art, not Hermoso's")

    if left:
        print(f"hermoso --check: FAILED ({len(left)} official logo file(s) left), run hermoso.py to draw them")
        return 1

    print(f"hermoso --check: ok ({len(found)} logo image(s), all of them Hermoso art)")
    return 0


def cmd_preview(args: argparse.Namespace) -> int:
    dest = Path(args.dest).resolve()
    source = make_source(args, dest)
    portrait = Portrait()
    cell, pad = 256, 16
    rows: list[tuple[str, Image.Image, Image.Image]] = []

    for rel, kind, original in recolor.discover(source):
        drawn = draw_bytes(portrait, rel, kind, original)
        if drawn is None:
            continue
        if kind == "ico":
            before, after = recolor.read_ico_frames(original), recolor.read_ico_frames(drawn[0])
            for fb, fa in list(zip(before, after))[-2:]:
                rows.append((rel, fb, fa))
        else:
            rows.append((rel, Image.open(io.BytesIO(original)), Image.open(io.BytesIO(drawn[0]))))

    def fit(im: Image.Image, size: int) -> Image.Image:
        im = im.convert("RGBA")
        scale = size / max(im.size)
        return im.resize((max(1, round(im.size[0] * scale)), max(1, round(im.size[1] * scale))), Image.Resampling.LANCZOS)

    dark, light = (40, 40, 44, 255), (236, 236, 238, 255)
    sheet = Image.new("RGBA", (pad + 4 * (cell + pad), pad + len(rows) * (cell + pad)), dark)
    y = pad
    for _label, before, after in rows:
        b, a = fit(before, cell), fit(after, cell)
        x = pad
        for im, bg in ((b, dark), (a, dark), (b, light), (a, light)):
            tile = Image.new("RGBA", (cell, cell), bg)
            tile.alpha_composite(im, ((cell - im.size[0]) // 2, (cell - im.size[1]) // 2))
            sheet.paste(tile, (x, y))
            x += cell + pad
        y += cell + pad

    out = Path(args.preview)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(out)
    print(f"preview: {out}  ({len(rows)} rows; columns: official/Hermoso on dark, official/Hermoso on light)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", help="pristine apps/desktop directory to read the originals from")
    parser.add_argument("--git-ref", help="read the originals from git instead (REF:apps/desktop/<path>)")
    parser.add_argument("--dest", default=str(DESKTOP), help="apps/desktop directory to write into (default: this checkout)")
    parser.add_argument("--list", action="store_true", help="print the logo images that would be drawn; change nothing")
    parser.add_argument("--check", action="store_true", help="verify every logo image in --dest is Hermoso art; change nothing")
    parser.add_argument("--preview", metavar="PNG", help="write a contact sheet; change nothing")
    args = parser.parse_args()

    if args.check:
        return cmd_check(args)
    if args.list:
        return cmd_list(args)
    if args.preview:
        return cmd_preview(args)
    return cmd_apply(args)


if __name__ == "__main__":
    sys.exit(main())
