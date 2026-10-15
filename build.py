#!/usr/bin/env python3
"""
Bundle the kotoSay pitch deck into ONE self-contained index.html.

    python build.py           build once
    python build.py --watch   rebuild whenever a file in src/ changes

Only the Python standard library is used. Nothing is fetched from the
network, so the deck works offline (handy on competition Wi-Fi).
"""
from __future__ import annotations

import base64
import json
import mimetypes
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
OUT = ROOT / "kotosay-pitch.html"

# Order matters: tokens → base → deck chrome → per-slide styles.
STYLES = ["tokens.css", "base.css", "deck.css", "slides.css"]
SCRIPTS = ["assets.js", "count.js", "spring.js", "deck.js"]   # assets.js first: it fills in shared videos


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


ASSET_ATTR = re.compile(r'\b(src|poster)="(assets/[^"]+)"')


def data_uri(rel: str) -> str:
    path = SRC / rel
    if not path.is_file():
        raise SystemExit(f"Missing asset: src/{rel}")
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{data}"


def inline_assets(html: str) -> tuple[str, dict[str, str]]:
    """Turn src="assets/..." and poster="assets/..." into data: URIs,
    so index.html stays one self-contained file (images and video included).

    A file used more than once (the demo videos on slides 3 and 14) is
    embedded only once: each use becomes data-asset-src / data-asset-poster,
    and assets.js fills it in from the returned {path: data URI} map."""
    uses: dict[str, int] = {}
    for match in ASSET_ATTR.finditer(html):
        uses[match.group(2)] = uses.get(match.group(2), 0) + 1
    shared = {rel: data_uri(rel) for rel, count in uses.items() if count > 1}

    def replace(match: re.Match) -> str:
        attr, rel = match.group(1), match.group(2)
        if rel in shared:
            return f'data-asset-{attr}="{rel}"'
        return f'{attr}="{data_uri(rel)}"'

    return ASSET_ATTR.sub(replace, html), shared


def build() -> None:
    template = read(SRC / "template.html")

    css = "\n".join(read(SRC / "styles" / name).rstrip() for name in STYLES)

    slide_files = sorted((SRC / "slides").glob("*.html"))   # 01-…, 02-…, deck order
    if not slide_files:
        raise SystemExit("No slides found in src/slides/")
    slides, shared = inline_assets("\n\n".join(read(f).strip() for f in slide_files))

    js = "\n".join(read(SRC / "scripts" / name).rstrip() for name in SCRIPTS)
    if "</script" in js.lower():
        raise SystemExit("A script contains '</script' which would break inlining.")
    js = f"window.DECK_ASSETS = {json.dumps(shared)};\n{js}"   # base64 is script-safe

    html = (
        template.replace("/*@STYLES@*/", css)
        .replace("<!--@SLIDES@-->", slides)
        .replace("/*@SCRIPTS@*/", js)
    )
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:  # same output on Windows and macOS
        f.write(html)
    size_kb = OUT.stat().st_size / 1024
    print(f"Built {OUT.name}: {len(slide_files)} slides, {size_kb:.0f} KB")


def snapshot() -> dict[Path, float]:
    return {p: p.stat().st_mtime for p in SRC.rglob("*") if p.is_file()}


def watch() -> None:
    print("Watching src/ for changes. Press Ctrl+C to stop.")
    before = snapshot()
    build()
    try:
        while True:
            time.sleep(0.4)
            now = snapshot()
            if now != before:
                before = now
                try:
                    build()
                except Exception as exc:  # keep watching after a bad save
                    print(f"Build failed: {exc}")
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    watch() if "--watch" in sys.argv[1:] else build()
