"""Consolidate & double-check stream formats across the whole catalog.

For every stream in every per-channel file:
  1. Re-probe with the improved tester (browser UA + larger probe window) so video
     tracks on picky CDNs are detected correctly (fixes false "Audio" labels) and the
     best HLS variant resolution is used for the quality label.
  2. Drop streams that are now dead (no longer resolve/probe).
  3. Re-label each stream as FHD/HD/SD/Audio from the fresh probe.
  4. Give every stream a UNIQUE, human-readable name "{QUALITY} · {provider/region}",
     so a channel with several feeds shows distinct, informative choices instead of
     three identical "HD" entries. Streams stay sorted tvpass-first.

Host:  uv run python -m harvester consolidate            # apply
       uv run python -m harvester consolidate --dry-run  # report only
"""
from __future__ import annotations

import asyncio
import glob
import json
import os
import re
import time
from urllib.parse import urlparse

from harvester.config import DEFAULT_TEST_CONCURRENCY, PROVIDER_PRIORITY, provider_rank
from harvester.models import ParsedStream, StreamStatus
from harvester.tester import test_stream, test_streams

# Hosts that throttle bursts (the prioritized providers, e.g. tvpass.org). Probing
# these concurrently causes false timeouts that would wrongly drop working streams,
# so they are probed SERIALLY with a delay.
_THROTTLE_HOSTS = list(PROVIDER_PRIORITY)
_THROTTLE_DELAY = 3.0

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STREAM_DIR = os.path.join(BASE, "stream", "tv")
CATALOG = os.path.join(BASE, "catalog", "tv", "all.json")


def _channel_name_map() -> dict:
    """channel id -> name, so labeling can strip the channel's own name from feed URLs."""
    try:
        metas = json.load(open(CATALOG, encoding="utf-8")).get("metas", [])
        return {c["id"]: c.get("name", "") for c in metas}
    except Exception:
        return {}


def _id_of(path: str) -> str:
    return os.path.basename(path)[:-5]  # strip ".json"

# ---------------------------------------------------------------------------
# Dynamic stream labeling
# ---------------------------------------------------------------------------
# Two independent signals, both derived generically from the URL (no per-channel
# hardcoding):
#   • REGION / feed-variant  -> goes in the big `name` (what you're watching)
#   • PROVIDER (delivery pipe)-> goes in the small `description` (who supplies it)
# So a generic feed reads "HD" / "TVPass", and a regional feed reads "Denver (HD)" /
# "CBS News" — never "TVPass" as the title, because the channel is what's watched,
# TVPass is only the supplier (and several feeds may come from the same supplier).

def quality_label(res: str, video: str) -> str:
    """FHD/HD/SD from resolution; Audio only when there is genuinely no video track."""
    if res and "x" in res:
        w = int(res.split("x")[0] or 0)
        if w >= 1920:
            return "FHD"
        if w >= 1280:
            return "HD"
        return "SD"
    return "SD" if video else "Audio"


# Full, unambiguous region words (substring-matched after the channel name is removed).
_REGION_WORDS = [
    (r"castle\s*rock|castlerock", "Castle Rock"), (r"denver|colorado", "Denver"),
    (r"national|nationwide|nationalfeed", "National"), (r"mountain", "Mountain"),
    (r"pacific", "Pacific"), (r"central", "Central"), (r"eastern|east", "East"),
    (r"western|west", "West"),
    (r"boston", "Boston"), (r"chicago", "Chicago"), (r"miami", "Miami"),
    (r"sacramento", "Sacramento"), (r"dallas", "Dallas"), (r"detroit", "Detroit"),
    (r"atlanta", "Atlanta"), (r"pittsburgh", "Pittsburgh"), (r"seattle", "Seattle"),
    (r"houston", "Houston"), (r"phoenix", "Phoenix"), (r"baltimore", "Baltimore"),
    (r"philadelphia", "Philadelphia"), (r"minneapolis|minnesota", "Minnesota"),
]
# Metro short-codes, matched ONLY with separators (e.g. "cbsn-den") to avoid substrings.
_METRO_CODE = {
    "den": "Denver", "bos": "Boston", "chi": "Chicago", "lax": "LA", "dal": "Dallas",
    "det": "Detroit", "atl": "Atlanta", "mia": "Miami", "sac": "Sacramento",
    "phi": "Philadelphia", "pit": "Pittsburgh", "sea": "Seattle", "hou": "Houston",
    "phx": "Phoenix", "nyc": "New York",
}
# Small display-polish map for provider names; ANY unknown domain falls back to a
# title-cased label, so new providers work with no edits.
_PROVIDER_PRETTY = {
    "tvpass": "TVPass", "cbsnews": "CBS News", "nbcuni": "NBC", "nbcsports": "NBC Sports",
    "amagi": "Amagi", "tubi": "Tubi", "uplynk": "Uplynk", "bloomberg": "Bloomberg",
    "akamaized": "Akamai", "cloudfront": "CloudFront", "pluto": "Pluto", "xumo": "Xumo",
    "amagitv": "Amagi", "lura": "Lura", "streamhoster": "StreamHoster", "wurl": "Wurl",
}


def _channel_tokens(channel_name: str) -> set:
    return {t for t in re.findall(r"[a-z0-9]+", (channel_name or "").lower()) if len(t) >= 3}


def detect_region(url: str, channel_name: str = "") -> str:
    """Region / feed-variant for a stream, or '' if generic. Derived from the URL with
    the channel's OWN name removed first, so e.g. 'SportsNetNewYork' does not falsely
    read as a 'New York' regional feed."""
    host = (urlparse(url).hostname or "").lower()
    path = (urlparse(url).path or "").lower()
    blob = f"{host} {path}"
    for tok in _channel_tokens(channel_name):
        blob = blob.replace(tok, " ")
    # metro short-codes only with a separator boundary (cbsn-den, -bos.)
    m = re.search(r"[-_./](" + "|".join(_METRO_CODE) + r")(?=[-_./]|$)", blob)
    if m:
        return _METRO_CODE[m.group(1)]
    for pattern, label in _REGION_WORDS:
        if re.search(pattern, blob):
            return label
    return ""


def provider_name(url: str) -> str:
    """Supplier label for the small line, derived dynamically from the domain.
    Unknown domains -> title-cased second-level label (works for any new provider)."""
    host = (urlparse(url).hostname or "").lower().replace("www.", "")
    if not host or re.match(r"^\d+\.\d+\.\d+\.\d+$", host):
        return "Direct"
    labels = host.split(".")
    sld = labels[-2] if len(labels) >= 2 else labels[0]
    return _PROVIDER_PRETTY.get(sld, sld.capitalize())


def clean_domain(url: str) -> str:
    """Registrable-ish domain (cbsn-den...cbsnews.com -> cbsnews.com)."""
    host = (urlparse(url).hostname or "").lower().replace("www.", "")
    if re.match(r"^\d+\.\d+\.\d+\.\d+$", host):
        return host
    labels = host.split(".")
    return ".".join(labels[-2:]) if len(labels) >= 2 else host


def build_display(quality: str, url: str, channel_name: str = "") -> tuple[str, str]:
    """Canonical stream display: (name, description).
    name  = "{Channel}[ - {Region}] ({QUALITY})"  — the channel name is ALWAYS included
            (owner preference), the region is added only when a feed-variant is detected,
            and the provider is intentionally NOT in the name.
            e.g. "CBS (HD)", "CBS - Denver (Audio)", "Disney Channel - East (SD)".
    description = provider/supplier, spelled out (e.g. "TVPass", "CBS News").
    """
    region = detect_region(url, channel_name)
    ch = (channel_name or "").strip()
    if ch and region:
        name = f"{ch} - {region} ({quality})"
    elif ch:
        name = f"{ch} ({quality})"
    elif region:
        name = f"{region} ({quality})"
    else:
        name = quality
    return name, provider_name(url)


def _uniquify(names: list[str]) -> list[str]:
    """Ensure names are unique within a channel by appending #2, #3 ... to collisions."""
    seen: dict[str, int] = {}
    out = []
    for n in names:
        if n in seen:
            seen[n] += 1
            out.append(f"{n} #{seen[n]}")
        else:
            seen[n] = 1
            out.append(n)
    return out


def parse_quality(name: str) -> str:
    """Extract quality from a stream name. Handles new "Source (HD)" and legacy "HD · X"."""
    m = re.search(r"\(([^)]+)\)\s*$", name or "")
    if m and m.group(1).strip() in ("FHD", "HD", "SD", "Audio"):
        return m.group(1).strip()
    first = (name or "").split("·")[0].strip().split(" ")[0]
    return first if first in ("FHD", "HD", "SD", "Audio") else "SD"


def _relabel(stream: dict, res_by_url: dict, channel_name: str = "") -> dict:
    url = stream["url"]
    r = res_by_url.get(url)
    res = r.codecs.resolution if r else ""
    video = r.codecs.video if r else ""
    q = quality_label(res, video)
    name, desc = build_display(q, url, channel_name)
    out = dict(stream)
    out["name"] = name
    out["description"] = desc
    return out


async def _run(dry_run: bool, concurrency: int) -> dict:
    files = sorted(glob.glob(os.path.join(STREAM_DIR, "*.json")))
    # gather all unique URLs
    url_set = set()
    per_file = {}
    for f in files:
        streams = json.load(open(f, encoding="utf-8")).get("streams", [])
        per_file[f] = streams
        for s in streams:
            if s.get("url"):
                url_set.add(s["url"])

    def _is_throttle(u: str) -> bool:
        lu = u.lower()
        return any(h in lu for h in _THROTTLE_HOSTS)

    throttle_urls = [u for u in url_set if _is_throttle(u)]
    normal_urls = [u for u in url_set if not _is_throttle(u)]
    print(f"re-probing {len(url_set)} unique streams "
          f"({len(normal_urls)} concurrent, {len(throttle_urls)} serial throttle-safe) ...")

    # Concurrent probe for normal hosts.
    results = await test_streams([ParsedStream(url=u) for u in normal_urls],
                                 timeout=12.0, concurrency=concurrency)
    res_by_url = {r.url: r for r in results}

    # Serial, spaced probe for throttle-sensitive hosts (tvpass) so they aren't
    # falsely timed out and dropped.
    for i, u in enumerate(throttle_urls):
        r = await test_stream(u, timeout=12.0)
        res_by_url[u] = r
        if i + 1 < len(throttle_urls):
            time.sleep(_THROTTLE_DELAY)

    # Retry any non-working normal stream once, serially — a single concurrent timeout
    # is not enough evidence to delete a stream.
    retry = [u for u in normal_urls if res_by_url.get(u) and res_by_url[u].status != StreamStatus.WORKING]
    for u in retry:
        r = await test_stream(u, timeout=12.0)
        if r.status == StreamStatus.WORKING:
            res_by_url[u] = r

    working = {u for u, r in res_by_url.items() if r and r.status == StreamStatus.WORKING}
    print(f"working: {len(working)} / {len(url_set)} "
          f"(throttle-safe hosts: {sum(1 for u in throttle_urls if u in working)}/{len(throttle_urls)})")

    from harvester.regional import order_streams
    names_by_id = _channel_name_map()
    stats = {"files_changed": 0, "streams_before": 0, "streams_after": 0,
             "dropped_dead": 0, "relabeled_audio_to_video": 0, "renamed": 0}
    for f, streams in per_file.items():
        cname = names_by_id.get(_id_of(f), "")
        stats["streams_before"] += len(streams)
        before = json.dumps({"streams": streams}, separators=(",", ":"))  # snapshot pre-mutation
        kept = [dict(s) for s in streams if s["url"] in working]  # copy so we compare honestly
        stats["dropped_dead"] += len(streams) - len(kept)
        for s in kept:
            old = s.get("name", "")
            new = _relabel(s, res_by_url, cname)
            if old == "Audio" and not new["name"].startswith("Audio"):
                stats["relabeled_audio_to_video"] += 1
            if new["name"] != old:
                stats["renamed"] += 1
            s.update(new)
        kept, _ = order_streams(kept)  # regional ordering + true-dup collapse
        stats["streams_after"] += len(kept)
        after = json.dumps({"streams": kept}, separators=(",", ":"))
        if after != before:
            stats["files_changed"] += 1
            if not dry_run:
                with open(f, "w", encoding="utf-8") as fh:
                    fh.write(after)
    return stats


def consolidate(dry_run: bool = False, concurrency: int = DEFAULT_TEST_CONCURRENCY) -> dict:
    return asyncio.run(_run(dry_run, concurrency))


def relabel(dry_run: bool = False) -> dict:
    """Reformat existing stream names into the detailed convention WITHOUT re-probing.
    Quality is taken from the current name; source/region is re-derived from the URL.
    Then re-order with the regional resolver. Fast and network-free."""
    from harvester.regional import order_streams
    names_by_id = _channel_name_map()
    stats = {"files_changed": 0, "streams_relabeled": 0}
    for f in sorted(glob.glob(os.path.join(STREAM_DIR, "*.json"))):
        data = json.load(open(f, encoding="utf-8"))
        streams = data.get("streams", [])
        if not streams:
            continue
        cname = names_by_id.get(_id_of(f), "")
        before = json.dumps({"streams": streams}, separators=(",", ":"))
        out = []
        for s in streams:
            q = parse_quality(s.get("name", ""))
            name, desc = build_display(q, s.get("url", ""), cname)
            ns = dict(s)
            ns["name"], ns["description"] = name, desc
            out.append(ns)
            stats["streams_relabeled"] += 1
        # Regional ordering + true-dup collapse. Same big names from different providers
        # are fine here — the provider in the small line disambiguates them.
        out, _ = order_streams(out)
        after = json.dumps({"streams": out}, separators=(",", ":"))
        if after != before:
            stats["files_changed"] += 1
            if not dry_run:
                with open(f, "w", encoding="utf-8") as fh:
                    fh.write(after)
    return stats
