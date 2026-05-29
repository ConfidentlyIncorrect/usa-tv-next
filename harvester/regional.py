"""Regional feed resolution — one logical channel, feeds ordered by local relevance.

Policy (per the addon owner, Denver/Castle Rock CO):
  • There is one catalog entry per channel; this module orders the STREAM FEEDS inside
    each channel so the most locally-relevant one leads:
        Denver/Castle Rock/Colorado  >  Mountain (timezone)  >  National/US  >
        generic (no region)  >  other named cities
  • Audio-only feeds are demoted below all video feeds (an audio-only regional feed
    should never outrank a watchable national video feed).
  • Existing provider priority (tvpass first) is preserved as a tiebreaker within the
    same region tier, so channels WITHOUT regional feeds keep their current order.
  • True DUPLICATES (same provider + region + quality) are collapsed to one; distinct
    regional feeds (e.g. CBSN Boston vs CBSN Denver) are kept as alternatives.

Used by `regionalize` (rewrites current stream files) and reused at import time.
"""
from __future__ import annotations

import glob
import json
import os
import re
from urllib.parse import urlparse

from harvester.config import provider_rank

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STREAM_DIR = os.path.join(BASE, "stream", "tv")

# Region detection from the stream's display name + URL.
_LOCAL = re.compile(r"\b(denver|castle\s*rock|colorado|\bco\b|cbsn[- ]?den)\b", re.I)
_MOUNTAIN = re.compile(r"\b(mountain|mtn)\b", re.I)
_NATIONAL = re.compile(r"\b(national|nat'?l|24/?7|nationwide|\bus\b|usa)\b", re.I)
_EAST = re.compile(r"\b(east|eastern)\b", re.I)
# A named US metro (other than Denver) -> a non-local regional feed.
_OTHER_CITY = re.compile(
    r"\b(boston|chicago|miami|sacramento|dallas|detroit|atlanta|new\s*york|nyc|"
    r"\bla\b|los\s*angeles|bay\s*area|philadelphia|pittsburgh|seattle|houston|"
    r"phoenix|baltimore|minnesota|minneapolis)\b", re.I)


def _region_segment(name: str) -> str:
    """Extract ONLY the explicit feed-variant from a display name of the form
    "{Channel}[ - {Region}] ({Quality})". Returns the region text or "".
    Reading just this segment (not the whole name) means a channel whose NAME contains
    a city (e.g. "SportsNet New York") is never mistaken for a regional feed."""
    base = re.sub(r"\s*\([^)]*\)\s*$", "", name or "")  # drop trailing "(Quality)"
    if " - " in base:
        return base.rsplit(" - ", 1)[1].strip()
    return ""


def region_rank(name: str) -> int:
    """0 = local (Denver/CO), 1 = Mountain, 2 = National, 3 = generic/none, 4 = other city.
    Operates on the explicit feed-variant segment only."""
    t = _region_segment(name)
    if not t:
        return 3
    if _LOCAL.search(t):
        return 0
    if _MOUNTAIN.search(t):
        return 1
    if _NATIONAL.search(t):
        return 2
    if _OTHER_CITY.search(t):
        return 4
    if _EAST.search(t):
        return 2  # East feed is the de-facto US national feed
    return 3


_QUALITY_ORDER = {"FHD": 0, "HD": 1, "SD": 2, "Audio": 3}


def _quality_of(name: str) -> str:
    # New convention "Source (HD)" -> HD; legacy "HD · Source" -> HD.
    m = re.search(r"\(([^)]+)\)\s*$", name or "")
    if m and m.group(1).strip() in ("FHD", "HD", "SD", "Audio"):
        return m.group(1).strip()
    return (name or "").strip().split(" ")[0].split("·")[0].strip() or "SD"


def _specific_region(name: str) -> str:
    """The exact region token (denver/boston/chicago/...) or 'generic' — used so DISTINCT
    regional feeds (Boston vs Chicago) are NOT treated as duplicates of each other.
    Reads only the explicit feed-variant segment, never the channel-name prefix."""
    seg = _region_segment(name)
    if not seg:
        return "generic"
    return re.sub(r"[^a-z0-9]", "", seg.lower())


def _domain(url: str) -> str:
    """Registrable domain of a URL, used as the provider identity for dedup so DISTINCT
    providers (amagi.tv vs google.com) are never collapsed — only same-source feeds are."""
    host = (urlparse(url).hostname or "").lower().replace("www.", "")
    if re.match(r"^\d+\.\d+\.\d+\.\d+$", host):
        return host
    labels = host.split(".")
    return ".".join(labels[-2:]) if len(labels) >= 2 else host


def reliability_rank(url: str) -> int:
    """0 = robust (clean HTTPS, standard host/port); 1 = fragile (HTTP, raw-IP host,
    non-standard port, CORS-proxy, or URL-shortener). Fragile streams infinite-buffer or
    get blocked far more often, so they sort BELOW robust ones — the player tries a good
    stream first, falling back to fragile only if nothing better exists."""
    p = urlparse(url or "")
    host = (p.hostname or "").lower()
    if (p.scheme == "http"
            or re.match(r"^\d+\.\d+\.\d+\.\d+$", host)
            or "proxy" in host or "jmp2" in host
            or (p.port and p.port not in (80, 443))):
        return 1
    return 0


def _dedup_key(stream: dict) -> tuple:
    """Identity for collapsing TRUE duplicates: provider DOMAIN + SPECIFIC region + quality.
    Region is read from the NAME (consolidate fills it there) — not the URL, whose slug may
    contain the channel's own city (e.g. SportsNetNewYork) and cause false matches.
    Domain (not provider_rank) is used so two different providers are not treated as dups."""
    name = stream.get("name", "")
    return (_domain(stream.get("url", "")), _specific_region(name), _quality_of(name))


def order_streams(streams: list[dict]) -> tuple[list[dict], int]:
    """Return (ordered+deduped streams, removed_duplicate_count)."""
    # 1. collapse exact duplicates (keep first occurrence)
    seen: set[tuple] = set()
    deduped: list[dict] = []
    for s in streams:
        k = _dedup_key(s)
        if k in seen:
            continue
        seen.add(k)
        deduped.append(s)
    removed = len(streams) - len(deduped)

    # 2. sort: video before audio, then local-region, then provider (tvpass), then quality.
    #    Region is read from the NAME only (consolidate puts the feed region there);
    #    the URL is avoided so a channel's own city in its slug can't skew ordering.
    def sort_key(s):
        name = s.get("name", "")
        url = s.get("url", "")
        q = _quality_of(name)
        is_audio = 1 if q == "Audio" else 0
        # video first, then RELIABLE before fragile (http/ip/proxy infinite-buffer), then
        # local region, then provider (tvpass), then quality. Reliability sits above region
        # so a robust national feed beats a fragile local one; clean-vs-clean still honors
        # the regional preference.
        return (is_audio, reliability_rank(url), region_rank(name),
                provider_rank(url), _QUALITY_ORDER.get(q, 2))

    deduped.sort(key=sort_key)
    return deduped, removed


def regionalize(dry_run: bool = False) -> dict:
    stats = {"files_changed": 0, "duplicates_removed": 0, "streams_before": 0, "streams_after": 0}
    for f in sorted(glob.glob(os.path.join(STREAM_DIR, "*.json"))):
        data = json.load(open(f, encoding="utf-8"))
        streams = data.get("streams", [])
        if not streams:
            continue
        stats["streams_before"] += len(streams)
        ordered, removed = order_streams(streams)
        stats["streams_after"] += len(ordered)
        stats["duplicates_removed"] += removed
        if ordered != streams:
            stats["files_changed"] += 1
            if not dry_run:
                with open(f, "w", encoding="utf-8") as fh:
                    json.dump({"streams": ordered}, fh, separators=(",", ":"))
    return stats
