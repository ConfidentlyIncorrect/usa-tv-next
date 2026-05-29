"""Curated candidate selection for importing NEW famelack channels.

Category mapping alone is too coarse (religious/single-show/niche channels leak in
under Kids/Music/Entertainment). This layer applies the user's criteria on top:

  1. relevant to our selection  -> must map to one of our genres
  2. not religious/nsfw/biased/extreme -> keyword + category blocklist
  3. not extremely niche/exotic/odd     -> keyword blocklist + numbered-feed collapse
  4. not a duplicate of what we have     -> accent-folded name dedup vs catalog

It only proposes candidates (writes data/famelack_curated.json + prints a report).
Importing is a separate, reviewed step (famelack-import / a follow-up importer).
"""
from __future__ import annotations

import gzip
import json
import re
import unicodedata
import urllib.request
from collections import defaultdict
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
CATALOG = BASE / "catalog" / "tv" / "all.json"
GENRES_FILE = BASE / "data" / "famelack_us_genres.json"  # nanoid -> [categories]
RAW = "https://raw.githubusercontent.com/famelack/famelack-data/main/tv/compressed/countries/us.json"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

# famelack category -> our genre (None = exclude the category entirely)
CATEGORY_MAP = {
    "sports": "Sports", "news": "News", "top-news": "News", "business": "News",
    "weather": "News", "entertainment": "Entertainment", "comedy": "Entertainment",
    "series": "Entertainment", "show": "Entertainment", "classic": "Entertainment",
    "movies": "Entertainment", "kids": "Kids", "animation": "Kids", "family": "Kids",
    "documentary": "Documentaries", "science": "Documentaries", "culture": "Documentaries",
    "education": "Documentaries", "music": "Music", "lifestyle": "Lifestyle",
    "cooking": "Lifestyle", "travel": "Lifestyle", "outdoor": "Lifestyle",
    "auto": "Lifestyle", "relax": "Lifestyle",
    "religious": None, "legislative": None, "public": None, "shop": None, "general": None,
}

# Criterion 2 — religious / nsfw / biased / extreme (name substrings, lowercase).
BLOCK_RELIGIOUS = ["3abn", "abn ", "aghapy", "bible", "gospel", "faith", "church",
                   "jesus", "christ", "god ", "islam", "quran", "hindu", "catholic",
                   "ministr", "worship", "praise", "prophe", "kingdom", "salvation",
                   "daystar", "ewtn", "tbn", "inspiration", "shalom", "torah"]
BLOCK_NSFW = ["xxx", "adult", "playboy", "porn", "babes", "erotic", "18+"]
BLOCK_BIASED = ["oan", "newsmax", "rt ", "russia today", "infowars", "real america",
                "epoch", "ntd", "gb news", "press tv", "cgtn"]

# Criterion 3 — extremely niche / exotic / odd (name substrings).
BLOCK_NICHE = ["puppies", "aquarium", "fireplace", "fish tank", "webcam", "cam ",
               "test channel", "barker", "preview", "promo", "radio", "lottery",
               "weather radar", "traffic", "court", "scanner", "slow tv", "asmr",
               "yule log", "trivia", "horoscope"]

# Criterion 3 — single-show / clip channels (not a real network).
BLOCK_SINGLE_SHOW = ["48 hours", "afv", "always funny", "anger management",
                     "america's funniest", "unsolved", "cops", "wipeout",
                     "deal or no deal", "judge "]


def _fold(s: str) -> str:
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", _fold(s).lower())


def _fetch():
    req = urllib.request.Request(RAW, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        raw = r.read()
    try:
        raw = gzip.decompress(raw)
    except Exception:
        pass
    return json.loads(raw.decode("utf-8", "ignore"))


# Collapse numbered duplicate feeds: "ABC News Live 7" -> base "abc news live".
_NUM_SUFFIX = re.compile(r"\s+\d+$")


def _base_name(name: str) -> str:
    return _NUM_SUFFIX.sub("", name).strip()


def _blocked(name: str) -> str | None:
    low = " " + name.lower() + " "
    for grp, words in (("religious", BLOCK_RELIGIOUS), ("nsfw", BLOCK_NSFW),
                       ("biased", BLOCK_BIASED), ("niche", BLOCK_NICHE),
                       ("single-show", BLOCK_SINGLE_SHOW)):
        if any(w in low for w in words):
            return grp
    return None


def curate() -> dict:
    nano = json.loads(GENRES_FILE.read_text(encoding="utf-8"))
    ours = {_norm(c["name"]) for c in json.loads(CATALOG.read_text(encoding="utf-8"))["metas"]}
    us = _fetch()

    rejected = defaultdict(int)
    seen_base: set[str] = set()
    by_genre: dict[str, list[str]] = defaultdict(list)
    candidates = []

    for c in us:
        name = (c.get("name") or "").strip()
        if not name:
            continue
        if c.get("isGeoBlocked"):
            rejected["geoblocked"] += 1
            continue
        if not c.get("stream_urls"):
            rejected["no_stream"] += 1
            continue
        if _norm(name) in ours:
            rejected["duplicate_of_ours"] += 1
            continue
        cats = nano.get(c.get("nanoid"), [])
        mapped = sorted({CATEGORY_MAP.get(cat) for cat in cats if CATEGORY_MAP.get(cat)})
        if not mapped:
            rejected["no_relevant_genre"] += 1
            continue
        reason = _blocked(name)
        if reason:
            rejected[reason] += 1
            continue
        base = _norm(_base_name(name))
        if base in seen_base:
            rejected["numbered_duplicate"] += 1
            continue
        seen_base.add(base)
        genre = mapped[0]
        by_genre[genre].append(name)
        candidates.append({"name": name, "nanoid": c.get("nanoid"), "genre": genre,
                           "languages": c.get("languages", []),
                           "stream_urls": c.get("stream_urls", [])})

    out = BASE / "data" / "famelack_curated.json"
    out.write_text(json.dumps(candidates, indent=1), encoding="utf-8")
    return {"candidates": len(candidates), "by_genre": {g: len(v) for g, v in sorted(by_genre.items())},
            "rejected": dict(rejected), "examples": {g: v[:10] for g, v in sorted(by_genre.items())},
            "report": str(out)}
