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

# US metro abbreviations seen in CBSN / regional feed slugs.
_METRO = {
    "bos": "Boston", "chi": "Chicago", "la": "LA", "lax": "LA", "den": "Denver",
    "dal": "Dallas", "det": "Detroit", "nyc": "New York", "ny": "New York",
    "sf": "Bay Area", "bay": "Bay Area", "phi": "Philadelphia", "min": "Minnesota",
    "mia": "Miami", "atl": "Atlanta", "pit": "Pittsburgh", "sac": "Sacramento",
    "balt": "Baltimore", "col": "Colorado",
}


def quality_label(res: str, video: str) -> str:
    """FHD/HD/SD from resolution; Audio only when there is genuinely no video track."""
    if res and "x" in res:
        w = int(res.split("x")[0] or 0)
        if w >= 1920:
            return "FHD"
        if w >= 1280:
            return "HD"
        if w >= 640:
            return "SD"
        return "SD"
    return "SD" if video else "Audio"


def provider_label(url: str) -> str:
    """Short, human provider/region label derived from the stream URL."""
    host = (urlparse(url).hostname or "").lower()
    path = urlparse(url).path.lower()
    if "tvpass.org" in host:
        return "tvpass"
    if re.match(r"^\d+\.\d+\.\d+\.\d+$", host):
        return "Direct"
    # CBSN regional: cbsn-chi / cbsn-bos ...
    m = re.search(r"cbsn-(\w+)", host) or re.search(r"cbsn-(\w+)", path)
    if m:
        return f"CBSN {_METRO.get(m.group(1), m.group(1).upper())}"
    if "amagi.tv" in host:
        return "Amagi"
    if "tubi" in host:
        return "Tubi"
    if "dai.google" in host:
        return "Google"
    if "uplynk" in host:
        return "Uplynk"
    if "bloomberg" in host:
        return "Bloomberg"
    if "akamaized" in host or "akamai" in host:
        return "Akamai"
    if "cloudfront" in host:
        return "CloudFront"
    if "nbcuni" in host or "nbcu" in host:
        return "NBCU"
    # generic: second-level domain
    parts = host.replace("www.", "").split(".")
    return parts[0][:10].capitalize() if parts and parts[0] else "Live"


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


def _relabel(stream: dict, res_by_url: dict) -> dict:
    url = stream["url"]
    r = res_by_url.get(url)
    res = r.codecs.resolution if r else ""
    video = r.codecs.video if r else ""
    q = quality_label(res, video)
    name = f"{q} · {provider_label(url)}"  # "HD · tvpass"
    out = dict(stream)
    out["name"] = name
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

    stats = {"files_changed": 0, "streams_before": 0, "streams_after": 0,
             "dropped_dead": 0, "relabeled_audio_to_video": 0, "renamed": 0}
    for f, streams in per_file.items():
        stats["streams_before"] += len(streams)
        before = json.dumps({"streams": streams}, separators=(",", ":"))  # snapshot pre-mutation
        kept = [dict(s) for s in streams if s["url"] in working]  # copy so we compare honestly
        stats["dropped_dead"] += len(streams) - len(kept)
        for s in kept:
            old = s.get("name", "")
            new = _relabel(s, res_by_url)
            if old == "Audio" and not new["name"].startswith("Audio"):
                stats["relabeled_audio_to_video"] += 1
            if new["name"] != old:
                stats["renamed"] += 1
            s.update(new)
        # sort tvpass-first, then uniquify the display names
        kept.sort(key=lambda s: provider_rank(s.get("url", "")))
        names = _uniquify([s["name"] for s in kept])
        for s, nm in zip(kept, names):
            s["name"] = nm
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
