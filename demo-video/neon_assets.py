# -*- coding: utf-8 -*-
"""Generate neon 3D-ish art assets (spheres, rings, pills, glows) for the deck."""

import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "assets")
os.makedirs(OUT, exist_ok=True)


# ----------------------------------------------------------------- shapes ---
def sphere(d, core, edge, rim=(150, 190, 255), rim_str=0.65, spec=0.95,
           light=(-0.34, -0.40)):
    yy, xx = np.mgrid[0:d, 0:d]
    c = (d - 1) / 2.0
    r = d / 2.0
    nx = (xx - c) / r
    ny = (yy - c) / r
    dist = np.sqrt(nx ** 2 + ny ** 2)
    mask = np.clip((1.0 - dist) * r / 2.2, 0, 1)

    z = np.sqrt(np.clip(1 - nx ** 2 - ny ** 2, 0, 1))
    lx, ly = light
    lam = np.clip(nx * lx + ny * ly + z * 0.95, 0, 1)[..., None]
    base = np.array(edge, float) * (1 - lam) + np.array(core, float) * lam

    rimf = (np.clip((dist - 0.70) / 0.30, 0, 1) ** 2)[..., None]
    base = base * (1 - rimf * rim_str) + np.array(rim, float) * rimf * rim_str

    spec_d = np.sqrt((nx - lx) ** 2 + (ny - ly) ** 2)
    specf = (np.clip(1 - spec_d / 0.30, 0, 1) ** 2)[..., None]
    base = base * (1 - specf * spec) + 255 * specf * spec

    rgba = np.dstack([np.clip(base, 0, 255), mask * 255]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def glow(size, color, power=2.4):
    yy, xx = np.mgrid[0:size, 0:size]
    c = (size - 1) / 2.0
    d = np.sqrt((xx - c) ** 2 + (yy - c) ** 2) / c
    a = np.clip(1 - d, 0, 1) ** power
    arr = np.zeros((size, size, 4), np.uint8)
    arr[..., 0], arr[..., 1], arr[..., 2] = color
    arr[..., 3] = (a * 255).astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


def ring(w, h, thick, c1, c2, c3, angle_focus=(-0.35, -0.55)):
    """Tilted glossy torus approximation."""
    scale = 3
    W, H = w * scale, h * scale
    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    t = thick * scale
    md.ellipse([0, 0, W - 1, H - 1], outline=255, width=t)
    mask = mask.resize((w, h), Image.LANCZOS)

    # gradient body
    grad = np.zeros((h, w, 3), np.uint8)
    yy, xx = np.mgrid[0:h, 0:w]
    t_ = np.clip((xx / w * 0.65 + (1 - yy / h) * 0.35), 0, 1)
    for i in range(3):
        c_a, c_b = c1[i], c2[i]
        grad[..., i] = (c_a + (c_b - c_a) * t_).astype(np.uint8)
    body = Image.fromarray(grad, "RGB").convert("RGBA")

    # highlight sweep
    hl = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    lx, ly = angle_focus
    box = [w * 0.05, h * 0.02, w * 0.95, h * 0.98]
    hd.arc(box, start=150, end=330, fill=c3 + (190,), width=int(thick * 0.55))
    hl = hl.filter(ImageFilter.GaussianBlur(thick * 0.25))

    body.putalpha(mask)
    body = Image.alpha_composite(body, Image.composite(hl, Image.new("RGBA", (w, h), (0, 0, 0, 0)), mask))
    return body


def pill(w, h, c1, c2):
    s = 4
    W, H = w * s, h * s
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, H - 1], radius=H // 2, fill=255)
    mask = mask.resize((w, h), Image.LANCZOS)
    grad = np.zeros((h, w, 3), np.uint8)
    for i in range(3):
        g = np.linspace(c1[i], c2[i], w)
        grad[..., i] = np.tile(g, (h, 1)).astype(np.uint8)
    body = Image.fromarray(grad, "RGB").convert("RGBA")
    body.putalpha(mask)
    hl = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(hl).rounded_rectangle(
        [w * 0.08, h * 0.12, w * 0.92, h * 0.42], radius=h // 5, fill=(255, 255, 255, 90)
    )
    hl = hl.filter(ImageFilter.GaussianBlur(h * 0.12))
    body = Image.alpha_composite(body, Image.composite(hl, Image.new("RGBA", (w, h), (0, 0, 0, 0)), mask))
    return body


# -------------------------------------------------------------- compose ---
def paste(base, img, x, y, glow_color=None, glow_size=1.9, glow_alpha=120):
    if glow_color:
        g = glow(int(max(img.size) * glow_size),
                 glow_color).resize((int(img.size[0] * glow_size), int(img.size[1] * glow_size)),
                                    Image.LANCZOS)
        g.putalpha(g.getchannel("A").point(lambda v: int(v * glow_alpha / 255)))
        base.alpha_composite(g, (int(x - (g.size[0] - img.size[0]) / 2),
                                 int(y - (g.size[1] - img.size[1]) / 2)))
    base.alpha_composite(img, (int(x), int(y)))


def torus(w, h, thick, c1, c2, c3):
    """Ring with a faked bevel so it reads as a 3D torus in perspective."""
    main = ring(w, h, thick, c1, c2, c3)
    under = ring(w, h, thick, (30, 12, 60), (20, 8, 50), (60, 40, 110))
    under.putalpha(under.getchannel("A").point(lambda v: int(v * 0.55)))
    out = Image.new("RGBA", (w, h + 18), (0, 0, 0, 0))
    out.alpha_composite(under, (0, 16))
    out.alpha_composite(main, (0, 0))
    return out


def fade_edges(img, frac=0.12):
    w, h = img.size
    yy, xx = np.mgrid[0:h, 0:w]
    dx = np.minimum(xx, w - 1 - xx) / (w * frac)
    dy = np.minimum(yy, h - 1 - yy) / (h * frac)
    m = np.clip(np.minimum(dx, dy), 0, 1) ** 1.4
    a = np.array(img.getchannel("A"), float) * m
    img.putalpha(Image.fromarray(a.astype(np.uint8)))
    return img


def left_overlay():
    w, h = 1600, 900
    x = np.linspace(0, 1, w)[None, :].repeat(h, 0)
    a = np.clip((0.95 - x) / 0.95, 0, 1) ** 1.2
    arr = np.zeros((h, w, 4), np.uint8)
    arr[..., 3] = (a * 250).astype(np.uint8)
    Image.fromarray(arr, "RGBA").save(os.path.join(OUT, "overlay-left.png"))


def hero_cluster():
    S = 2600
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # back glow
    bg = glow(2200, (120, 60, 255), 2.0)
    bg.putalpha(bg.getchannel("A").point(lambda v: int(v * 0.55)))
    canvas.alpha_composite(bg, (180, 260))

    # big ring behind
    r1 = torus(1500, 980, 140, (108, 76, 255), (255, 46, 154), (210, 230, 255))
    r1 = r1.rotate(-16, expand=True, resample=Image.BICUBIC)
    paste(canvas, r1, 640, 560, (124, 60, 255), 1.15, 150)

    # chrome sphere (large, right)
    s1 = sphere(980, (235, 240, 255), (40, 30, 110), rim=(255, 120, 220), rim_str=0.55)
    paste(canvas, s1, 1250, 620, (90, 120, 255), 1.5, 130)

    # violet sphere (left)
    s2 = sphere(720, (190, 150, 255), (38, 16, 96), rim=(90, 200, 255))
    paste(canvas, s2, 560, 1050, (120, 60, 255), 1.6, 120)

    # magenta sphere (bottom)
    s3 = sphere(520, (255, 170, 220), (120, 10, 70), rim=(90, 200, 255))
    paste(canvas, s3, 1150, 1480, (255, 40, 140), 1.8, 130)

    # small blue
    s4 = sphere(330, (180, 230, 255), (10, 40, 130), rim=(255, 120, 220))
    paste(canvas, s4, 760, 640, (40, 120, 255), 2.0, 110)

    # small lime
    s5 = sphere(210, (240, 255, 200), (80, 140, 20), rim=(255, 255, 255))
    paste(canvas, s5, 1860, 470, (200, 255, 80), 2.2, 100)

    # pills
    p1 = pill(620, 170, (255, 60, 160), (120, 70, 255))
    p1 = p1.rotate(-28, expand=True, resample=Image.BICUBIC)
    paste(canvas, p1, 380, 380, (255, 60, 160), 1.5, 90)

    p2 = pill(500, 130, (80, 220, 255), (60, 90, 255))
    p2 = p2.rotate(38, expand=True, resample=Image.BICUBIC)
    paste(canvas, p2, 1500, 1560, (60, 200, 255), 1.6, 90)

    # tiny floating dots
    for (x, y, r, col) in [(2050, 900, 26, (255, 255, 255)), (420, 800, 18, (255, 220, 120)),
                           (1730, 300, 22, (140, 220, 255)), (980, 300, 14, (255, 150, 220))]:
        dot = sphere(r * 2, col, col, rim=(255, 255, 255))
        paste(canvas, dot, x, y, col, 3.0, 70)

    canvas = fade_edges(canvas, 0.10)
    canvas.save(os.path.join(OUT, "neon-hero.png"))
    print("hero", canvas.size)


def section_ring():
    S = 1800
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    g = glow(1500, (90, 60, 255), 2.2)
    g.putalpha(g.getchannel("A").point(lambda v: int(v * 0.45)))
    canvas.alpha_composite(g, (150, 150))

    r = torus(1300, 880, 110, (80, 200, 255), (255, 46, 154), (235, 245, 255))
    r = r.rotate(20, expand=True, resample=Image.BICUBIC)
    paste(canvas, r, 280, 340, (120, 60, 255), 1.2, 120)

    s = sphere(620, (220, 240, 255), (30, 30, 120), rim=(255, 120, 220))
    paste(canvas, s, 880, 800, (100, 140, 255), 1.7, 110)

    s2 = sphere(300, (255, 200, 235), (110, 10, 80), rim=(120, 220, 255))
    paste(canvas, s2, 480, 1180, (255, 60, 160), 2.0, 110)

    canvas = fade_edges(canvas, 0.10)
    canvas.save(os.path.join(OUT, "neon-ring.png"))
    print("ring", canvas.size)


def demo_frame():
    for name in ("demo-still-1.png", "demo-still-2.png"):
        src = os.path.join(OUT, name)
        img = Image.open(src).convert("RGB")
        w, h = img.size
        target = 16 / 9
        if w / h > target:
            nw = int(h * target)
            img = img.crop(((w - nw) // 2, 0, (w + nw) // 2, h))
        img.save(os.path.join(OUT, name.replace(".png", "-169.png")))


hero_cluster()
section_ring()
demo_frame()
left_overlay()
