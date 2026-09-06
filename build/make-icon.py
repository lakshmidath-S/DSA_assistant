"""Draws build/icon.png, the application icon.

Kept as a script rather than a binary someone has to trust: the icon is a
rounded square in the editor's own background colour with the Run triangle on
it, which is a shape this file can describe in less space than the PNG takes.
electron-builder derives the .ico and .icns from it.

Pure standard library on purpose. Pillow is not a dependency of this project
and adding one for a single 512-pixel square would be a poor trade.

Usage:  python build/make-icon.py
"""

import struct
import zlib
from pathlib import Path

SIZE = 512
SUPERSAMPLE = 4          # rendered at 4x and averaged down, for smooth edges
RADIUS = 0.22            # corner radius, as a fraction of the side

# renderer/styles.css: --bg and --accent.
BACKGROUND = (0x10, 0x10, 0x14)
ACCENT = (0x4A, 0xA8, 0xFF)


def inside_rounded_square(x, y, side, radius):
    """True when (x, y) is within a square with rounded corners."""
    # Fold into one corner: the square is symmetric, so only one needs testing.
    dx = abs(x - side / 2) - (side / 2 - radius)
    dy = abs(y - side / 2) - (side / 2 - radius)
    if dx <= 0 or dy <= 0:
        return max(dx, dy) <= 0 or (dx <= 0 and dy <= 0) or dx <= 0 or dy <= 0
    return dx * dx + dy * dy <= radius * radius


def inside_triangle(x, y, side):
    """The Run triangle: pointing right, centred, optically balanced."""
    # Optical centring - a triangle centred by its bounding box looks left-heavy.
    left = side * 0.36
    right = side * 0.72
    top = side * 0.26
    bottom = side * 0.74

    if not (left <= x <= right and top <= y <= bottom):
        return False

    # How far across the triangle we are, and how tall it is there.
    across = (x - left) / (right - left)
    half = (1 - across) * (bottom - top) / 2
    return abs(y - side / 2) <= half


def render():
    """One RGB row per line, supersampled and averaged."""
    big = SIZE * SUPERSAMPLE
    radius = big * RADIUS
    samples = SUPERSAMPLE * SUPERSAMPLE

    rows = []
    for y in range(SIZE):
        row = bytearray()
        for x in range(SIZE):
            r = g = b = a = 0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    px = x * SUPERSAMPLE + sx + 0.5
                    py = y * SUPERSAMPLE + sy + 0.5
                    if not inside_rounded_square(px, py, big, radius):
                        continue
                    a += 255
                    colour = ACCENT if inside_triangle(px, py, big) else BACKGROUND
                    r += colour[0]
                    g += colour[1]
                    b += colour[2]

            if a:
                # Averaged over the covered samples, so the colour stays true
                # at a partly covered edge instead of darkening towards black.
                covered = a // 255
                row += bytes((r // covered, g // covered, b // covered, a // samples))
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    return rows


def chunk(kind, payload):
    body = kind + payload
    return struct.pack('>I', len(payload)) + body + struct.pack('>I', zlib.crc32(body))


def write_png(path, rows):
    raw = b''.join(b'\x00' + row for row in rows)      # filter byte 0 per scanline
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    path.write_bytes(png)


if __name__ == '__main__':
    out = Path(__file__).resolve().parent / 'icon.png'
    write_png(out, render())
    print(f'wrote {out} ({out.stat().st_size} bytes, {SIZE}x{SIZE})')
