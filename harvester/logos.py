"""Logo/banner grabber — sources channel art from the iptv-org open dataset.

Order of preference (per the project requirement):
  1. The repo already ships art for every current channel (public/logos/usa/,
     public/posters/usa/) — those are used as-is and never overwritten.
  2. famelack carries NO logo data (confirmed: its channel objects only have
     name/stream_urls/languages/country/isGeoBlocked), so it can't supply logos.
  3. iptv-org (which iptv-web.app and most IPTV apps draw from) publishes:
       https://iptv-org.github.io/api/channels.json  (id, name, alt_names, country)
       https://iptv-org.github.io/api/logos.json      (channel id -> logo url, in_use, dims)
     We match a channel NAME -> iptv-org id (name + alt_names, normalized), then pick
     the best logo (in_use first, then largest, prefer SVG/PNG) and download it.

So this is only needed for NEW channels imported later (e.g. from famelack's 1361).
Run on the host:  uv run python -m harvester logos            # fill channels missing a local logo
                  uv run python -m harvester logos --force     # re-download all
"""
from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
LOGO_DIR = BASE / "public" / "logos" / "usa"
CATALOG = BASE / "catalog" / "tv" / "all.json"
CHANNELS_URL = "https://iptv-org.github.io/api/channels.json"
LOGOS_URL = "https://iptv-org.github.io/api/logos.json"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
_FMT_RANK = {"SVG": 3, "PNG": 2, "WEBP": 1}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


_cache: dict = {}


def _load_index() -> dict:
    if _cache:
        return _cache
    channels = [c for c in _get_json(CHANNELS_URL) if c.get("country") == "US"]
    logos = _get_json(LOGOS_URL)

    best: dict[str, tuple] = {}  # channel id -> (score, url)
    for lg in logos:
        cid, url = lg.get("channel"), lg.get("url")
        if not cid or not url:
            continue
        score = (
            1 if lg.get("in_use") else 0,
            _FMT_RANK.get((lg.get("format") or "").upper(), 0),
            (lg.get("width") or 0) * (lg.get("height") or 0),
        )
        if cid not in best or score > best[cid][0]:
            best[cid] = (score, url)

    # Two passes so a channel's PRIMARY name always wins over another channel's
    # alt_name (prevents false matches like QVC -> a Fox alt_name).
    name_idx: dict[str, str] = {}
    for c in channels:
        n = _norm(c.get("name", ""))
        if n:
            name_idx.setdefault(n, c["id"])
    for c in channels:
        for nm in c.get("alt_names") or []:
            n = _norm(nm)
            if n:
                name_idx.setdefault(n, c["id"])

    _cache.update(logo_by_id={k: v[1] for k, v in best.items()}, name_idx=name_idx)
    return _cache


def resolve_logo(name: str) -> str | None:
    """Best iptv-org logo URL for a channel name, or None."""
    d = _load_index()
    cid = d["name_idx"].get(_norm(name))
    return d["logo_by_id"].get(cid) if cid else None


def grab_missing(force: bool = False) -> dict:
    """Download logos for catalog channels whose local logo file is absent."""
    cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    downloaded = missing = present = 0
    for ch in cat["metas"]:
        fname = (ch.get("logo") or "").rsplit("/", 1)[-1] or (_norm(ch["name"]) + ".png")
        dest = LOGO_DIR / fname
        if dest.exists() and not force:
            present += 1
            continue
        url = resolve_logo(ch["name"])
        if not url:
            missing += 1
            print(f"  no logo found: {ch['name']}")
            continue
        try:
            req = urllib.request.Request(url, headers={"User-Agent": _UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            dest.write_bytes(data)
            downloaded += 1
            print(f"  saved {ch['name']} -> {fname} ({len(data)} B)")
        except Exception as e:
            missing += 1
            print(f"  download failed {ch['name']}: {e}")
    return {"present": present, "downloaded": downloaded, "missing": missing}
