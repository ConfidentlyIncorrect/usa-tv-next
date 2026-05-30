"""iptv-org US source — enrich existing catalog channels with reliable new streams.

The "Easy-Web-TV-M3u8" site (zhangboheng.github.io/Easy-Web-TV-M3u8) is just a front-end
over iptv-org's country playlists: its `tvplay.html?type=countries&key=us` fetches
`https://iptv-org.github.io/iptv/countries/us.m3u`. So the real source is iptv-org (which we
already use for logos). This module:

  * parses us.m3u (tvg-id, group-title, url); the channel id is the tvg-id BEFORE '@<feed>'
    (e.g. `CNN.us@East` -> `CNN.us`), and `group-title` is iptv-org's genre.
  * cross-references iptv-org channels.json for `categories` / `is_nsfw` / `closed` so the
    curation rules can be applied.
  * matches to our catalog by NORMALIZED NAME (our data has no tvg-id), with the regional
    suffix (" - Region") stripped.
  * ffprobe-validates each candidate stream (must be live with real video; frozen/ENDLIST
    and audio-only rejected) before adding.
  * adds reliable, URL-deduped new streams to the matching channel using our naming +
    behaviorHints (consolidate.build_display / build_behavior_hints).

Curation rules (mirrors the famelack rules):
  1. relevant to our selection   2. not religious / nsfw / biased / extreme
  3. not extremely niche/exotic  4. not a duplicate of what we have
New (unmatched) channels are CATEGORIZED and reported by these rules, not auto-added.

CLI:  uv run python -m harvester iptvorg-enrich [--apply] [--limit N]
      uv run python -m harvester iptvorg-candidates
"""
from __future__ import annotations

import asyncio
import json
import re
import unicodedata
import urllib.request
from collections import defaultdict
from pathlib import Path

from harvester import consolidate as C
from harvester import tester as T

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "catalog" / "tv" / "all.json"
GENRE_DIR = ROOT / "catalog" / "tv" / "all"
META_DIR = ROOT / "meta" / "tv"
STREAM_DIR = ROOT / "stream" / "tv"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
M3U_URL = "https://iptv-org.github.io/iptv/countries/us.m3u"
CHANNELS_URL = "https://iptv-org.github.io/api/channels.json"

# Rule 2/3: iptv-org genres + categories we never import.
BLOCK_GROUPS = {"religious", "legislative", "adult", "xxx"}
BLOCK_CATEGORIES = {"religious", "xxx", "adult", "legislative"}
# Rule 1: genres that are relevant to our catalog (used to gate NEW-channel candidates).
RELEVANT_GROUPS = {
    "general", "news", "sports", "entertainment", "movies", "series", "music", "kids",
    "documentary", "comedy", "classic", "lifestyle", "culture", "outdoor", "travel",
    "business", "cooking", "family", "weather", "animation", "auto", "science",
}

# Only trailing region/quality qualifiers are stripped (as a SECOND match attempt) — content
# words like "usa"/"network"/"tv" are NEVER dropped, or "USA Network" would collapse to ""
# and match unrelated channels (this bug matched it to MBN Iraq / Avang).
_SUFFIX_TOK = {"hd", "sd", "fhd", "uhd", "4k", "east", "west", "feed", "live", "dt", "dt1", "us", "usa"}


def _sa(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def norm(s: str, strip_suffix: bool = False) -> str:
    """Distinctive alnum key. famelack-style (no content-word dropping). `strip_suffix` drops a
    single trailing region/quality token so "Nosey US" can match iptv-org's "Nosey"."""
    s = _sa(s).lower().replace("&", " and ").replace("+", " plus ")
    toks = re.sub(r"[^a-z0-9 ]", " ", s).split()
    if strip_suffix and len(toks) > 1 and toks[-1] in _SUFFIX_TOK:
        toks = toks[:-1]
    return "".join(toks)


# iptv-org ids for local OTA stations (WLOS131.us, KDBCTV41.us, WHECTV101.us) carry the
# network name as an alt-name, so "ABC"/"CBS"/"NBC" wrongly match a local affiliate's
# (Stirr) news feed. Never enrich a national channel from a call-sign station.
_CALLSIGN = re.compile(r"^[WK][A-Z]{1,4}(TV|DT|HD)?\d", re.I)


def _is_callsign(cid: str) -> bool:
    return bool(_CALLSIGN.match(cid.split(".")[0]))


def _low_quality(url: str) -> bool:
    """Skip enrichment with sketchy/unreliable mirrors: cleartext HTTP or a raw-IP host
    (typically foreign/pirate re-streams), since iptv-org offers https CDN feeds too."""
    lo = url.lower()
    host = re.sub(r"^https?://", "", lo).split("/")[0].split(":")[0]
    return lo.startswith("http://") or bool(re.fullmatch(r"\d+\.\d+\.\d+\.\d+", host))


def _get(url: str) -> bytes:
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=90).read()


def load_source():
    """Returns (by_cid, channels_by_id). by_cid: channel_id -> [{url, group}]."""
    m = _get(M3U_URL).decode("utf-8", "ignore").splitlines()
    by_cid: dict[str, list] = defaultdict(list)
    for i, ln in enumerate(m):
        if not ln.startswith("#EXTINF"):
            continue
        tvg = re.search(r'tvg-id="([^"]*)"', ln)
        gt = re.search(r'group-title="([^"]*)"', ln)
        url = next((x.strip() for x in m[i + 1:] if x.strip() and not x.startswith("#")), "")
        cid = (tvg.group(1) if tvg else "").split("@")[0]
        if url and cid and ".m3u8" in url.lower():
            by_cid[cid].append({"url": url, "group": (gt.group(1) if gt else "")})
    channels = {c["id"]: c for c in json.loads(_get(CHANNELS_URL)) if c.get("country") == "US"}
    return by_cid, channels


def _blocked(ch: dict, group: str) -> str | None:
    """Reason a channel/stream is excluded by the rules, or None."""
    if ch.get("is_nsfw"):
        return "nsfw"
    if ch.get("closed"):
        return "closed"
    cats = set(ch.get("categories") or [])
    if cats & BLOCK_CATEGORIES:
        return "category:" + ",".join(cats & BLOCK_CATEGORIES)
    groups = {g.strip().lower() for g in group.split(";") if g.strip()}
    if groups & BLOCK_GROUPS:
        return "group:" + ",".join(groups & BLOCK_GROUPS)
    return None


def _catalog():
    cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    by_norm = defaultdict(list)
    for c in cat["metas"]:
        base = c["name"].split(" - ")[0]
        for k in {norm(base), norm(base, strip_suffix=True)}:
            if len(k) >= 2:
                by_norm[k].append(c)
    return cat, by_norm


def _iptv_norm_index(channels: dict):
    idx = defaultdict(list)
    for c in channels.values():
        for nm in [c["name"]] + (c.get("alt_names") or []):
            for k in {norm(nm), norm(nm, strip_suffix=True)}:
                if len(k) >= 2:
                    idx[k].append(c["id"])
    return idx


def _streams(cid: str) -> list:
    p = STREAM_DIR / f"{cid}.json"
    return json.loads(p.read_text(encoding="utf-8")).get("streams", []) if p.exists() else []


def _base(u: str) -> str:
    return re.sub(r"\?.*", "", u or "")


def _combo(name: str) -> tuple[str, str]:
    """(region, quality) parsed from a stream's display name "{Ch}[ - {Region}] ({Q})", used
    to avoid adding a feed that is indistinguishable from one the channel already has."""
    q = C.parse_quality(name)
    m = re.match(r".+? - (.+?) \(", name)
    return (m.group(1) if m else "", q)


# --- validation --------------------------------------------------------------

async def _validate(url: str):
    """(ok, quality) — ok iff the stream is live with real video (frozen/audio-only fail)."""
    from harvester.models import StreamStatus
    try:
        r = await T.test_stream(url, timeout=10.0)
    except Exception:
        return False, ""
    if r.status != StreamStatus.WORKING or not r.codecs.video:
        return False, ""
    q = C.quality_label(r.codecs.resolution, r.codecs.video)
    return (q != "Audio"), q


async def _validate_many(urls: list[str], concurrency: int = 6) -> dict:
    sem = asyncio.Semaphore(concurrency)
    out: dict[str, tuple] = {}
    async def one(u):
        async with sem:
            out[u] = await _validate(u)
    await asyncio.gather(*(one(u) for u in urls))
    return out


# --- enrich existing channels ------------------------------------------------

def enrich(apply: bool = False, limit: int | None = None) -> None:
    by_cid, channels = load_source()
    cat, by_norm = _catalog()
    from harvester import regional

    iptv_norm = _iptv_norm_index(channels)

    # Collect candidate (channel, url, group) deduped vs the channel's existing streams.
    plan = []          # (catalog_channel, url, group)
    seen_chan = set()
    for nrm, chans in by_norm.items():
        ids = iptv_norm.get(nrm, [])
        if not ids:
            continue
        # gather streams from all matching iptv ids, skipping blocked / low-quality ones
        cand = []
        for cid in ids:
            if _is_callsign(cid):
                continue
            ch = channels[cid]
            for s in by_cid.get(cid, []):
                if _blocked(ch, s["group"]) or _low_quality(s["url"]):
                    continue
                cand.append(s)
        for c in chans:
            if c["id"] in seen_chan:
                continue
            seen_chan.add(c["id"])
            have = {_base(s.get("url", "")) for s in _streams(c["id"])}
            seen = set()
            for s in cand:
                b = _base(s["url"])
                if b in have or b in seen:
                    continue
                seen.add(b)
                plan.append((c, s["url"], s["group"]))

    if limit:
        plan = plan[:limit]
    urls = [u for _, u, _ in plan]
    print(f"validating {len(urls)} candidate streams across "
          f"{len({c['id'] for c, _, _ in plan})} channels (ffprobe)...")
    results = asyncio.run(_validate_many(urls))

    # Only add a feed whose (region, quality) the channel doesn't already have — this is what
    # keeps the stream picker DISTINGUISHABLE (no five identical "CBS (FHD)" entries).
    have_combo = {c["id"]: {_combo(s.get("name", "")) for s in _streams(c["id"])}
                  for c in cat["metas"]}
    added = defaultdict(list)   # cid -> [stream dict]
    for c, url, group in plan:
        ok, q = results.get(url, (False, ""))
        if not ok:
            continue
        base = c["name"].split(" - ")[0]
        combo = (C.detect_region(url, base), q)
        if combo in have_combo[c["id"]]:
            continue
        have_combo[c["id"]].add(combo)
        name, desc = C.build_display(q, url, base)
        added[c["id"]].append({
            "url": url,
            "behaviorHints": C.build_behavior_hints(url),
            "name": name, "description": desc,
        })

    name_by_id = {c["id"]: c["name"] for c in cat["metas"]}
    total = sum(len(v) for v in added.values())
    print(f"\nreliable new streams: {total} across {len(added)} channels"
          + ("  (DRY RUN — pass --apply to write)" if not apply else ""))
    for cid, streams in sorted(added.items(), key=lambda kv: name_by_id.get(kv[0], "")):
        labels = [s["name"] for s in streams]
        print(f"  {name_by_id.get(cid, cid)[:30]:30} +{len(streams)}  {labels}")
        if apply:
            cur = _streams(cid)
            cur.extend(streams)
            ordered, _ = regional.order_streams(cur)
            (STREAM_DIR / f"{cid}.json").write_text(
                json.dumps({"streams": ordered}, separators=(",", ":")), encoding="utf-8")
    if apply and total:
        print(f"\nAPPLIED: wrote {len(added)} stream files (reordered).")


# --- categorize NEW-channel candidates (report only) -------------------------

def candidates() -> None:
    by_cid, channels = load_source()
    _, by_norm = _catalog()
    have_norms = set(by_norm.keys())

    keep = defaultdict(list)   # primary genre -> [(name, #streams)]
    dropped = defaultdict(int)
    for cid, streams in by_cid.items():
        ch = channels.get(cid)
        if not ch:
            dropped["no-metadata"] += 1
            continue
        if norm(ch["name"]) in have_norms:
            continue   # already in catalog (handled by enrich)
        group = streams[0]["group"] if streams else ""
        reason = _blocked(ch, group)
        if reason:
            dropped[reason.split(":")[0]] += 1
            continue
        groups = {g.strip().lower() for g in group.split(";") if g.strip()}
        if not (groups & RELEVANT_GROUPS):
            dropped["irrelevant/undefined-genre"] += 1
            continue
        primary = next((g for g in group.split(";")), "General")
        keep[primary].append((ch["name"], len(streams)))

    total = sum(len(v) for v in keep.values())
    print(f"=== NEW-channel candidates passing the rules: {total} ===")
    for genre, items in sorted(keep.items(), key=lambda kv: -len(kv[1])):
        print(f"\n[{genre}]  ({len(items)})")
        for name, n in sorted(items)[:40]:
            print(f"   {name[:40]:40} ({n} stream{'s' if n != 1 else ''})")
    print("\n=== excluded by rule (counts) ===")
    for r, n in sorted(dropped.items(), key=lambda kv: -kv[1]):
        print(f"   {n:5}  {r}")
