#!/usr/bin/env python3
"""Generate tabBar PNG icons (81x81) without external deps: draw shapes with
signed-distance functions, supersample 3x for anti-aliasing, encode PNG via zlib."""
import math
import struct
import zlib

SIZE = 81
SS = 3  # supersampling factor

GRAY = (156, 163, 175)   # --text-tertiary
BLUE = (37, 99, 235)     # --primary


def circle(cx, cy, r):
    def sdf(x, y):
        return math.hypot(x - cx, y - cy) - r
    return sdf


def segment(x1, y1, x2, y2, r):
    def sdf(x, y):
        dx, dy = x2 - x1, y2 - y1
        t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
        return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) - r
    return sdf


def union(*shapes):
    def sdf(x, y):
        return min(s(x, y) for s in shapes)
    return sdf


def subtract(shape, cut):
    def sdf(x, y):
        return max(shape(x, y), -cut(x, y))
    return sdf


def search_icon(x, y):
    ring = subtract(circle(36, 36, 24), circle(36, 36, 16))
    handle = segment(54, 54, 66, 66, 5.5)
    return min(ring(x, y), handle(x, y))


def user_icon(x, y):
    head = circle(40.5, 28, 14)
    body = circle(40.5, 66, 24)
    # Flatten the shoulders below the head and keep a small bottom margin.
    shoulders = min(max(body(x, y), 60 - y), 77 - y)
    return min(head(x, y), shoulders)


def render(path, color, shape):
    r, g, b = color
    rows = bytearray()
    for py in range(SIZE):
        rows.append(0)  # PNG filter: none
        for px in range(SIZE):
            coverage = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    d = shape(x, y)
                    if d < 0:
                        coverage += 1
                    elif d < 1.0 / SS:
                        coverage += max(0.0, 1.0 - d * SS)
            alpha = min(255, int(255 * coverage / (SS * SS)))
            rows += bytes((r, g, b, alpha))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    ihdr = struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)
    payload = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
               + chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as handle:
        handle.write(payload)
    print(f'wrote {path} ({len(payload)} bytes)')


if __name__ == '__main__':
    import os
    out_dir = os.path.join(os.path.dirname(__file__), '..', 'assets')
    os.makedirs(out_dir, exist_ok=True)
    render(os.path.join(out_dir, 'tab-search.png'), GRAY, search_icon)
    render(os.path.join(out_dir, 'tab-search-active.png'), BLUE, search_icon)
    render(os.path.join(out_dir, 'tab-user.png'), GRAY, user_icon)
    render(os.path.join(out_dir, 'tab-user-active.png'), BLUE, user_icon)
