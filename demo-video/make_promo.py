# -*- coding: utf-8 -*-
"""Build the NEMO promo video: animated deck slides -> live demo -> closing.

Pipeline: each deck slide is looped into a short clip, given a slow Ken Burns
zoom, cross-faded into the next one, then concatenated with the full demo
footage and the closing slide. The demo audio is the only audio track.
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SLIDES = os.path.join(HERE, "slides4k")
DEMO = os.path.join(HERE, "recording", "demo edited.mp4")
FF = os.path.join(os.environ["APPDATA"], "Python", "Python314", "site-packages",
                  "imageio_ffmpeg", "binaries", "ffmpeg-win-x86_64-v7.1.exe")

PREVIEW = "--preview" in sys.argv
W, H = (960, 540) if PREVIEW else (3840, 2160)

FPS = 60
SLIDE_LEN = 3.0
XFADE = 0.6
JOIN = 0.6
CLOSING_LEN = 4.0
DEMO_LEN = 79.70
ZOOM_IN = 0.06
ZOOM_OUT = 0.035
INTRO_SLIDES = [f"Slide{i}.PNG" for i in range(1, 10)]
CLOSING = "Slide10.PNG"


def slide_chain(idx, name, length, zoom):
    """Loop a still image and add a slow zoom; keeps a constant 60 fps."""
    frames = int(length * FPS)
    return (
        f"[{idx}:v]scale={W}:{H}:in_range=full:out_range=tv,setsar=1,"
        f"zoompan=z='1.0+{zoom}*on/{frames - 1}':x='iw/2-(iw/zoom/2)':"
        f"y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={FPS},"
        f"trim=duration={length},setpts=PTS-STARTPTS,fps={FPS},"
        f"format=yuv420p[{name}]"
    )


def main():
    n = len(INTRO_SLIDES)
    total_intro = n * SLIDE_LEN - (n - 1) * XFADE
    demo_start = total_intro - JOIN
    closing_start = demo_start + DEMO_LEN - JOIN
    total = closing_start + CLOSING_LEN

    parts = []
    for i in range(n):
        parts.append(slide_chain(i, f"s{i}", SLIDE_LEN, ZOOM_IN))

    last = "s0"
    for k in range(1, n):
        out = f"x{k}"
        offset = k * (SLIDE_LEN - XFADE)
        parts.append(
            f"[{last}][s{k}]xfade=transition=fade:duration={XFADE}:"
            f"offset={offset:.3f}[{out}]"
        )
        last = out

    demo_idx = n
    parts.append(
        f"[{demo_idx}:v]scale={W}:{H}:force_original_aspect_ratio=increase:"
        f"in_range=full:out_range=tv:flags=lanczos,crop={W}:{H},setsar=1,"
        f"fps={FPS},format=yuv420p[demo]"
    )

    close_idx = n + 1
    parts.append(slide_chain(close_idx, "close0", CLOSING_LEN, ZOOM_OUT))
    parts.append("[close0]fade=t=in:st=0:d=0.7[close]")

    parts.append(
        f"[{last}][demo]xfade=transition=fadeblack:duration={JOIN}:"
        f"offset={demo_start:.3f}[withdemo]"
    )
    parts.append(
        f"[withdemo][close]xfade=transition=fadeblack:duration={JOIN}:"
        f"offset={closing_start:.3f}[vc]"
    )
    parts.append(f"[vc]fade=t=out:st={total - 0.9:.3f}:d=0.9[v]")

    delay = int(demo_start * 1000)
    parts.append(
        f"[{demo_idx}:a]afade=t=out:st={DEMO_LEN - 0.5}:d=0.5,"
        f"adelay={delay}|{delay},apad[a]"
    )

    graph = ";".join(parts)

    cmd = [FF, "-hide_banner", "-y", "-loglevel", "warning", "-stats"]
    for name in INTRO_SLIDES:
        cmd += ["-loop", "1", "-framerate", str(FPS), "-t", f"{SLIDE_LEN}",
                "-i", os.path.join(SLIDES, name)]
    cmd += ["-i", DEMO]
    cmd += ["-loop", "1", "-framerate", str(FPS), "-t", f"{CLOSING_LEN}",
            "-i", os.path.join(SLIDES, CLOSING)]
    cmd += ["-filter_complex", graph, "-map", "[v]", "-map", "[a]",
            "-t", f"{total:.2f}", "-r", str(FPS), "-color_range", "tv",
            "-c:v", "libx264", "-preset", "ultrafast" if PREVIEW else "fast",
            "-crf", "30" if PREVIEW else "19", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
    out = os.path.join(HERE, "_preview.mp4" if PREVIEW else "NEMO-promo.mp4")
    cmd.append(out)

    print(f"total {total:.2f}s  ({W}x{H})  ->  {out}")
    subprocess.run(cmd, check=True)
    print("ok")


if __name__ == "__main__":
    main()
