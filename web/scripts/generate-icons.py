#!/usr/bin/env python3
"""Regenerate the PWA icon set from the master icon-source.png.

Run from the web/ directory:  python3 scripts/generate-icons.py
Requires Pillow (pip install Pillow).

Source of truth: web/icon-source.png (2048x2048, opaque #0d1117 background).
The source frames the artwork with a wide margin; this script detects the
artwork's bounding box and reframes it so each output fills the right amount of
its icon. Outputs into web/public/icons/ (copied verbatim into dist/ by vite):

  icon-512 / icon-192 / apple-touch (180) / favicon-32   standard "any" icons —
      artwork reframed to fill the frame (ANY_FILL), so it reads at dock/taskbar
      size instead of floating small in the center.
  icon-maskable-512   Android maskable — artwork kept small enough (MASKABLE_FILL)
      that its corners stay inside the 40%-radius safe zone a launcher mask crops to.
"""
import pathlib
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "icon-source.png"
OUT = ROOT / "public" / "icons"
BG = (13, 17, 23, 255)  # #0d1117 — matches the source background

# Fraction of the frame the artwork spans.
#  - "any" icons want to fill the frame like a normal app icon (dock/taskbar/tab).
#  - maskable must keep the square artwork's corners within the 40%-radius safe
#    zone: corner radius = FILL/2 * sqrt(2) <= 0.40  =>  FILL <= 0.566.
ANY_FILL = 0.90
MASKABLE_FILL = 0.55


def content_bbox(im: Image.Image, thresh: int = 40) -> tuple[int, int, int, int]:
    """Bounding box of pixels that differ from the background by > `thresh`
    (summed channel distance) — i.e. the actual artwork, minus the dark margin."""
    px = im.load()
    w, h = im.size
    minx, miny, maxx, maxy = w, h, 0, 0
    for y in range(0, h, 4):
        for x in range(0, w, 4):
            r, g, b, _ = px[x, y]
            if abs(r - BG[0]) + abs(g - BG[1]) + abs(b - BG[2]) > thresh:
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)
    return minx, miny, maxx, maxy


def reframe(src: Image.Image, bbox: tuple[int, int, int, int], fill: float) -> Image.Image:
    """Square crop centered on the artwork such that the artwork spans `fill` of
    the crop. If the crop would overflow the source, it's re-centered to sit
    inside the bounds (shifted, not shrunk) so the artwork is never clipped —
    only shrinking below the requested size if the whole crop exceeds the image."""
    if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
        raise SystemExit(
            f"no artwork detected in {SRC.name} — is it blank or not on a "
            f"#{BG[0]:02x}{BG[1]:02x}{BG[2]:02x} background?"
        )
    minx, miny, maxx, maxy = bbox
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    w, h = src.size
    half = max(maxx - minx, maxy - miny) / fill / 2
    half = min(half, w / 2, h / 2)  # a square crop can't exceed the image
    cx = min(max(cx, half), w - half)  # shift the window inside the bounds
    cy = min(max(cy, half), h - half)
    return src.crop(
        (round(cx - half), round(cy - half), round(cx + half), round(cy + half))
    )


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    OUT.mkdir(parents=True, exist_ok=True)  # may be absent on a fresh checkout
    bbox = content_bbox(src)

    any_art = reframe(src, bbox, ANY_FILL)
    for name, size in [
        ("icon-512.png", 512),
        ("icon-192.png", 192),
        ("apple-touch-icon.png", 180),
        ("favicon-32.png", 32),
    ]:
        any_art.resize((size, size), Image.LANCZOS).save(OUT / name)

    reframe(src, bbox, MASKABLE_FILL).resize((512, 512), Image.LANCZOS).save(
        OUT / "icon-maskable-512.png"
    )
    print(f"wrote 5 icons to {OUT}")


if __name__ == "__main__":
    main()
