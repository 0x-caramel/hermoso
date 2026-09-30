#!/usr/bin/env python3
"""Recolor the Hermes logo art of this fork: black -> a chosen colour (default #E100FF).

The official art is black-and-white line work (the Nous girl on a white tile, the NOUS
badge, the intro texture, the light/dark icon variants). Each pixel's luminance is mapped
onto a colour -> white ramp:

    black  -> the brand colour       (the hair, the outlines, the badge ground)
    white  -> white                  (the tile, the highlights)
    grey   -> the blend in between   (so anti-aliased edges stay smooth)

Alpha is never touched. The script always reads the PRISTINE official art and writes the
result over the fork's copy, so it is safe to run again after an official update replaced
the originals; it refuses to re-tint art that is already tinted (that would wash the colour
out a little more every time).

Which files? Not a fixed list: upstream reshuffles its art (the set changed within two
weeks: new dark variants, new file names, old ones deleted). Everything under assets/ and
public/ that is an image, is grey-scale and has real black in it is tinted; colourful art
(the pixel-art knight, sprites), photos and real macOS .icns containers are left alone. Every
run prints what it tinted.

    python recolor.py                      tint every logo image, reading the official runtime checkout
    python recolor.py --source DIR         read the originals from another apps/desktop directory
    python recolor.py --git-ref REF        read the originals from git (REF:apps/desktop/<path>)
    python recolor.py --color E100FF       another colour
    python recolor.py --list               print what would be tinted (changes nothing)
    python recolor.py --check              verify no black logo art is left in --dest (exit 1 if any)
    python recolor.py --preview FILE.png   write a before/after contact sheet (changes nothing)

Needs Pillow and numpy.
"""

from __future__ import annotations

import argparse
import io
import os
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

DEFAULT_COLOR = "E100FF"

HERE = Path(__file__).resolve().parent
DESKTOP = HERE.parent.parent  # .../apps/desktop

SCAN_ROOTS = ("assets", "public")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".ico", ".icns"}

# Logo art is small. Anything bigger is a photo or a background.
MAX_BYTES = 1_500_000

# Never tinted, whatever they look like.
EXCLUDE_FILES = {
    "public/hermes.png",
    "public/hermes-sprite.png",
}
EXCLUDE_DIRS = (
    "public/hermes-frames/",
    "public/ds-assets/",
)

# A file is logo art when it is grey-scale and at least this share of its visible pixels is black-ish.
MIN_DARK_SHARE = 0.03

# Luma weights (Rec. 601), applied to sRGB values as-is: the same space the art was drawn in,
# so the anti-aliasing ramp between black and white stays a straight ramp.
LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)


def parse_color(text: str) -> tuple[int, int, int]:
    text = text.lstrip("#")
    if len(text) != 6:
        raise SystemExit(f"colour must be 6 hex digits, got {text!r}")
    return tuple(int(text[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def default_source() -> Path:
    env = os.environ.get("HERMES_PRISTINE_DESKTOP")
    if env:
        return Path(env)
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "Hermes" / "hermes-agent" / "apps" / "desktop"
    return Path.home() / ".hermes" / "hermes-agent" / "apps" / "desktop"


class Source:
    """Where the pristine art comes from: a directory, or a git ref."""

    def __init__(self, directory: Path | None, git_ref: str | None, repo: Path):
        self.directory = directory
        self.git_ref = git_ref
        self.repo = repo

    def list(self) -> list[str]:
        """Image paths under the scan roots, relative to apps/desktop, sorted."""
        found: list[str] = []

        if self.git_ref:
            out = subprocess.run(
                ["git", "ls-tree", "-r", "--name-only", "--full-tree", self.git_ref, "--"]
                + [f"apps/desktop/{root}" for root in SCAN_ROOTS],
                cwd=self.repo,
                capture_output=True,
            )
            if out.returncode != 0:
                raise SystemExit(f"git ls-tree {self.git_ref}: {out.stderr.decode(errors='replace').strip()}")
            for line in out.stdout.decode("utf-8", errors="replace").splitlines():
                rel = line.strip().removeprefix("apps/desktop/")
                if Path(rel).suffix.lower() in IMAGE_EXTS:
                    found.append(rel)
        else:
            assert self.directory is not None
            for root in SCAN_ROOTS:
                base = self.directory / root
                if not base.is_dir():
                    continue
                for path in base.rglob("*"):
                    if path.is_file() and path.suffix.lower() in IMAGE_EXTS:
                        found.append(path.relative_to(self.directory).as_posix())

        return sorted(set(found))

    def read(self, rel: str) -> bytes:
        if self.git_ref:
            out = subprocess.run(
                ["git", "show", f"{self.git_ref}:apps/desktop/{rel}"],
                cwd=self.repo,
                capture_output=True,
            )
            if out.returncode != 0:
                raise FileNotFoundError(f"{self.git_ref}:apps/desktop/{rel}: {out.stderr.decode(errors='replace').strip()}")
            return out.stdout
        assert self.directory is not None
        return (self.directory / rel).read_bytes()

    def describe(self) -> str:
        return f"git {self.git_ref}" if self.git_ref else str(self.directory)


# --- pixel maths ---------------------------------------------------------------------


def tint(pixels: np.ndarray, color: tuple[int, int, int]) -> np.ndarray:
    """HxWx3 or HxWx4 uint8 -> same shape, black -> color, white -> white, alpha kept."""
    rgb = pixels[..., :3].astype(np.float32)
    t = np.clip(rgb @ LUMA / 255.0, 0.0, 1.0)[..., None]
    target = np.array(color, dtype=np.float32)
    out_rgb = target + (255.0 - target) * t
    out = pixels.copy()
    out[..., :3] = np.clip(np.rint(out_rgb), 0, 255).astype(np.uint8)
    return out


def _visible(pixels: np.ndarray) -> np.ndarray:
    if pixels.shape[-1] == 4:
        return pixels[..., 3] > 0
    return np.ones(pixels.shape[:2], dtype=bool)


def is_neutral(pixels: np.ndarray) -> bool:
    """True for grey-scale art (what upstream ships, incl. the very dark blue-grey dark variants).
    Tinted or colourful art is not."""
    visible = _visible(pixels)

    if not visible.any():
        return True

    rgb = pixels[..., :3].astype(np.int16)
    chroma = (rgb.max(axis=-1) - rgb.min(axis=-1))[visible]

    return float(chroma.mean()) < 12.0


def dark_share(pixels: np.ndarray) -> float:
    """Share of visible pixels that are black-ish (what --check wants at ~0 once tinted)."""
    visible = _visible(pixels)

    if not visible.any():
        return 0.0

    rgb = pixels[..., :3].astype(np.int16)
    dark = (rgb.max(axis=-1) <= 56) & ((rgb.max(axis=-1) - rgb.min(axis=-1)) <= 24)

    return float(dark[visible].mean())


# --- per-format codecs ----------------------------------------------------------------


def encode_png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def encode_jpeg(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    # 4:4:4 and a high quality: a saturated colour against white is exactly what 4:2:0
    # chroma subsampling smears at the edges.
    image.save(buf, format="JPEG", quality=96, subsampling=0, optimize=True)
    return buf.getvalue()


def read_ico_frames(data: bytes) -> list[Image.Image]:
    """Every frame of an .ico as RGBA, in directory order."""
    reserved, kind, count = struct.unpack_from("<HHH", data, 0)
    if kind != 1:
        raise ValueError("not an .ico file")
    ico = Image.open(io.BytesIO(data))
    sizes = set(ico.ico.sizes())  # type: ignore[attr-defined]
    order: list[tuple[int, int]] = []
    for i in range(count):
        w, h = struct.unpack_from("<BB", data, 6 + i * 16)
        order.append((w or 256, h or 256))
    return [ico.ico.getimage(size).convert("RGBA") for size in order if size in sizes]  # type: ignore[attr-defined]


def write_ico(frames: list[Image.Image]) -> bytes:
    """An .ico with PNG-compressed frames (what upstream's file uses for every size)."""
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


def classify(rel: str, data: bytes) -> str:
    """'png' | 'jpeg' | 'ico' | 'icns' by content (the official checkout used to ship a PNG named .icns)."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if data[:4] == b"icns":
        return "icns"
    if data[:4] == b"\x00\x00\x01\x00":
        return "ico"
    raise ValueError(f"{rel}: unrecognised image format")


def frames_of(kind: str, data: bytes) -> list[np.ndarray]:
    """Pixel arrays of every frame (one for png/jpeg)."""
    if kind == "ico":
        return [np.asarray(f) for f in read_ico_frames(data)]
    im = Image.open(io.BytesIO(data))
    has_alpha = "A" in im.getbands() or (im.mode == "P" and "transparency" in im.info)
    return [np.asarray(im.convert("RGBA" if has_alpha else "RGB"))]


def logo_art(rel: str, data: bytes) -> tuple[str, list[np.ndarray]] | None:
    """(kind, frames) when this file is grey-scale art with black in it, else None."""
    try:
        kind = classify(rel, data)
        if kind == "icns":
            return None  # a real macOS icon container: this fork is Windows-only, leave it be
        frames = frames_of(kind, data)
    except Exception:  # noqa: BLE001 - not an image we understand: not ours to touch
        return None

    if not frames or not all(is_neutral(f) for f in frames):
        return None
    if max(dark_share(f) for f in frames) < MIN_DARK_SHARE:
        return None

    return kind, frames


def excluded(rel: str) -> bool:
    return rel in EXCLUDE_FILES or rel.startswith(EXCLUDE_DIRS)


def discover(source: Source) -> list[tuple[str, str, bytes]]:
    """[(rel, kind, original bytes)] for every logo image the source ships."""
    found: list[tuple[str, str, bytes]] = []
    for rel in source.list():
        if excluded(rel):
            continue
        try:
            data = source.read(rel)
        except (FileNotFoundError, OSError):
            continue
        if len(data) > MAX_BYTES:
            continue
        art = logo_art(rel, data)
        if art is not None:
            found.append((rel, art[0], data))
    return found


def tint_bytes(kind: str, data: bytes, color: tuple[int, int, int]) -> tuple[bytes, str]:
    """Tinted file bytes and a one-line note."""
    if kind == "ico":
        frames = read_ico_frames(data)
        tinted = [Image.fromarray(tint(np.asarray(f), color)) for f in frames]
        return write_ico(tinted), f"{len(frames)} frames ({', '.join(str(f.size[0]) for f in frames)})"

    (arr,) = frames_of(kind, data)
    image = Image.fromarray(tint(arr, color))
    note = f"{arr.shape[1]}x{arr.shape[0]} {'RGBA' if arr.shape[-1] == 4 else 'RGB'}"

    return (encode_jpeg(image) if kind == "jpeg" else encode_png(image)), note


# --- commands ---------------------------------------------------------------------------


def make_source(args: argparse.Namespace, dest: Path) -> Source:
    if args.git_ref:
        return Source(None, args.git_ref, repo=DESKTOP)  # the objects live in THIS checkout's repo
    return Source(Path(args.source).resolve() if args.source else default_source(), None, repo=dest)


def cmd_list(args: argparse.Namespace) -> int:
    source = make_source(args, Path(args.dest).resolve())
    for rel, kind, data in discover(source):
        print(f"{kind}\t{rel}\t{len(data)}")
    return 0


def cmd_apply(args: argparse.Namespace) -> int:
    color = parse_color(args.color)
    dest = Path(args.dest).resolve()
    source = make_source(args, dest)

    print(f"recolor: black -> #{args.color.upper().lstrip('#')}   from {source.describe()}   into {dest}")

    art = discover(source)
    if not art:
        print("  nothing to tint: no grey-scale logo art found in the source (already tinted, or upstream changed its art)")
        return 1

    for rel, kind, original in art:
        try:
            result, note = tint_bytes(kind, original, color)
        except Exception as error:  # noqa: BLE001 - one odd file must not stop the rest
            print(f"  FAILED {rel}: {error}")
            return 1

        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(result)
        print(f"  tinted {rel}: {kind}, {note}, {len(original):,} -> {len(result):,} bytes")

    return 0


def cmd_check(args: argparse.Namespace) -> int:
    """Fails when logo art that is still black-and-white sits in --dest."""
    dest = Path(args.dest).resolve()
    source = Source(dest, None, repo=dest)
    left = discover(source)
    tinted = 0

    for rel in source.list():
        if excluded(rel) or (dest / rel).stat().st_size > MAX_BYTES:
            continue
        data = (dest / rel).read_bytes()
        try:
            kind = classify(rel, data)
            if kind == "icns":
                continue
            frames = frames_of(kind, data)
        except Exception:  # noqa: BLE001
            continue
        if frames and not all(is_neutral(f) for f in frames):
            tinted += 1

    for rel, kind, data in left:
        share = max(dark_share(f) for f in frames_of(kind, data))
        print(f"  BLACK   {rel}: {share:.1%} of the visible pixels are still black")

    if left:
        print(f"recolor --check: FAILED ({len(left)} black-and-white logo file(s) left), run recolor.py to regenerate the art")
        return 1

    print(f"recolor --check: ok ({tinted} tinted image(s), no black logo art left)")
    return 0


def cmd_preview(args: argparse.Namespace) -> int:
    color = parse_color(args.color)
    dest = Path(args.dest).resolve()
    source = make_source(args, dest)

    cell = 256
    pad = 16
    rows: list[tuple[str, Image.Image, Image.Image]] = []

    for rel, kind, original in discover(source):
        if rel.endswith(".icns"):
            continue
        result, _ = tint_bytes(kind, original, color)
        if kind == "ico":
            before_frames = read_ico_frames(original)
            after_frames = read_ico_frames(result)
            rows.append((rel + " (largest)", before_frames[-1], after_frames[-1]))
            for fb, fa in zip(before_frames[:4], after_frames[:4]):
                s = fb.size[0]
                k = max(1, 128 // s)
                rows.append((f"{rel} ({s}px)", fb.resize((s * k, s * k), Image.Resampling.NEAREST), fa.resize((s * k, s * k), Image.Resampling.NEAREST)))
        else:
            rows.append((rel, Image.open(io.BytesIO(original)), Image.open(io.BytesIO(result))))

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
    print(f"preview: {out}  ({len(rows)} rows; columns: before/after on dark, before/after on light)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--color", default=DEFAULT_COLOR, help="replacement for black, 6 hex digits (default E100FF)")
    parser.add_argument("--source", help="pristine apps/desktop directory to read the originals from")
    parser.add_argument("--git-ref", help="read the originals from git instead (REF:apps/desktop/<path>)")
    parser.add_argument("--dest", default=str(DESKTOP), help="apps/desktop directory to write into (default: this checkout)")
    parser.add_argument("--list", action="store_true", help="print the logo images that would be tinted; change nothing")
    parser.add_argument("--check", action="store_true", help="verify no black logo art is left in --dest; change nothing")
    parser.add_argument("--preview", metavar="PNG", help="write a before/after contact sheet; change nothing")
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
