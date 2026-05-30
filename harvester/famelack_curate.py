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
GENRES_FILE = BASE / "data" / "famelack_us_genres.json"  # cache of nanoid -> [categories]
RAW_BASE = "https://raw.githubusercontent.com/famelack/famelack-data/main/tv/compressed"
RAW = f"{RAW_BASE}/countries/us.json"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

# famelack's innate category files (its on-site genre section), joined to US channels.
_CATEGORY_FILES = ["animation", "auto", "business", "classic", "comedy", "cooking",
                   "culture", "documentary", "education", "entertainment", "family",
                   "kids", "legislative", "lifestyle", "movies", "music", "news",
                   "outdoor", "public", "relax", "religious", "science", "series",
                   "shop", "show", "sports", "top-news", "travel", "weather"]

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
                   "jesus", "christian", "islam", "quran", "hindu", "catholic",
                   "ministr", "worship", "prophe", "salvation",
                   "daystar", "ewtn", "tbn", "shalom", "torah"]  # 'christ' removed (Corpus Christi)
BLOCK_NSFW = ["xxx", "adult", "playboy", "porn", "babes", "erotic", "18+"]
BLOCK_BIASED = ["oan", "newsmax", "russia today", "infowars", "real america",
                "epoch", "ntd", "gb news", "press tv", "cgtn"]  # 'rt ' removed (Court TV)

# Criterion 3 — extremely niche / exotic / odd (name substrings).
BLOCK_NICHE = ["puppies", "aquarium", "fireplace", "fish tank", "webcam", "cam ",
               "test channel", "barker", "preview", "promo", "radio", "lottery",
               "weather radar", "traffic cam", "scanner", "slow tv", "asmr",
               "yule log", "trivia", "horoscope"]  # 'court' removed (Court TV is legit)

# Criterion 3 — single-show / clip channels (not a real network).
BLOCK_SINGLE_SHOW = ["48 hours", "afv", "always funny", "anger management",
                     "america's funniest", "unsolved", "cops", "wipeout",
                     "deal or no deal", "judge "]

# ----- Web-researched explicit removals (decided via live web research, not labels) ---
# name(lowercased) -> reason. These were individually researched.
RESEARCHED_REMOVE = {
    "america's voice": "biased: Real America's Voice, right-wing/pro-Trump network",
    "one america news network": "biased: OAN, far-right, low factual, conspiracy",
    "free speech tv": "biased: progressive advocacy network",
    "redseat the first": "biased: The First TV, conservative commentary (O'Reilly/Loesch)",
    "i24news english usa": "biased+foreign: Israeli, pro-government lean",
    "bek news": "biased/extreme: ND right-wing, carries Stew Peters",
    "bek tv sports west": "niche/operator: BEK (extreme ND operator), regional sports",
    "impact network": "religious: gospel/faith network",
    "dove channel": "religious: faith-based streaming (Cinedigm)",
    "positiv tv": "religious/niche: faith-family channel",
    "spirit tv": "religious",
    "jewish life television": "religious/ethnic niche",
    "logos tv kids": "religious (Logos)",
    "logos tv salud": "religious (Logos)",
    "roar": "niche/obscure: no verifiable presence",
    "right now tv": "niche/obscure",
    "camera smile tv": "niche/obscure: no verifiable presence",
    "wox tv": "niche/obscure",
    "dkn": "niche/obscure",
    "merit street": "defunct: bankrupt 2025, reruns only",  # optional; recognizable but declining
    "hmi promz news": "exotic: Haitian music promo company",
    "6 wise tv": "obscure/niche: no verifiable presence",
    "cafe trade tv": "obscure/niche",
    # iptv-org US pass (web-researched defunct / renamed):
    "newsy": "renamed: became Scripps News (Jan 2023) — stale brand",
    "top stories by newsy": "renamed: Newsy -> Scripps News",
    "newsnet": "defunct: ceased operations (owner shut it down)",
    "black news channel": "defunct: shut down 2022 (failed payroll)",
    "ameritrade": "renamed: TD Ameritrade Network -> Schwab Network (2023)",
}

# ----- User-reviewed decisions (per-bullet, from the borderline report) ---------------
USER_DECISIONS = {
    # (1) single-show / single-IP channels — handled separately; saved for future unblock
    **{n: "single-show (handled separately; saved for future unblock)" for n in [
        "duck dynasty", "fear factor us", "survivor", "degrassi us", "e! keeping up",
        "snl vault", "nbc comedy vault", "the carol burnett show", "johnny carson tv",
        "mystery science theater 3000", "wanted: dead or alive", "the asylum us",
        "baby shark tv", "naruto us", "tom and jerry", "yu-gi-oh!", "ryan and friends",
        "gordon ramsay's hell's kitchen", "mad dog and merrill", "chef roc show",
        "in the kitchen", "hungry"]},
    # (2) exceedingly-niche (pets/hobby) — outdoors content is kept, these are not
    **{n: "exceedingly-niche (pets/hobby; outdoors kept, this isn't)" for n in [
        "akc tv", "akc tv meet the breeds", "love pets us", "lucky dog", "choppertown"]},
    # (4) Latino: super-regional/localized — only well-known national Latino kept
    **{n: "latino super-regional/localized (not a national network)" for n in [
        "la mega mundial", "la que buena atlanta", "tropical music tv",
        "vallenato internacional", "latin zone", "california music channel"]},
    # (6) foreign feed of a known brand — removed; revisit later if needed
    **{n: "foreign feed of a known brand" for n in [
        "flowers tv usa", "history asia", "star channel international", "globalworldtv"]},
    # (7) defunct (web-confirmed)
    "black news channel": "defunct (confirmed: shut down 2022, merged into TheGrio)",
    # (3) regional duplicates — keep ONE per channel (national / Denver-Mountain feed)
    **{n: "regional duplicate (kept national CBS News 24/7 instead)" for n in [
        "cbs news baltimore", "cbs news boston", "cbs news miami", "cbs news sacramento"]},
    **{n: "regional duplicate (kept PBS Kids Mountain = Denver TZ instead)" for n in [
        "pbs kids alaska", "pbs kids eastern/central", "pbs kids hawaii", "pbs kids pacific"]},
    **{n: "hyper-local regional (no national/Denver feed)" for n in [
        "beach tv florida & alabama", "beach tv key west & florida keys",
        "beach tv myrtle beach & the grand strand", "beach tv panama city"]},
    # (8) obscure — removed for now, revisit later
    **{n: "obscure (revisit later)" for n in [
        "amp 2", "cvc education", "channel one", "the nest", "danger tv", "hollywire",
        "home.made.nation", "talkin live classics tv", "the archive", "turismo hd",
        "xplore tv", "tele boston", "telemix", "nowmedia television", "stryk tv",
        "sc currents", "weatherspy", "ftf sports", "rally tv", "swerve sports",
        "amg tv", "ketchup tv", "skwad play", "kidsflix", "camp spoopy"]},
}
RESEARCHED_REMOVE.update(USER_DECISIONS)

# Public-access / government / community-media operators (researched). These are PEG
# channels, not real networks. (Note: 'Create' and 'World Channel' are legit national
# PBS digital nets and are intentionally NOT here.)
PUBLIC_ACCESS = ["atxn", "bronxnet", "bx arts", "bx culture", "bx inform", "mcn6",
                 "cmac", "midpen", "olelo", "la36", "creatv", "derrytv", "leominster tv",
                 "natick", "nashua etv", "monroe community", "smctv", "red apple",
                 "kcat", "uctv", "tutv"]

# Structural patterns (criterion 3 — niche/exotic/odd, regional duplicates).
# Over-the-air call-sign stations: "WFTV 9.1", "KQED 9.2", "KMBY-LD 27.5", "W14DK-D 14.2"
_OTA_CALLSIGN = re.compile(r"^[KW][A-Z0-9]{2,4}(-[A-Z]{1,3})?\s+\d+\.\d+", re.I)
# Public-access / local-government channels ending in a channel number.
_LOCAL_ACCESS = re.compile(r"(channel\s*\d+|\b\d{2}\b$|\bLD\b|\bCD\b)", re.I)
# "TVS <something> Network" — one obscure operator flooding dozens of sub-channels.
_TVS_SPAM = re.compile(r"^TVS\b", re.I)

# Exotic/foreign (non-US-mainstream) keyword fragments — Spanish stays (Latino genre).
BLOCK_EXOTIC = ["avang", "omid e iran", "shabakeh", "iranefarda", "payvand",
                "pers", "telugu", "hmong", "k.movies", "k-content", "mbc america",
                "ebs musika", "ebs cinema", " tin tv", "high vision",
                "voa tv persian", "fidele"]


def _fold(s: str) -> str:
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()


# Common name<->acronym equivalences so e.g. "Fox Sports 1" is recognised as "FS1"
# (the plain normalized forms don't match). Applied to the dedup key.
_ALIAS = [
    (r"foxsports(\d)", r"fs\1"),       # Fox Sports 1/2 -> FS1/FS2
    (r"foxsports$", "fs1"),            # bare "Fox Sports" -> FS1
    (r"bigtennetwork", "btn"),
    (r"secnetwork", "secn"),
    (r"^espn(\d)", r"espn\1"),
]


def _norm(s: str) -> str:
    n = re.sub(r"[^a-z0-9]", "", _fold(s).lower())
    for pat, repl in _ALIAS:
        n = re.sub(pat, repl, n)
    return n


def _fetch():
    req = urllib.request.Request(RAW, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        raw = r.read()
    try:
        raw = gzip.decompress(raw)
    except Exception:
        pass
    return json.loads(raw.decode("utf-8", "ignore"))


# Collapse numbered MULTIPLEX feeds: "ABC News Live 7" -> base "abc news live".
# Only multi-word bases are treated as multiplex siblings; single-word "ESPN 2",
# "HBO 2", "Showtime 2" are DISTINCT brand channels and must NOT be collapsed.
_NUM_SUFFIX = re.compile(r"\s+\d+$")


def _base_name(name: str) -> str:
    return _NUM_SUFFIX.sub("", name).strip()


def _multiplex_base(name: str) -> str | None:
    """For a NUMBERED name, the number-stripped base IF multi-word (a real multiplex feed
    like 'ABC News Live 7'). None for single-word brands ('ESPN 2') so they survive, and
    None for names without a trailing number."""
    base = _NUM_SUFFIX.sub("", name).strip()
    if base != name and len(base.split()) >= 2:
        return _norm(base)
    return None


def _mw_base_key(name: str) -> str | None:
    """The multi-word base key of ANY name (numbered or not), for registering existing
    catalog channels so later-imported numbered siblings are recognised. e.g.
    'ABC News Live' and 'ABC News Live 1' both -> 'abcnewslive'; 'ESPN'/'ESPN 2' -> None."""
    base = _NUM_SUFFIX.sub("", name).strip()
    return _norm(base) if len(base.split()) >= 2 else None


def _blocked(name: str) -> str | None:
    low_raw = name.lower().strip()
    # 1. web-researched explicit decisions
    if low_raw in RESEARCHED_REMOVE:
        return f"researched: {RESEARCHED_REMOVE[low_raw]}"
    # 2. structural patterns
    if _OTA_CALLSIGN.match(name):
        return "ota-callsign (local broadcast subchannel)"
    if _TVS_SPAM.match(name):
        return "tvs-operator-spam"
    if _LOCAL_ACCESS.search(name):
        return "local-access/regional"
    if any(p in low_raw for p in PUBLIC_ACCESS):
        return "public-access/PEG operator"
    # 3. keyword groups
    low = " " + low_raw + " "
    for grp, words in (("religious", BLOCK_RELIGIOUS), ("nsfw", BLOCK_NSFW),
                       ("biased", BLOCK_BIASED), ("niche", BLOCK_NICHE),
                       ("single-show", BLOCK_SINGLE_SHOW), ("exotic-foreign", BLOCK_EXOTIC)):
        if any(w in low for w in words):
            return grp
    return None


def _fetch_path(path: str):
    req = urllib.request.Request(f"{RAW_BASE}/{path}", headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        raw = r.read()
    try:
        raw = gzip.decompress(raw)
    except Exception:
        pass
    return json.loads(raw.decode("utf-8", "ignore"))


def _build_genre_map() -> dict:
    """nanoid -> [categories] for US channels, built from famelack's category files.
    Self-contained (no gitignored cache needed); caches to data/ for reuse."""
    if GENRES_FILE.exists():
        try:
            return json.loads(GENRES_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    nano: dict[str, list] = {}
    for cat in _CATEGORY_FILES:
        try:
            for c in _fetch_path(f"categories/{cat}.json"):
                if c.get("country") == "us" and c.get("nanoid"):
                    nano.setdefault(c["nanoid"], [])
                    if cat not in nano[c["nanoid"]]:
                        nano[c["nanoid"]].append(cat)
        except Exception:
            continue
    try:
        GENRES_FILE.parent.mkdir(parents=True, exist_ok=True)
        GENRES_FILE.write_text(json.dumps(nano), encoding="utf-8")
    except Exception:
        pass
    return nano


def curate() -> dict:
    nano = _build_genre_map()
    our_metas = json.loads(CATALOG.read_text(encoding="utf-8"))["metas"]
    ours = {_norm(c["name"]) for c in our_metas}
    # multiplex bases already in the catalog (e.g. "abc news live" from "ABC News Live"),
    # so numbered siblings imported in a LATER run are still recognised as duplicates.
    ours_bases = {b for c in our_metas if (b := _mw_base_key(c["name"]))}
    us = _fetch()

    rejected = defaultdict(int)        # bucketed counts
    removed_detail: list[dict] = []    # full audit trail of content-criteria removals
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
            bucket = reason.split(":")[0].split(" ")[0]  # e.g. "researched", "ota-callsign"
            rejected[bucket] += 1
            removed_detail.append({"name": name, "reason": reason})
            continue
        mbase = _multiplex_base(name)  # multi-word numbered sibling, e.g. "abc news live"
        if mbase and (mbase in seen_base or mbase in ours_bases):
            rejected["numbered_duplicate"] += 1
            removed_detail.append({"name": name, "reason": "numbered-multiplex duplicate feed"})
            continue
        if mbase:
            seen_base.add(mbase)
        genre = mapped[0]
        by_genre[genre].append(name)
        candidates.append({"name": name, "nanoid": c.get("nanoid"), "genre": genre,
                           "languages": c.get("languages", []),
                           "stream_urls": c.get("stream_urls", [])})

    out = BASE / "data" / "famelack_curated.json"
    out.write_text(json.dumps(candidates, indent=1), encoding="utf-8")
    (BASE / "data" / "famelack_removed.json").write_text(
        json.dumps(sorted(removed_detail, key=lambda r: r["reason"]), indent=1), encoding="utf-8")
    return {"candidates": len(candidates), "by_genre": {g: len(v) for g, v in sorted(by_genre.items())},
            "rejected": dict(rejected), "examples": {g: v[:12] for g, v in sorted(by_genre.items())},
            "report": str(out)}
