"""Banner/logo normalizer — give every channel a consistent, Nuvio-friendly poster.

Nuvio renders catalog cards from `poster` (Crop-scaled into the card) and overlays the
transparent `logo` only on the focused/expanded card. The original 157 channels ship a
clean 2:3 poster (logo centered on a solid neutral background) plus a separate transparent
logo. The famelack imports instead point BOTH poster and logo at a raw external icon
(often a wide, brightly-coloured wordmark on transparency) — which Crop-fills the card and
looks flashy / mis-sized next to the originals.

This module fixes that by, for each famelack channel:
  1. sourcing the best logo (iptv-org's clean transparent PNG first, else the channel's
     existing art URL),
  2. writing a normalized transparent logo to public/logos/usa/<slug>.png,
  3. compositing it (centered, padded) onto a solid background -> a 2:3 poster matching the
     originals' style at public/posters/usa/<slug>.png (dark #333 background, or a light
     plate when the logo is predominantly dark so it stays visible),
  4. repointing the catalog/meta/genre `poster`+`logo` at our OWN repo's raw URLs.

It also repoints the 157 originals' art from the old upstream owner (yowmamasita) to our
repo so the catalog is self-hosted and not dependent on a third-party fork.

Run:  uv run python -m harvester.banners            # generate + rewrite catalog
      uv run python -m harvester.banners --only "Cheddar News,Hi-YAH!"   # test a few
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from harvester import logos as iptv_logos

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "catalog" / "tv" / "all.json"
GENRE_DIR = ROOT / "catalog" / "tv" / "all"
META_DIR = ROOT / "meta" / "tv"
POSTERS = ROOT / "public" / "posters" / "usa"
LOGOS = ROOT / "public" / "logos" / "usa"

OWNER = "ConfidentlyIncorrect"
RAW = f"https://raw.githubusercontent.com/{OWNER}/usa-tv-next/main/public"
OLD_OWNER_PREFIX = "yowmamasita/usa-tv-next"
NEW_OWNER_PREFIX = f"{OWNER}/usa-tv-next"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# Poster geometry (matches the originals: 2:3 portrait, logo centered with generous padding).
PW, PH = 300, 450
DARK_BG = (51, 51, 51)        # #333 — the originals' neutral background
LIGHT_BG = (236, 236, 236)    # for predominantly-dark logos so they don't vanish
LOGO_BOX = (0.66, 0.42)       # max fraction of (width, height) the logo may occupy


def slugify(name: str) -> str:
    s = name.strip().lower().replace("&", " and ").replace("+", " plus ")
    s = re.sub(r"[''`]", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return f"{s}-us"


def _fetch(url: str) -> bytes | None:
    import time
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            return urllib.request.urlopen(req, timeout=20).read()
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:   # imgur rate-limit: back off and retry
                time.sleep(1.5 * (attempt + 1)); continue
            return None
        except Exception:
            return None
    return None


def _open_rgba(data: bytes) -> Image.Image | None:
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
        return im.convert("RGBA")
    except Exception:
        return None


def _trim(im: Image.Image) -> Image.Image:
    """Crop fully-transparent margins so the logo fills its box predictably."""
    alpha = im.getchannel("A")
    bbox = alpha.getbbox()
    return im.crop(bbox) if bbox else im


def _mean_luma(im: Image.Image) -> float:
    """Mean luminance of the opaque pixels (0=black..255=white); 128 if no opaque pixels."""
    small = im.resize((64, 64))
    px = small.load()
    tot = n = 0
    for y in range(64):
        for x in range(64):
            r, g, b, a = px[x, y]
            if a > 40:
                tot += 0.299 * r + 0.587 * g + 0.114 * b
                n += 1
    return tot / n if n else 128.0


def make_poster(logo: Image.Image) -> Image.Image:
    """Composite a transparent logo, centered+padded, onto a solid 2:3 background."""
    logo = _trim(logo)
    bg_color = LIGHT_BG if _mean_luma(logo) < 70 else DARK_BG
    canvas = Image.new("RGBA", (PW, PH), bg_color + (255,))
    box_w, box_h = int(PW * LOGO_BOX[0]), int(PH * LOGO_BOX[1])
    scale = min(box_w / logo.width, box_h / logo.height)
    new = (max(1, int(logo.width * scale)), max(1, int(logo.height * scale)))
    logo_r = logo.resize(new, Image.LANCZOS)
    pos = ((PW - new[0]) // 2, (PH - new[1]) // 2)
    canvas.alpha_composite(logo_r, pos)
    return canvas.convert("RGB")


def normalize_logo(logo: Image.Image, max_dim: int = 512) -> Image.Image:
    logo = _trim(logo)
    if max(logo.size) > max_dim:
        s = max_dim / max(logo.size)
        logo = logo.resize((int(logo.width * s), int(logo.height * s)), Image.LANCZOS)
    return logo


def make_text_poster(name: str) -> Image.Image:
    """Clean wordmark poster for channels with no usable logo — the channel name in tidy
    centered typography on the neutral background. Far better than a flashy/placeholder
    icon, and consistent with the originals' calm look."""
    canvas = Image.new("RGB", (PW, PH), DARK_BG)
    d = ImageDraw.Draw(canvas)
    font = ImageFont.load_default(size=34)
    maxw = PW * 0.82
    lines, cur = [], ""
    for word in name.split():
        t = (cur + " " + word).strip()
        if d.textlength(t, font=font) <= maxw or not cur:
            cur = t
        else:
            lines.append(cur); cur = word
    if cur:
        lines.append(cur)
    lh = 44
    y = (PH - lh * len(lines)) // 2
    for ln in lines:
        w = d.textlength(ln, font=font)
        d.text(((PW - w) // 2, y), ln, fill=(235, 235, 235), font=font)
        y += lh
    return canvas


# Researched logo URLs for channels iptv-org's name-matcher misses (well-known channels
# that would otherwise fall back to famelack's generic placeholder / a text wordmark).
# Sourced from iptv-org's raw dataset under alternate ids + official sites.
KNOWN_LOGOS = {
    "FIFA+ United States": "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9c/FIFA%2B_(2025).svg/960px-FIFA%2B_(2025).svg.png",
    "Go2Travel": "https://go2travel.tv/wp-content/uploads/2022/11/go2-logo.png",
    "HauntTV": "https://haunt-tv.com/wp-content/uploads/2022/09/haunt-tv-logo.png",
    "History Hit": "https://i.imgur.com/ulHoqlP.png",
    "Red Bull TV US": "https://jiotvimages.cdn.jio.com/dare_images/images/Red_Bull_TV.png",
    "Revry Queer": "https://i.imgur.com/XuTUaq4.png",
    "Curiosity NOW US": "https://i.imgur.com/KUb4vEz.png",
    # No reliable hotlinkable logo found for Go2Travel / World Channel / YTA TV /
    # Midnight Pulp / XITE Just Chill — these fall back to a clean text wordmark.
}

# iptv-org names omit our regional/quality qualifiers — try the base name too.
_SUFFIX = re.compile(r"\s+(US|USA|United States|East|West|HD|FHD|UHD)$", re.I)


def name_variants(name: str) -> list[str]:
    out = [name]
    base = _SUFFIX.sub("", name).strip()
    if base and base != name:
        out.append(base)
    return out


def _logo_from_url(url: str | None):
    """(Image, content-hash) for a usable logo URL, or None."""
    if not url or url.lower().endswith(".svg"):
        return None
    data = _fetch(url)
    if not data:
        return None
    im = _open_rgba(data)
    if im and im.width >= 24 and im.height >= 24:
        return im, hashlib.md5(data).hexdigest()
    return None


def source_logo(name: str, own_url: str):
    """Best (Image, content-hash). Curated override first, then iptv-org's clean logo (trying
    the base name with our US/East/etc. suffix stripped), then the channel's own famelack art.
    None if none yields a usable image. Placeholder rejection happens in run() via content-hash."""
    if name in KNOWN_LOGOS:
        r = _logo_from_url(KNOWN_LOGOS[name])
        if r:
            return r
    for v in name_variants(name):
        try:
            u = iptv_logos.resolve_logo(v)
        except Exception:
            u = None
        r = _logo_from_url(u)
        if r:
            return r
    return _logo_from_url(own_url)


# --- catalog rewrite ---------------------------------------------------------

def _load(p): return json.loads(Path(p).read_text(encoding="utf-8"))
def _dump(p, o): Path(p).write_text(json.dumps(o, separators=(",", ":")), encoding="utf-8")


def _repoint(url: str) -> str:
    return url.replace(OLD_OWNER_PREFIX, NEW_OWNER_PREFIX) if url else url


def _is_placeholder_hash(content_hash, hash_names):
    """A logo image shared by UNRELATED channels is a famelack generic placeholder (the
    flag+TV graphic, etc.) — reject it. "Unrelated" = >=2 channels whose names start with
    >=2 DISTINCT words. Brand-shared logos (the Vevo wordmark across Vevo '70s/'80s...,
    FilmRise across its sub-feeds) all share one base word, so they're kept."""
    names = hash_names.get(content_hash, [])
    first_words = {n.split()[0].lower() for n in names if n.split()}
    return len(names) >= 2 and len(first_words) >= 2


def run(only: set[str] | None = None) -> None:
    cat = _load(CATALOG)
    metas = cat["metas"]
    POSTERS.mkdir(parents=True, exist_ok=True)
    LOGOS.mkdir(parents=True, exist_ok=True)

    famelack = [c for c in metas
                if c.get("poster") == c.get("logo") and (c.get("poster") or "").strip()
                and (not only or c["name"] in only)]

    # Pass 1 — source the best logo image for each famelack channel.
    sourced: dict[str, tuple] = {}   # cid -> (name, image_or_None, content_hash_or_None)
    hash_names: dict[str, list] = {}
    for c in famelack:
        r = source_logo(c["name"], c.get("logo", ""))
        img, h = (r if r else (None, None))
        sourced[c["id"]] = (c["name"], img, h)
        if h:
            hash_names.setdefault(h, []).append(c["name"])

    # Pass 2 — generate: real logo poster, or a clean text poster (placeholder/no logo).
    new_art: dict[str, tuple[str, str]] = {}
    generated = textfallback = repointed = 0
    text_names: list[str] = []
    for cid, (name, img, h) in sourced.items():
        slug = slugify(name)
        if img is not None and not _is_placeholder_hash(h, hash_names):
            normalize_logo(img).save(LOGOS / f"{slug}.png")
            make_poster(img).save(POSTERS / f"{slug}.png")
            generated += 1
        else:
            tp = make_text_poster(name)
            tp.save(POSTERS / f"{slug}.png")
            tp.save(LOGOS / f"{slug}.png")
            textfallback += 1
            text_names.append(name)
        new_art[cid] = (f"{RAW}/posters/usa/{slug}.png", f"{RAW}/logos/usa/{slug}.png")

    # Self-host the originals (repoint old upstream owner -> our repo).
    for c in metas:
        cid = c["id"]
        if cid in new_art:
            continue
        np, nl = _repoint(c.get("poster", "")), _repoint(c.get("logo", ""))
        if (np, nl) != (c.get("poster"), c.get("logo")):
            new_art[cid] = (np, nl); repointed += 1

    if not new_art:
        print("nothing to change"); return

    # Apply to all.json, every genre slice, and each per-channel meta file.
    for c in metas:
        if c["id"] in new_art:
            c["poster"], c["logo"] = new_art[c["id"]]
    _dump(CATALOG, cat)

    for gf in GENRE_DIR.glob("genre=*.json"):
        g = _load(gf); touched = False
        for c in g["metas"]:
            if c["id"] in new_art:
                c["poster"], c["logo"] = new_art[c["id"]]; touched = True
        if touched:
            _dump(gf, g)

    for cid, (np, nl) in new_art.items():
        mp = META_DIR / f"{cid}.json"
        if mp.exists():
            m = _load(mp)
            m["meta"]["poster"], m["meta"]["logo"] = np, nl
            _dump(mp, m)

    print(f"\nDONE: {generated} logo posters, {textfallback} text posters, "
          f"{repointed} originals repointed to self-hosted URLs.")
    if text_names:
        print("TEXT-FALLBACK (no usable logo found — clean wordmark used):")
        for n in sorted(text_names):
            print("   -", n)


if __name__ == "__main__":
    only = None
    args = sys.argv[1:]
    if "--only" in args:
        only = set(a.strip() for a in args[args.index("--only") + 1].split(","))
    run(only)
