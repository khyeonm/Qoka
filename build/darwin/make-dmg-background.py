#!/usr/bin/env python3
"""Generate the macOS DMG "drag to Applications" background at BUILD TIME.

We deliberately do NOT commit a raster background to git. A binary TIFF/PNG blob
can be silently corrupted by git's text normalisation (this bit us once: a small
LZW TIFF had its CRLF bytes rewritten to LF and the image broke). Instead we keep
only this text script under version control and draw the image fresh on the build
machine with Pillow, which the dmgbuild venv already provides. Text can never be
corrupted by line-ending normalisation, so the background is guaranteed intact.

The image is a light-blue vertical gradient with a single clean arrow pointing from
the app icon towards the Applications folder, matching the DMG window layout in
dmg-settings.py.template (window content 480x320; app icon at (120,160),
Applications at (360,160)). A second, 2x page is appended so the background stays
crisp on Retina displays (the same multi-representation TIFF macOS expects).

Usage: python3 make-dmg-background.py <output.tiff>
"""

import sys

from PIL import Image, ImageDraw

# Content-region size (the DMG window is 480x352; the title bar takes the top 32px,
# so the background covers 480x320). Keep in sync with dmg-settings.py.template.
WIDTH, HEIGHT = 480, 320

# Light-blue gradient (top -> bottom), sampled from the original design.
TOP = (237, 244, 253)
BOTTOM = (217, 231, 251)

# Cornflower blue for the arrow (matches the previous hash-mark colour).
ARROW = (79, 134, 214, 255)


def _gradient(width: int, height: int) -> Image.Image:
    """Vertical TOP -> BOTTOM gradient at the given size."""
    img = Image.new('RGB', (width, height))
    px = img.load()
    for y in range(height):
        t = y / (height - 1)
        r = round(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
        g = round(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
        b = round(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
        for x in range(width):
            px[x, y] = (r, g, b)
    return img


def _render(scale: int) -> Image.Image:
    """Draw the gradient + arrow at `scale` (1 = 480x320, 2 = 960x640)."""
    w, h = WIDTH * scale, HEIGHT * scale
    img = _gradient(w, h).convert('RGBA')

    # Draw the arrow onto a transparent overlay so its edges anti-alias against the
    # gradient. Supersample 4x then downscale for smooth edges without a blur pass.
    ss = 4
    overlay = Image.new('RGBA', (w * ss, h * ss), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    # Arrow geometry, centred in the gap between the two icons (gap centre x=240,
    # icon centre y=160), expressed in 1x units then scaled up.
    cy = 160 * scale * ss
    shaft_h = 6 * scale * ss            # half-thickness of the shaft
    head_h = 20 * scale * ss            # half-height of the arrowhead
    x0 = 186 * scale * ss               # shaft start (left)
    head_base = 258 * scale * ss        # where the head begins
    tip = 294 * scale * ss              # arrow tip (right)

    points = [
        (x0, cy - shaft_h),
        (head_base, cy - shaft_h),
        (head_base, cy - head_h),
        (tip, cy),
        (head_base, cy + head_h),
        (head_base, cy + shaft_h),
        (x0, cy + shaft_h),
    ]
    draw.polygon(points, fill=ARROW)

    overlay = overlay.resize((w, h), Image.LANCZOS)
    img.alpha_composite(overlay)
    return img.convert('RGB')


def main(out_path: str) -> None:
    base = _render(1)
    retina = _render(2)
    # Multi-image TIFF: page 0 = 1x, page 1 = 2x. macOS reads both representations
    # and picks the right one per display, exactly like the original asset.
    base.save(out_path, format='TIFF', save_all=True, append_images=[retina], compression='tiff_lzw')
    print(f'Wrote DMG background: {out_path} ({base.size[0]}x{base.size[1]} + {retina.size[0]}x{retina.size[1]})')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('Usage: make-dmg-background.py <output.tiff>', file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1])
